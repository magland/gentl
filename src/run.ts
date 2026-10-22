// The agent loop: one model call per turn, one action per turn, everything recorded in ./runs/<id>/.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { Interrupted, ModelClient, type ModelConfig } from "./model.js";
import { evaluateRun, type Evaluation } from "./evaluate.js";
import { describeFinalState, type RepoState } from "./finalstate.js";
import { applyNotes, ASK_RESULT, describeAction, parseResponse, RESPONSE_SCHEMA, systemPrompt, validateAction,
  type Action } from "./protocol.js";
import { fence } from "./format.js";
import { ntok } from "./tokens.js";
import { DockerSandbox } from "./docker.js";
import { HostSandbox } from "./host.js";
import type { Sandbox } from "./sandbox.js";

export const FORMAT_VERSION = 1;

export interface RunOptions {
  task: string;
  taskName: string;
  taskSource: { kind: "file"; path: string } | { kind: "text" };
  model: ModelConfig;
  evaluatorModel: ModelConfig;
  sandbox: { kind: "host" } | { kind: "docker"; image: string };
  confirm: boolean; // ask before each action
  maxTurns: number;
  keep: boolean;
  runsDir: string; // where the run directory is created
  version: string;
}

export interface Summary {
  format: number;
  gentl_version: string;
  run_id: string;
  task_name: string;
  task_source: RunOptions["taskSource"];
  task: string;
  model: string;
  base_url: string;
  sandbox: "host" | "docker";
  image: string | null;
  image_id: string | null;
  confirm: boolean;
  structured_output: boolean;
  started: string;
  ended: string;
  duration_s: number;
  system_prompt: string;
  overhead_tokens: number;
  turns: number;
  read_tokens_total: number;
  notes_tokens_total: number;
  notes_tokens_max: number;
  result_tokens_total: number;
  result_tokens_max: number;
  model_output_tokens: number;
  provider_prompt_tokens: number;
  provider_completion_tokens: number;
  cost_usd: number;
  parse_errors: number;
  invalid_actions: number;
  repeated_actions: number;
  declined_actions: number;
  asks: { turn: number; question: string }[];
  stop_reason: "finish" | "max_turns" | "interrupted" | "error" | null;
  error: string | null;
  finished: boolean;
  self_reported_success: boolean | null;
  self_report_summary: string | null;
  self_report_friction: string | null;
  final_repos: RepoState[] | null;
  evaluation?: { model: string; success: boolean; reasons: string; cost_usd: number };
}

function formatAction(a: Action): string {
  switch (a.type) {
    case "run":
      return `### Action: run${a.max_chars !== undefined ? ` (max_chars ${a.max_chars})` : ""}\n${fence(String(a.cmd), "bash")}`;
    case "write_file":
      return `### Action: write_file \`${a.path}\`\n${fence(String(a.content))}`;
    case "edit_file":
      return `### Action: edit_file \`${a.path}\`\nold:\n${fence(String(a.old))}new:\n${fence(String(a.new))}`;
    case "ask":
      return `### Action: ask\n\n${a.question}\n`;
    case "finish":
      return `### Action: finish (success: ${a.success})\n\n${a.summary}\n${a.friction ? `\nFriction:\n\n${a.friction}\n` : ""}`;
    default:
      return `### Action (unrecognized)\n${fence(JSON.stringify(a, null, 2), "json")}`;
  }
}

function formatSummary(s: Summary): string {
  const outcome = s.finished ? `finished, self-reported ${s.self_reported_success ? "success" : "failure"}`
    : `did not finish (${s.stop_reason}${s.error ? `: ${s.error}` : ""})`;
  const rows: [string, string | number][] = [
    ["Outcome", outcome],
    ["Turns", s.turns],
    ["Read tokens total", s.read_tokens_total],
    ["Notes tokens (total / max)", `${s.notes_tokens_total} / ${s.notes_tokens_max}`],
    ["Result tokens (total / max)", `${s.result_tokens_total} / ${s.result_tokens_max}`],
    ["Overhead tokens (system prompt + task, once)", s.overhead_tokens],
    ["Model output tokens", s.model_output_tokens],
    ["Parse errors / invalid / repeated / declined actions",
      `${s.parse_errors} / ${s.invalid_actions} / ${s.repeated_actions} / ${s.declined_actions}`],
    ["Questions asked", s.asks.length],
    ["Cost", `$${s.cost_usd.toFixed(4)}`],
    ["Duration", `${Math.round(s.duration_s)} s`],
  ];
  return rows.map(([k, v]) => `- ${k}: ${v}`).join("\n") + "\n";
}

