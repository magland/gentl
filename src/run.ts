// The agent loop: one model call per turn, one action per turn, everything recorded in ./runs/<id>/.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createModelClient, Interrupted, type ModelConfig } from "./model.js";
import { evaluateRun, type Evaluation } from "./evaluate.js";
import { describeFinalState, type RepoState } from "./finalstate.js";
import { uploadRun, type HubCredentials } from "./hub.js";
import { configureLocalCopy, describeLocalCopy, localCopyInfo, prefixCollisions, type LocalCopy } from "./localcopy.js";
import { applyNotes, ASK_RESULT, describeAction, hasNotesDecision, NOTES_REMINDER, parseResponse, RESPONSE_SCHEMA, systemPrompt, validateAction,
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
  taskSource: { kind: "file"; path: string } | { kind: "text" }
    | { kind: "hub"; url: string; hub: string; id: number; title: string };
  upload: HubCredentials | null; // upload the run to its task's hub when it ends
  model: ModelConfig;
  evaluatorModel: ModelConfig;
  sandbox: { kind: "host"; shareHome: string[]; passEnv: string[] } | { kind: "docker"; image: string };
  confirm: boolean; // ask before each action
  localCopy: LocalCopy | null; // serve clones of this repo from the local checkout
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
  backend: ModelConfig["backend"];
  base_url: string | null;
  sandbox: "host" | "docker";
  image: string | null;
  image_id: string | null;
  confirm: boolean;
  host_share_home: string[];
  host_pass_env: string[];
  local_copy: ReturnType<typeof localCopyInfo> | null;
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
  notes_reminders: number;
  asks: { turn: number; question: string }[];
  // aborted: the person running gentl pressed Ctrl-C (evaluated as a failure, and uploaded);
  // interrupted: SIGTERM or SIGHUP (not evaluated or uploaded).
  stop_reason: "finish" | "max_turns" | "aborted" | "interrupted" | "error" | null;
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
    case "read_file":
      return `### Action: read_file \`${a.path}\`${a.start_line !== undefined || a.end_line !== undefined ? ` lines ${a.start_line ?? 1}-${a.end_line ?? "end"}` : ""}\n`;
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
    ["Notes reminders (responses without a notes decision)", s.notes_reminders],
    ["Cost", `$${s.cost_usd.toFixed(4)}${s.backend === "claude-code" ? " (notional; Claude Code subscription)" : ""}`],
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
    case "read_file":
      return `read_file: ${a.path}${a.start_line !== undefined || a.end_line !== undefined ? ` ${a.start_line ?? 1}-${a.end_line ?? "end"}` : ""}`;
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
  const lc = opts.localCopy;
  const MIRROR_MOUNT = "/srv/git";
  const sb: Sandbox = opts.sandbox.kind === "docker"
    // The random suffix keeps names unique when two gentl processes start the same task in the same second.
    ? new DockerSandbox(`gentl-${runId.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}-${randomBytes(3).toString("hex")}`, opts.sandbox.image,
      lc ? [{ host: lc.mirrorDir, container: MIRROR_MOUNT }] : [])
    : new HostSandbox({ shareHome: opts.sandbox.shareHome, passEnv: opts.sandbox.passEnv });
  // Signal handlers go in as soon as the sandbox exists, so no signal can leave it behind.
  // Ctrl-C aborts the run wherever it is (a running command is killed, a model call cancelled); the run is
  // then evaluated as a failure and, with --upload, reported. SIGTERM and SIGHUP end it without either.
  // The run directory is completed in every case. During cleanup further signals are ignored, so a
  // second Ctrl-C cannot leave the sandbox behind.
  let abortModel: AbortController | null = null;
  let abortRequested = false; // Ctrl-C
  let stopRequested = false; // SIGTERM, SIGHUP
  let cleaningUp = false;
  const onSigint = () => {
    if (cleaningUp) return console.log("     still cleaning up (removing the sandbox); please wait");
    if (!abortRequested) console.log("\n     aborting the run (Ctrl-C); it will be evaluated as a failure and, with --upload, reported");
    abortRequested = true;
    sb.interrupt();
    abortModel?.abort();
  };
  const onTerm = () => {
    if (cleaningUp) return;
    stopRequested = true;
    sb.interrupt();
    abortModel?.abort();
    activePrompt?.close();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);

  const localCopyError = lc
    ? configureLocalCopy(sb, lc, sb.kind === "docker" ? `${MIRROR_MOUNT}/${lc.mirrorName}` : path.join(lc.mirrorDir, lc.mirrorName))
    : null;
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
  const client = createModelClient(opts.model, { name: "turn", schema: RESPONSE_SCHEMA }, log,
    sb.kind === "host" ? sb.workdir : undefined);
  const s: Summary = {
    format: FORMAT_VERSION, gentl_version: opts.version, run_id: runId, task_name: opts.taskName,
    task_source: opts.taskSource, task: opts.task, model: opts.model.model, backend: opts.model.backend,
    base_url: opts.model.backend === "openrouter" ? opts.model.baseUrl : null,
    sandbox: sb.kind, image: sb instanceof DockerSandbox ? sb.image : null,
    image_id: sb instanceof DockerSandbox ? sb.imageId : null, confirm: opts.confirm,
    host_share_home: opts.sandbox.kind === "host" ? opts.sandbox.shareHome : [],
    host_pass_env: opts.sandbox.kind === "host" ? opts.sandbox.passEnv : [],
    local_copy: lc && !localCopyError ? localCopyInfo(lc) : null, structured_output: true, started: started.toISOString(), ended: "", duration_s: 0,
    system_prompt: system, overhead_tokens: ntok(system) + ntok(opts.task), turns: 0,
    read_tokens_total: 0, notes_tokens_total: 0, notes_tokens_max: 0, result_tokens_total: 0, result_tokens_max: 0,
    model_output_tokens: 0, provider_prompt_tokens: 0, provider_completion_tokens: 0, cost_usd: 0,
    parse_errors: 0, invalid_actions: 0, repeated_actions: 0, declined_actions: 0, notes_reminders: 0, asks: [],
    stop_reason: null, error: null, finished: false,
    self_reported_success: null, self_report_summary: null, self_report_friction: null, final_repos: null,
  };
  const ts = opts.taskSource;
  const source = ts.kind === "file" ? ts.path : ts.kind === "hub" ? `${ts.title} (${ts.url})` : "given on the command line";

  console.log(`gentl ${opts.version}  run ${runId}`);
  console.log(`model ${opts.model.model} (${opts.model.backend})  ${sb.describe()}${opts.confirm ? "  (confirm each action)" : ""}`);
  if (lc && !localCopyError) {
    console.log(`local copy: ${describeLocalCopy(lc)}`);
    for (const u of prefixCollisions(opts.task, lc.urls)) {
      console.log(`warning: the task mentions ${u}, which the local copy would also redirect (git insteadOf matches by prefix); use --remote if that is wrong`);
    }
  }
  if (localCopyError) console.log(`warning: local copy disabled: ${localCopyError}`);
  console.log(`\nturn  +read (cumulative)  notes  action`);
  tr(`# gentl run ${runId}\n\n- Model: ${opts.model.model} (${opts.model.backend})\n- Task: ${source}\n- Sandbox: ${sb.describe()}\n- Local copy: ${lc && !localCopyError ? describeLocalCopy(lc) : "none"}\n` +
    `- Started: ${started.toISOString()}\n\n## Task\n\n${opts.task}\n\n## System prompt\n\n${fence(system)}`);
  emit({ type: "start", run_id: runId, task: opts.task, task_source: opts.taskSource, model: opts.model.model,
    backend: opts.model.backend, base_url: s.base_url, sandbox: sb.kind, sandbox_description: sb.describe(), workdir: sb.workdir, confirm: opts.confirm, system_prompt: system });


  let notes = "";
  let last: { action: string; result: string } | null = null;
  const seen = new Map<string, number[]>(); // action key -> turns it was taken
  try {
    for (let turn = 1; turn <= opts.maxTurns; turn++) {
      if (stopRequested || abortRequested) throw new Interrupted();
      let user = `# Task\n${opts.task}\n\n# Your notes\n${notes || "(empty)"}\n`;
      if (last) user += `\n# Last action\n${last.action}\n\n# Result\n${last.result}\n`;
      const notesTok = ntok(notes);
      let resultTok = last ? ntok(last.action) + ntok(last.result) : 0;
      s.turns = turn;
      s.notes_tokens_total += notesTok;
      s.notes_tokens_max = Math.max(s.notes_tokens_max, notesTok);
      s.result_tokens_total += resultTok;
      s.result_tokens_max = Math.max(s.result_tokens_max, resultTok);
      s.read_tokens_total = s.notes_tokens_total + s.result_tokens_total;
      tr(`---\n\n## Turn ${turn}\n\nRead this turn: notes ${notesTok} + result ${resultTok} tokens (cumulative ${s.read_tokens_total})\n`);

      const callModel = async (input: string) => {
        const t0 = Date.now();
        abortModel = new AbortController();
        const reply = await client.call(system, input, abortModel.signal);
        abortModel = null;
        s.structured_output = client.structured;
        const outTok = ntok(reply.text);
        s.model_output_tokens += outTok;
        s.provider_prompt_tokens += Number(reply.usage.prompt_tokens ?? 0);
        s.provider_completion_tokens += Number(reply.usage.completion_tokens ?? 0);
        s.cost_usd += Number(reply.usage.cost ?? 0);
        const seconds = (Date.now() - t0) / 1000;
        tr(`_model: ${seconds.toFixed(1)} s, ${outTok} output tokens_\n`);
        return { reply, seconds };
      };
      const tryParse = (text: string) => {
        try {
          return { parsed: parseResponse(text), error: null };
        } catch (e) {
          return { parsed: null, error: (e as Error).message };
        }
      };

      let { reply, seconds: modelSeconds } = await callModel(user);
      let { parsed, error: parseError } = tryParse(reply.text);
      const ev: Record<string, unknown> = { type: "turn", turn, input: user, notes_tokens: notesTok, usage: reply.usage };
      // No notes decision: ask again within the turn, while the result is still in view. The reminder counts as read.
      if (parsed && !hasNotesDecision(parsed)) {
        s.notes_reminders++;
        const reminderTok = ntok(NOTES_REMINDER);
        resultTok += reminderTok;
        s.result_tokens_total += reminderTok;
        s.result_tokens_max = Math.max(s.result_tokens_max, resultTok);
        s.read_tokens_total = s.notes_tokens_total + s.result_tokens_total;
        tr(`### No notes decision; reminder sent (${reminderTok} tokens)\n\nFirst response:\n${fence(reply.text)}`);
        Object.assign(ev, { response_without_notes: reply.text, usage_without_notes: reply.usage });
        const retryInput = `${user}\n# Reminder\n${NOTES_REMINDER}\n`;
        ({ reply, seconds: modelSeconds } = await callModel(retryInput));
        ({ parsed, error: parseError } = tryParse(reply.text));
        Object.assign(ev, { input: retryInput, usage: reply.usage, notes_reminder: true });
      }
      Object.assign(ev, { response: reply.text, result_tokens: resultTok, model_seconds: modelSeconds });
      const prefix = `t${String(turn).padStart(2, "0")}  +${resultTok + notesTok} (${s.read_tokens_total.toLocaleString("en-US")})`.padEnd(26) +
        String(notesTok).padEnd(7) + (ev.notes_reminder ? "[reminded] " : "");

      if (!parsed) {
        s.parse_errors++;
        const msg = parseError!;
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
      tr(`### Notes (${n.ops.length ? n.ops.join(", ") : parsed.notes_keep === true ? "kept" : "unchanged"}; ${ntok(notes)} tokens)\n\n${fence(notes || "(empty)")}`);
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

      // An action the agent already took, at any earlier turn, is pointed out: rereading the same thing in a
      // cycle is the commonest way a memoryless agent gets stuck.
      const notices: string[] = [];
      const key = a.type === "run" ? `run ${String(a.cmd).replace(/\s+/g, " ").trim()}` : JSON.stringify(a);
      const earlier = seen.get(key) ?? [];
      if (earlier.length) {
        s.repeated_actions++;
        notices.push(`note: you already ran this exact ${a.type === "run" ? "command" : "action"} at turn${earlier.length > 1 ? "s" : ""} ${earlier.join(", ")}. If you are rereading, act on what your notes hold, or record what you need from it this time.`);
      }
      seen.set(key, [...earlier, turn]);

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
          if (r.sandboxError) throw new Error(`the sandbox failed: ${r.sandboxError.trim()}`);
          ({ full, shown } = r);
          Object.assign(ev, { truncation: r.truncation ?? undefined, exit_code: r.exitCode, signal: r.signal, cmd_seconds: r.seconds, timed_out: r.timedOut,
            interrupted: r.interrupted });
        } else if (a.type === "read_file") {
          full = shown = sb.readFile(String(a.path), a.start_line as number | undefined, a.end_line as number | undefined);
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
    // Ctrl-C at a confirmation prompt arrives as Interrupted without a signal, so anything not SIGTERM or
    // SIGHUP counts as the person's abort.
    if (e instanceof Interrupted) s.stop_reason = stopRequested ? "interrupted" : "aborted";
    else {
      s.stop_reason = "error";
      s.error = (e as Error).message;
    }
  } finally {
    cleaningUp = true;
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
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onTerm);
  }
  console.log(`\n${formatSummary(s)}`);
  if (s.self_report_summary) console.log(`Agent's summary: ${s.self_report_summary}\n`);
  if (s.self_report_friction) console.log(`Agent's friction report: ${s.self_report_friction}\n`);
  const evaluable = s.stop_reason === "finish" || s.stop_reason === "max_turns" || s.stop_reason === "aborted";
  if (evaluable) {
    const ev = await evaluate(runDir, opts.evaluatorModel);
    if (ev) s.evaluation = { model: ev.model, success: ev.success, reasons: ev.reasons, cost_usd: ev.cost_usd };
  }
  console.log(`Run directory: ${runDir}`);
  if (opts.upload) {
    if (evaluable) {
      try {
        console.log(`Uploaded: ${await uploadRun(runDir, opts.upload)}`);
      } catch (e) {
        console.log(`Upload failed (${(e as Error).message}). Retry with: gentl upload ${path.relative(process.cwd(), runDir)}`);
      }
    } else console.log(`Not uploaded: the run did not finish (${s.stop_reason}).`);
  }
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
