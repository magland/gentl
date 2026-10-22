// A suite is a directory of task files (*.md), run one after another into runs/<timestamp>-<suite>/.

import * as fs from "node:fs";
import * as path from "node:path";
import { runTask, timestamp, type RunOptions, type Summary } from "./run.js";

interface Row {
  task: string;
  run_dir: string | null; // relative to the suite directory
  stop_reason: string;
  verdict: boolean | null;
  self_reported_success: boolean | null;
  turns: number | null;
  read_tokens_total: number | null;
  notes_tokens_max: number | null;
  asks: number | null;
  cost_usd: number | null; // agent plus evaluator
}

/** Task files in a suite directory: *.md, except README.md and files starting with "_". */
export function suiteTasks(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md" && !f.startsWith("_"))
    .sort()
    .map((f) => path.join(dir, f));
}

function rowFor(task: string, suiteDir: string, runDir: string, s: Summary): Row {
  return {
    task, run_dir: path.relative(suiteDir, runDir), stop_reason: s.stop_reason ?? "unknown",
    verdict: s.evaluation?.success ?? null, self_reported_success: s.self_reported_success, turns: s.turns,
    read_tokens_total: s.read_tokens_total, notes_tokens_max: s.notes_tokens_max, asks: s.asks.length,
    cost_usd: s.cost_usd + (s.evaluation?.cost_usd ?? 0),
  };
}

function table(rows: Row[]): string {
  const yn = (v: boolean | null) => (v === null ? "-" : v ? "yes" : "no");
  const num = (v: number | null) => (v === null ? "-" : v.toLocaleString("en-US"));
  const header = ["task", "verdict", "self-report", "stop", "turns", "read tokens", "notes max", "asks", "cost"];
  const body = rows.map((r) => [r.task, r.verdict === null ? "-" : r.verdict ? "success" : "failure",
    yn(r.self_reported_success), r.stop_reason, num(r.turns), num(r.read_tokens_total), num(r.notes_tokens_max),
    num(r.asks), r.cost_usd === null ? "-" : `$${r.cost_usd.toFixed(4)}`]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n") + "\n";
}

export async function runSuite(dir: string, base: Omit<RunOptions, "task" | "taskName" | "taskSource" | "runsDir">): Promise<boolean> {
  const tasks = suiteTasks(dir);
  if (!tasks.length) throw new Error(`no task files (*.md) in ${dir}`);
  const name = path.basename(path.resolve(dir));
  const started = new Date();
  const suiteDir = path.resolve("runs", `${timestamp(started)}-${name}`);
  fs.mkdirSync(suiteDir, { recursive: true });
  console.log(`suite ${name}: ${tasks.length} tasks, runs in ${suiteDir}`);

  const rows: Row[] = [];
  let stopped = false;
  for (const [i, file] of tasks.entries()) {
    const taskName = path.basename(file, ".md");
    if (stopped) {
      rows.push({ task: taskName, run_dir: null, stop_reason: "skipped", verdict: null, self_reported_success: null,
        turns: null, read_tokens_total: null, notes_tokens_max: null, asks: null, cost_usd: null });
      continue;
    }
    console.log(`\n=== task ${i + 1}/${tasks.length}: ${taskName} ===\n`);
    try {
      const task = fs.readFileSync(file, "utf8").trim();
      const out = await runTask({ ...base, task, taskName, taskSource: { kind: "file", path: file }, runsDir: suiteDir });
      rows.push(rowFor(taskName, suiteDir, out.runDir, out.summary));
      if (out.summary.stop_reason === "interrupted") {
        console.log("\nRun interrupted; skipping the remaining tasks.");
        stopped = true;
      }
    } catch (e) {
      console.log(`error: ${(e as Error).message}`);
      rows.push({ task: taskName, run_dir: null, stop_reason: "error", verdict: null, self_reported_success: null,
        turns: null, read_tokens_total: null, notes_tokens_max: null, asks: null, cost_usd: null });
    }
  }

  const t = table(rows);
  fs.writeFileSync(path.join(suiteDir, "results.md"), `# Suite ${name}\n\nStarted ${started.toISOString()}, tasks from ${path.resolve(dir)}.\n\n${t}`);
  fs.writeFileSync(path.join(suiteDir, "suite.json"), JSON.stringify({ format: 1, suite: name, dir: path.resolve(dir),
    started: started.toISOString(), ended: new Date().toISOString(), tasks: rows }, null, 2) + "\n");
  console.log(`\n=== suite ${name} ===\n\n${t}\nSuite directory: ${suiteDir}`);
  return rows.every((r) => r.stop_reason !== "error");
}
