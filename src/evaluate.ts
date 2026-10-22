// The evaluator: one model call that reads a run directory and writes a verdict and a friction report.
// It depends only on the run directory, so a run can be re-evaluated later (`gentl evaluate`).

import * as fs from "node:fs";
import * as path from "node:path";
import { clip, fence } from "./format.js";
import { createModelClient, type ModelConfig } from "./model.js";
import { parseFirstJson } from "./protocol.js";

const RESULT_HIDDEN_CAP = 6000; // chars of the part of a result the agent did not see
const RESULT_CAP = 12000; // chars of any single result
const LOG_CAP = 500000; // chars of the whole log; beyond this, results are clipped harder

export const EVALUATOR_PROMPT = `You evaluate one run of gentl, a readability test for codebases. An agent was given a task as a newcomer to some software (typically: clone a repo, set it up from its docs, make a change, verify it). The agent had no memory between turns except short notes it kept, and it saw only its last action's result each turn, often truncated. Its success is self-reported, so you judge it.

You receive the task, the log of every turn (notes, action, result; parts of results the agent did not see are marked), the questions the agent asked (no one answered them), the agent's finish report, and the final state of the workspace (git status and diff of each repo, and other files).

Write two things.

1. A verdict: did the agent actually accomplish the task? Judge from the evidence in the log and the final state, not from the agent's claims. Every part of the task must be done, and verified where the task implies it (for example, tests actually ran and passed). Give short reasons that cite turn numbers.

2. A friction report for the maintainers of the software, in markdown, with these sections:
- Docs used: which docs, files or pages the agent relied on, and for what (cite turns).
- Missing or wrong: what the agent needed but could not find in the docs, or found wrong or outdated. Be specific: which file or section, and what it should say.
- Guesses: where the agent went ahead without support from the docs (inferred from config, CI files or code, or trial and error).
- Prior knowledge: commands, APIs, flags or facts the agent used that never appeared in any result it saw before that point, so they came from its training and the docs were not tested there.
- Questions: each question the agent asked, and whether the docs answer it.
Keep it short and concrete, as bullets; write "none" for an empty section. Separate problems in the software's docs from problems caused by the agent's own mistakes or by the test environment (for example a missing system package), and say which is which.

Respond with one JSON object: {"success": true|false, "reasons": "...", "friction_report": "..."}`;

const EVAL_SCHEMA = {
  name: "evaluation",
  schema: {
    type: "object",
    properties: { success: { type: "boolean" }, reasons: { type: "string" }, friction_report: { type: "string" } },
    required: ["success", "reasons", "friction_report"],
    additionalProperties: false,
  },
};

export interface Evaluation {
  model: string;
  success: boolean;
  reasons: string;
  friction_report: string;
  structured_output: boolean;
  usage: Record<string, unknown>;
  cost_usd: number;
  input_chars: number;
  created: string;
}

/** A result as the evaluator sees it: the full result, with the part the agent did not see marked. */
function resultForEvaluator(ev: any, cap: number): string {
  const full: string = ev.result_full ?? "";
  const notices = (ev.notices ?? []).map((n: string) => `${n}\n`).join("");
  const t = ev.truncation as { head: number; tail: number } | undefined;
  if (!t) return notices + clip(full, cap);
  const hidden = full.slice(t.head, full.length - t.tail);
  return notices + full.slice(0, t.head) +
    `\n[--- the agent did not see the next ${hidden.length} chars ---]\n${clip(hidden, Math.min(RESULT_HIDDEN_CAP, cap))}\n[--- end of the part the agent did not see ---]\n` +
    full.slice(full.length - t.tail);
}

function formatActionForEvaluator(a: any): string {
  if (!a || typeof a !== "object") return "(none)";
  switch (a.type) {
    case "run":
      return `run:\n${fence(String(a.cmd), "bash")}`;
    case "write_file":
      return `write_file ${a.path}:\n${fence(clip(String(a.content), RESULT_CAP))}`;
    case "edit_file":
      return `edit_file ${a.path}\nold:\n${fence(String(a.old))}new:\n${fence(String(a.new))}`;
    case "ask":
      return `ask: ${a.question}`;
    default:
      return fence(JSON.stringify(a, null, 2), "json");
  }
}

