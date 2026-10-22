// Batches: a suite (a directory of task files) and/or repeated runs (--repeat N). Runs go one after another into
// runs/<timestamp>-<name>/, and a results table is printed and written there.

import * as fs from "node:fs";
import * as path from "node:path";
import { runTask, timestamp, type RunOptions, type Summary } from "./run.js";

export interface BatchTask {
  taskName: string;
  task: string;
  taskSource: RunOptions["taskSource"];
}

interface Row {
  task: string;
  rep: number; // 1-based repetition
  run_dir: string | null; // relative to the batch directory
  stop_reason: string;
  verdict: boolean | null;
  self_reported_success: boolean | null;
  turns: number | null;
  read_tokens_total: number | null;
  notes_tokens_max: number | null;
  asks: number | null;
  cost_usd: number | null; // agent plus evaluator
}

interface Aggregate {
  task: string;
  runs: number; // runs that ended (not skipped or errored)
  successes: number; // judged successful by the evaluator
  read_tokens: Stats | null; // over successful runs
  turns: Stats | null;
  notes_tokens_max: Stats | null;
  cost_usd: number;
}

interface Stats {
  median: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
}

/** Task files in a suite directory: *.md, except README.md and files starting with "_". */
export function suiteTasks(dir: string): BatchTask[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md" && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      return { taskName: path.basename(f, ".md"), task: fs.readFileSync(file, "utf8").trim(), taskSource: { kind: "file", path: file } };
    });
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values: number[]): Stats | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return { median: quantile(s, 0.5), q1: quantile(s, 0.25), q3: quantile(s, 0.75), min: s[0], max: s[s.length - 1] };
}

function aggregate(task: string, rows: Row[]): Aggregate {
  const ended = rows.filter((r) => r.run_dir !== null);
  const ok = ended.filter((r) => r.verdict === true);
  return {
    task, runs: ended.length, successes: ok.length,
    read_tokens: stats(ok.map((r) => r.read_tokens_total!)), turns: stats(ok.map((r) => r.turns!)),
    notes_tokens_max: stats(ok.map((r) => r.notes_tokens_max!)),
    cost_usd: ended.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
  };
}

function rowFor(task: string, rep: number, batchDir: string, runDir: string, s: Summary): Row {
  return {
    task, rep, run_dir: path.relative(batchDir, runDir), stop_reason: s.stop_reason ?? "unknown",
    verdict: s.evaluation?.success ?? null, self_reported_success: s.self_reported_success, turns: s.turns,
    read_tokens_total: s.read_tokens_total, notes_tokens_max: s.notes_tokens_max, asks: s.asks.length,
    cost_usd: s.cost_usd + (s.evaluation?.cost_usd ?? 0),
  };
}

function emptyRow(task: string, rep: number, stop: string): Row {
  return { task, rep, run_dir: null, stop_reason: stop, verdict: null, self_reported_success: null, turns: null,
    read_tokens_total: null, notes_tokens_max: null, asks: null, cost_usd: null };
}

function table(header: string[], body: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n") + "\n";
}

const num = (v: number | null) => (v === null ? "-" : Math.round(v).toLocaleString("en-US"));
const cost = (v: number | null) => (v === null ? "-" : `$${v.toFixed(4)}`);

function runsTable(rows: Row[], repeat: number): string {
  const yn = (v: boolean | null) => (v === null ? "-" : v ? "yes" : "no");
  return table(["task", ...(repeat > 1 ? ["rep"] : []), "verdict", "self-report", "stop", "turns", "read tokens", "notes max", "asks", "cost"],
    rows.map((r) => [r.task, ...(repeat > 1 ? [String(r.rep)] : []), r.verdict === null ? "-" : r.verdict ? "success" : "failure",
      yn(r.self_reported_success), r.stop_reason, num(r.turns), num(r.read_tokens_total), num(r.notes_tokens_max),
      num(r.asks), cost(r.cost_usd)]));
}

function aggregateTable(aggs: Aggregate[]): string {
  const range = (s: Stats | null) => (s ? `${num(s.min)}-${num(s.max)}` : "-");
  const iqr = (s: Stats | null) => (s ? `${num(s.q1)}-${num(s.q3)}` : "-");
  return table(["task", "success", "read median", "read IQR", "read range", "turns median", "notes max median", "cost"],
    aggs.map((a) => [a.task, `${a.successes}/${a.runs}`, num(a.read_tokens?.median ?? null), iqr(a.read_tokens),
      range(a.read_tokens), num(a.turns?.median ?? null), num(a.notes_tokens_max?.median ?? null), cost(a.cost_usd)]));
}

/** Run each task `repeat` times. Returns false if any run failed with an error. */
export async function runBatch(name: string, tasks: BatchTask[], repeat: number,
  base: Omit<RunOptions, "task" | "taskName" | "taskSource" | "runsDir">): Promise<boolean> {
  if (!tasks.length) throw new Error("no tasks to run");
  const started = new Date();
  const batchDir = path.resolve("runs", `${timestamp(started)}-${name}`);
  fs.mkdirSync(batchDir, { recursive: true });
  const total = tasks.length * repeat;
  console.log(`${name}: ${tasks.length} task(s) x ${repeat}, runs in ${batchDir}`);

  const rows: Row[] = [];
  let stopped = false;
  let i = 0;
  for (const t of tasks) {
    for (let rep = 1; rep <= repeat; rep++) {
      i++;
      if (stopped) {
        rows.push(emptyRow(t.taskName, rep, "skipped"));
        continue;
      }
      const label = repeat > 1 ? `${t.taskName} (run ${rep}/${repeat})` : t.taskName;
      console.log(`\n=== ${i}/${total}: ${label} ===\n`);
      try {
        const out = await runTask({ ...base, task: t.task, taskName: repeat > 1 ? `${t.taskName}-r${rep}` : t.taskName,
          taskSource: t.taskSource, runsDir: batchDir });
        rows.push(rowFor(t.taskName, rep, batchDir, out.runDir, out.summary));
        if (out.summary.stop_reason === "interrupted") {
          console.log("\nRun interrupted; skipping the remaining runs.");
          stopped = true;
        }
      } catch (e) {
        console.log(`error: ${(e as Error).message}`);
        rows.push(emptyRow(t.taskName, rep, "error"));
      }
    }
  }

  const aggs = tasks.map((t) => aggregate(t.taskName, rows.filter((r) => r.task === t.taskName)));
  let report = runsTable(rows, repeat);
  if (repeat > 1) report = `Per task (read tokens, turns and notes over runs the evaluator judged successful):\n\n${aggregateTable(aggs)}\nAll runs:\n\n${report}`;
  fs.writeFileSync(path.join(batchDir, "results.md"), `# ${name}\n\nStarted ${started.toISOString()}; ${tasks.length} task(s), ${repeat} run(s) each.\n\n${report}`);
  fs.writeFileSync(path.join(batchDir, "results.json"), JSON.stringify({ format: 1, name, repeat, started: started.toISOString(),
    ended: new Date().toISOString(), tasks: aggs, runs: rows }, null, 2) + "\n");
  console.log(`\n=== ${name} ===\n\n${report}\nBatch directory: ${batchDir}`);
  return rows.every((r) => r.stop_reason !== "error");
}