function firstLine(s: string, max: number): string {
  const line = s.split("\n")[0];
  const cut = line.length > max ? line.slice(0, max) : line;
  return cut === s ? cut : `${cut} …`;
}

function indent(text: string, maxLines: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, maxLines).map((l) => `       ${l}`);
  if (lines.length > maxLines) shown.push(`       (${lines.length - maxLines} more lines)`);
  return shown.join("\n");
}

let activePrompt: readline.Interface | null = null;

/** Ask a question on the terminal. Ctrl-C or Ctrl-D ends the run. */
function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  activePrompt = rl;
  return new Promise<string>((resolve, reject) => {
    let answered = false;
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      rl.close();
    });
    rl.on("close", () => {
      activePrompt = null;
      if (!answered) reject(new Interrupted());
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Show the action and ask for approval. Returns null if approved, else the reason given (possibly empty). */
async function confirm(a: Action, lineShown: string): Promise<string | null> {
  if (a.type === "run" && lineShown !== a.cmd) console.log(indent(String(a.cmd), 40));
  if (a.type === "write_file") console.log(indent(String(a.content), 30));
  if (a.type === "edit_file") console.log(`       old:\n${indent(String(a.old), 15)}\n       new:\n${indent(String(a.new), 15)}`);
  for (;;) {
    const ans = (await ask("     ok? [y/n] ")).toLowerCase();
    if (ans === "y" || ans === "yes") return null;
    if (ans === "n" || ans === "no") return await ask("     reason (optional): ");
  }
}

function actionLine(a: Action): string {
  switch (a.type) {
    case "run":
      return `run: ${firstLine(String(a.cmd), 90)}`;
    case "write_file":
    case "edit_file":
      return `${a.type}: ${a.path}`;
    case "ask":
      return `ask: ${firstLine(String(a.question), 90)}`;
    case "finish":
      return `finish: ${a.success ? "success" : "failure"}`;
    default:
      return firstLine(JSON.stringify(a), 90);
  }
}

export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface RunOutcome {
  runDir: string;
  summary: Summary;
}

export async function runTask(opts: RunOptions): Promise<RunOutcome> {
  const started = new Date();
  const runId = `${timestamp(started)}-${opts.taskName}`;
  const sb: Sandbox = opts.sandbox.kind === "docker"
    ? new DockerSandbox(`gentl-${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`, opts.sandbox.image)
    : new HostSandbox();
  const runDir = path.resolve(opts.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const events = fs.openSync(path.join(runDir, "events.jsonl"), "w");
  const transcript = fs.openSync(path.join(runDir, "transcript.md"), "w");
  const emit = (ev: Record<string, unknown>) => fs.writeSync(events, JSON.stringify(ev) + "\n");
  const tr = (text: string) => fs.writeSync(transcript, text + "\n");
  const log = (msg: string) => {
    console.log(`     ${msg}`);
    tr(`_${msg}_\n`);
  };

  const system = systemPrompt(sb.workdir, sb.kind === "docker" ? "linux" : process.platform);
  const client = new ModelClient(opts.model, { name: "turn", schema: RESPONSE_SCHEMA }, log);
  const s: Summary = {
    format: FORMAT_VERSION, gentl_version: opts.version, run_id: runId, task_name: opts.taskName,
    task_source: opts.taskSource, task: opts.task, model: opts.model.model, base_url: opts.model.baseUrl,
    sandbox: sb.kind, image: sb instanceof DockerSandbox ? sb.image : null,
    image_id: sb instanceof DockerSandbox ? sb.imageId : null, confirm: opts.confirm, structured_output: true, started: started.toISOString(), ended: "", duration_s: 0,
    system_prompt: system, overhead_tokens: ntok(system) + ntok(opts.task), turns: 0,
    read_tokens_total: 0, notes_tokens_total: 0, notes_tokens_max: 0, result_tokens_total: 0, result_tokens_max: 0,
    model_output_tokens: 0, provider_prompt_tokens: 0, provider_completion_tokens: 0, cost_usd: 0,
    parse_errors: 0, invalid_actions: 0, repeated_actions: 0, declined_actions: 0, asks: [],
    stop_reason: null, error: null, finished: false,
    self_reported_success: null, self_report_summary: null, self_report_friction: null, final_repos: null,
  };
  const source = opts.taskSource.kind === "file" ? opts.taskSource.path : "given on the command line";

  console.log(`gentl ${opts.version}  run ${runId}`);
  console.log(`model ${opts.model.model}  ${sb.describe()}${opts.confirm ? "  (confirm each action)" : ""}`);
  console.log(`\nturn  +read (cumulative)  notes  action`);
  tr(`# gentl run ${runId}\n\n- Model: ${opts.model.model}\n- Task: ${source}\n- Sandbox: ${sb.describe()}\n` +
    `- Started: ${started.toISOString()}\n\n## Task\n\n${opts.task}\n\n## System prompt\n\n${fence(system)}`);
  emit({ type: "start", run_id: runId, task: opts.task, task_source: opts.taskSource, model: opts.model.model,
    base_url: opts.model.baseUrl, sandbox: sb.kind, sandbox_description: sb.describe(), workdir: sb.workdir, confirm: opts.confirm, system_prompt: system });

  // Ctrl-C stops the running command, or cancels the model call and ends the run.
  // SIGTERM and SIGHUP end the run wherever it is; the run directory is still completed.
  let abortModel: AbortController | null = null;
  let stopRequested = false;
  const onSigint = () => {
    if (sb.interrupt()) return;
    if (abortModel) abortModel.abort();
  };
  const onTerm = () => {
    stopRequested = true;
    sb.interrupt();
    abortModel?.abort();
    activePrompt?.close();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);

  let notes = "";
  let last: { action: string; result: string } | null = null;
  let lastActionJson: string | null = null;
  try {
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      if (stopRequested) throw new Interrupted();
      let user = `# Task\n${opts.task}\n\n# Your notes\n${notes || "(empty)"}\n`;
      if (last) user += `\n# Last action\n${last.action}\n\n# Result\n${last.result}\n`;
      const notesTok = ntok(notes);
      const resultTok = last ? ntok(last.action) + ntok(last.result) : 0;
      s.turns = turn;
      s.notes_tokens_total += notesTok;
      s.notes_tokens_max = Math.max(s.notes_tokens_max, notesTok);
      s.result_tokens_total += resultTok;
      s.result_tokens_max = Math.max(s.result_tokens_max, resultTok);
      s.read_tokens_total = s.notes_tokens_total + s.result_tokens_total;
      tr(`---\n\n## Turn ${turn}\n\nRead this turn: notes ${notesTok} + result ${resultTok} tokens (cumulative ${s.read_tokens_total})\n`);

      const t0 = Date.now();
      abortModel = new AbortController();
      const reply = await client.call(system, user, abortModel.signal);
      abortModel = null;
      s.structured_output = client.structured;
      const modelSeconds = (Date.now() - t0) / 1000;
      const outTok = ntok(reply.text);
      s.model_output_tokens += outTok;
      s.provider_prompt_tokens += Number(reply.usage.prompt_tokens ?? 0);
      s.provider_completion_tokens += Number(reply.usage.completion_tokens ?? 0);
      s.cost_usd += Number(reply.usage.cost ?? 0);
      tr(`_model: ${modelSeconds.toFixed(1)} s, ${outTok} output tokens_\n`);
      const ev: Record<string, unknown> = { type: "turn", turn, input: user, response: reply.text, notes_tokens: notesTok,
        result_tokens: resultTok, model_seconds: modelSeconds, usage: reply.usage };
      const prefix = `t${String(turn).padStart(2, "0")}  +${resultTok + notesTok} (${s.read_tokens_total.toLocaleString("en-US")})`.padEnd(26) +
        String(notesTok).padEnd(7);

      let parsed;
      try {
        parsed = parseResponse(reply.text);
      } catch (e) {
        s.parse_errors++;
        const msg = (e as Error).message;
        console.log(`${prefix}parse error: ${msg}`);
        tr(`### Parse error: ${msg}\n\nRaw response:\n${fence(reply.text)}`);
        last = { action: "(none: your response could not be parsed)",
          result: `error: ${msg}. Respond with one JSON object as described.` };
        emit({ ...ev, parse_error: msg });
        continue;
      }

      const n = applyNotes(notes, parsed);
      notes = n.notes;
      const a = parsed.action;
      const line = actionLine(a);
      console.log(prefix + line);
      tr(`### Notes (${n.ops.length ? n.ops.join(", ") : "unchanged"}; ${ntok(notes)} tokens)\n\n${fence(notes || "(empty)")}`);
      for (const f of n.feedback) tr(`_${f}_\n`);
      tr(formatAction(a));
      Object.assign(ev, { parsed, notes, notes_ops: n.ops, notes_feedback: n.feedback });

      const invalid = validateAction(a);
      if (!invalid && a.type === "finish") {
        Object.assign(s, { finished: true, stop_reason: "finish", self_reported_success: a.success as boolean,
          self_report_summary: a.summary as string, self_report_friction: (a.friction as string) ?? null });
        emit(ev);
        break;
      }

      const notices: string[] = [];
      const actionJson = JSON.stringify(a);
      if (actionJson === lastActionJson) {
        s.repeated_actions++;
        notices.push("note: this action is identical to your previous one.");
      }
      lastActionJson = actionJson;

      let full: string;
      let shown: string;
      if (invalid) {
        s.invalid_actions++;
        full = shown = `error: malformed action: ${invalid}`;
      } else if (a.type === "ask") {
        s.asks.push({ turn, question: String(a.question) });
        full = shown = ASK_RESULT;
      } else {
        const reason = opts.confirm ? await confirm(a, line.replace(/^run: /, "")) : null;
        if (reason !== null) {
          s.declined_actions++;
          full = shown = `The person running gentl declined this action.${reason ? ` Their reason: ${reason}` : ""}`;
          ev.declined = reason;
        } else if (a.type === "run") {
          const r = await sb.run(String(a.cmd), a.max_chars as number | undefined);
          ({ full, shown } = r);
          Object.assign(ev, { truncation: r.truncation ?? undefined, exit_code: r.exitCode, signal: r.signal, cmd_seconds: r.seconds, timed_out: r.timedOut,
            interrupted: r.interrupted });
        } else if (a.type === "write_file") {
          full = shown = sb.writeFile(String(a.path), String(a.content));
        } else {
          full = shown = sb.editFile(String(a.path), String(a.old), String(a.new));
        }
      }
      shown = [...notices, ...n.feedback, shown].join("\n");
      last = { action: describeAction(a), result: shown };
      emit({ ...ev, notices, result_full: full, result_shown: shown });
      const truncNote = shown.length < full.length ? `; truncated, full result ${full.length} chars in events.jsonl` : "";
      tr(`### Result (${ntok(shown)} tokens${truncNote})\n${fence(shown)}`);
    }
    if (!s.stop_reason) s.stop_reason = "max_turns";
  } catch (e) {
    if (e instanceof Interrupted) s.stop_reason = "interrupted";
    else {
      s.stop_reason = "error";
      s.error = (e as Error).message;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onTerm);
    const ended = new Date();
    s.ended = ended.toISOString();
    s.duration_s = (ended.getTime() - started.getTime()) / 1000;
    try {
      const fin = describeFinalState(sb);
      fs.writeFileSync(path.join(runDir, "final-state.md"), fin.text);
      s.final_repos = fin.repos;
    } catch (e) {
      log(`could not record the final state: ${(e as Error).message}`);
    }
    fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(s, null, 2) + "\n");
    emit({ type: "end", stop_reason: s.stop_reason, error: s.error });
    tr(`---\n\n## Summary\n\n${formatSummary(s)}`);
    fs.closeSync(events);
    fs.closeSync(transcript);
    if (!opts.keep) sb.remove();
    else if (sb instanceof DockerSandbox) console.log(`\ncontainer kept: ${sb.name} (remove with: docker rm -f ${sb.name})`);
    else if (sb instanceof HostSandbox) console.log(`\nworkspace kept: ${sb.root}`);
  }
  console.log(`\n${formatSummary(s)}`);
  if (s.self_report_summary) console.log(`Agent's summary: ${s.self_report_summary}\n`);
  if (s.self_report_friction) console.log(`Agent's friction report: ${s.self_report_friction}\n`);
  if (s.stop_reason === "finish" || s.stop_reason === "max_turns") {
    const ev = await evaluate(runDir, opts.evaluatorModel);
    if (ev) s.evaluation = { model: ev.model, success: ev.success, reasons: ev.reasons, cost_usd: ev.cost_usd };
  }
  console.log(`Run directory: ${runDir}`);
  return { runDir, summary: s };
}

/** Run the evaluator on a run directory and print its verdict and friction report. Ctrl-C skips it. */
export async function evaluate(runDir: string, cfg: ModelConfig): Promise<Evaluation | null> {
  console.log(`Evaluating with ${cfg.model} ...`);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);
  try {
    const ev = await evaluateRun(runDir, cfg, ac.signal, (msg) => console.log(`     ${msg}`));
    console.log(`\nVerdict: ${ev.success ? "success" : "failure"}\n\n${ev.reasons}\n\nFriction report:\n\n${ev.friction_report}\n`);
    console.log(`Evaluator cost: $${ev.cost_usd.toFixed(4)}; written to friction.md, evaluation.json and summary.json`);
    return ev;
  } catch (e) {
    const msg = e instanceof Interrupted ? "interrupted" : (e as Error).message;
    console.log(`Evaluation skipped (${msg}). Run it later with: gentl evaluate ${path.relative(process.cwd(), runDir)}`);
    return null;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