export function buildEvaluatorInput(runDir: string): string {
  const summary = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
  const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const finalPath = path.join(runDir, "final-state.md");
  const finalState = fs.existsSync(finalPath) ? fs.readFileSync(finalPath, "utf8") : "(not recorded)";
  const turns = events.filter((e) => e.type === "turn");

  const build = (cap: number) => {
    let log = "";
    for (const ev of turns) {
      log += `## Turn ${ev.turn}\n\n`;
      if (ev.parse_error) {
        log += `The response could not be parsed (${ev.parse_error}).\n\n`;
        continue;
      }
      log += `Notes after this turn:\n${fence(ev.notes || "(empty)")}\nAction: ${formatActionForEvaluator(ev.parsed?.action)}\n`;
      if (ev.declined !== undefined) log += `\nThe person running gentl declined this action${ev.declined ? `: ${ev.declined}` : ""}.\n`;
      if (ev.result_full !== undefined) log += `\nResult:\n${fence(resultForEvaluator(ev, cap))}`;
      log += "\n";
    }
    return log;
  };
  let log = build(RESULT_CAP);
  if (log.length > LOG_CAP) log = build(2000);

  const asks = (summary.asks ?? []) as { turn: number; question: string }[];
  const finish = summary.finished
    ? `success: ${summary.self_reported_success}\nsummary: ${summary.self_report_summary}\nfriction: ${summary.self_report_friction ?? "(none given)"}`
    : `The agent did not finish (stop reason: ${summary.stop_reason}).`;
  const lc = summary.local_copy
    ? ` Clones of ${summary.local_copy.origin} were served from the maintainer's local working copy (with any uncommitted changes), so the agent's clone may differ from the published repo and its origin URL is a local file:// path; this is intended, not a problem with the run.`
    : "";
  return `# Task\n\n${summary.task}\n\n# Run\n\nModel ${summary.model}, sandbox ${summary.sandbox}, ${summary.turns} turns, stop reason ${summary.stop_reason}.${lc}\n\n` +
    `# Log\n\n${log}\n# Questions the agent asked\n\n${asks.length ? asks.map((a) => `- turn ${a.turn}: ${a.question}`).join("\n") : "none"}\n\n` +
    `# The agent's finish report\n\n${finish}\n\n# Final state of the workspace\n\n${finalState}\n`;
}

/** Evaluate a run directory and write evaluation.json and friction.md; also records the verdict in summary.json. */
export async function evaluateRun(runDir: string, cfg: ModelConfig, signal: AbortSignal,
  log: (msg: string) => void): Promise<Evaluation> {
  const input = buildEvaluatorInput(runDir);
  const client = createModelClient(cfg, EVAL_SCHEMA, log);
  const reply = await client.call(EVALUATOR_PROMPT, input, signal);
  let parsed: any;
  try {
    parsed = parseFirstJson(reply.text, (v) => typeof v.success === "boolean");
  } catch {
    throw new Error(`could not parse the evaluator's response: ${reply.text.slice(0, 300)}`);
  }
  const ev: Evaluation = {
    model: cfg.model, success: parsed.success, reasons: String(parsed.reasons ?? ""),
    friction_report: String(parsed.friction_report ?? ""), structured_output: client.structured,
    usage: reply.usage, cost_usd: Number(reply.usage.cost ?? 0), input_chars: input.length, created: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, "evaluation.json"), JSON.stringify(ev, null, 2) + "\n");
  fs.writeFileSync(path.join(runDir, "friction.md"),
    `# Evaluation\n\nVerdict: ${ev.success ? "success" : "failure"} (evaluator ${ev.model})\n\n${ev.reasons}\n\n# Friction report\n\n${ev.friction_report}\n`);
  const summaryPath = path.join(runDir, "summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  summary.evaluation = { model: ev.model, success: ev.success, reasons: ev.reasons, cost_usd: ev.cost_usd };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  return ev;
}
