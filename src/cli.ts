#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { parseArgs } from "node:util";
import { checkDocker, ensureDefaultImage } from "./docker.js";
import { fetchHubTask, hubCredentials, parseHubTaskUrl, runDirsIn, runHub, uploadRun, type HubCredentials } from "./hub.js";
import { findRepo, prepareLocalCopy, removeLocalCopy, type LocalCopy } from "./localcopy.js";
import type { ModelConfig } from "./model.js";
import { evaluate, runTask, type RunOptions } from "./run.js";
import { runBatch, suiteTasks } from "./suite.js";

const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

const USAGE = `gentl ${VERSION}: a readability test for codebases

usage:
  gentl run (TASK.md | DIR | URL | -t TEXT) [options]
                                  run the agent on a task, then evaluate the run; DIR runs each
                                  *.md in it as a suite; URL is a task on a hub (https://<hub>/tasks/<id>)
  gentl evaluate RUN_DIR [options]  (re-)evaluate a finished run
  gentl upload RUN_DIR...           upload runs (or batch directories of runs) to their task's hub

options:
  -t, --task TEXT     task text given directly
  --image IMG         Docker image for the sandbox (default: built from gentl's sandbox/Dockerfile)
  --host              run in a fresh temp directory on this machine instead of Docker
  --confirm           ask before each action (the default with --host)
  --yes               don't ask: run a hub task without confirming it, and with --host, run actions
                      without asking
  --upload            upload each finished run to the hub its task came from
  --model M           model for the agent (default ${DEFAULT_MODEL})
  --evaluator-model M model for the evaluator (default ${DEFAULT_MODEL})
  --backend B         openrouter (any OpenAI-compatible endpoint; key in OPENROUTER_API_KEY) or
                      claude-code (your Claude Code login, via claude -p); default from
                      GENTL_BACKEND, else openrouter
  --base-url URL      OpenAI-compatible endpoint (default ${DEFAULT_BASE_URL})
  --max-turns N       stop after N turns (default 250)
  --repeat N          run each task N times and report the success rate and median read tokens
  --local             serve clones of the task's repo from your checkout, uncommitted changes included
                      (the default when the task file, suite or current directory is in a git repo)
  --remote            clone the published repo instead
  --keep              keep the container or temp workspace instead of deleting it

The API key is read from OPENROUTER_API_KEY, in the environment or in ./.env.
Runs are written to ./runs/<id>/.`;

/** A variable from the environment, or from ./.env. */
function envValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  if (!fs.existsSync(".env")) return undefined;
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
}

function fail(msg: string): never {
  console.error(`gentl: ${msg}`);
  process.exit(2);
}

async function run(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string", short: "t" },
      host: { type: "boolean" },
      image: { type: "string" },
      confirm: { type: "boolean" },
      yes: { type: "boolean" },
      local: { type: "boolean" },
      upload: { type: "boolean" },
      remote: { type: "boolean" },
      model: { type: "string", default: DEFAULT_MODEL },
      "evaluator-model": { type: "string", default: DEFAULT_MODEL },
      backend: { type: "string" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      "max-turns": { type: "string", default: "250" },
      repeat: { type: "string", default: "1" },
      keep: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if ((values.task === undefined) === (positionals.length !== 1)) fail("give one task: a task file or -t TEXT");
  if (values.host && values.image) fail("--image applies to the Docker sandbox, not --host");
  if (values.confirm && values.yes) fail("--confirm and --yes contradict each other");
  if (values.local && values.remote) fail("--local and --remote contradict each other");
  const confirm = values.host ? !values.yes : !!values.confirm;
  if (confirm && !process.stdin.isTTY) fail("confirming each action needs a terminal (use --yes with --host to skip it)");
  const maxTurns = Number(values["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) fail("--max-turns must be a positive integer");
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat must be a positive integer");
  const modelFor = modelConfig(values.backend, values["base-url"]!);

  let sandbox: { kind: "host" } | { kind: "docker"; image: string };
  if (values.host) {
    sandbox = { kind: "host" };
    if (!confirm) console.log("warning: host mode without confirmation; the agent's commands run on this machine unchecked");
  } else {
    try {
      checkDocker();
      sandbox = { kind: "docker", image: values.image ?? ensureDefaultImage() };
    } catch (e) {
      fail((e as Error).message);
    }
  }
  // What to run: a suite directory, a task file, or task text.
  let target: { kind: "suite"; dir: string } | { kind: "task"; task: string; taskName: string;
    taskSource: RunOptions["taskSource"] };
  if (values.task !== undefined) {
    const task = values.task.trim();
    target = { kind: "task", task, taskName: (task.toLowerCase().match(/[a-z0-9]+/g) ?? ["task"]).slice(0, 5).join("-"),
      taskSource: { kind: "text" } };
  } else {
    const p = positionals[0];
    if (/^https?:\/\//.test(p)) {
      if (!parseHubTaskUrl(p)) fail(`not a hub task URL: ${p} (expected https://<hub>/tasks/<id>)`);
      if (values.local) fail("--local does not apply to hub tasks; they always clone the published repo");
      let t;
      try {
        t = await fetchHubTask(p);
      } catch (e) {
        fail((e as Error).message);
      }
      console.log(`Task ${t.id} from ${t.hub}: ${t.title}\n\n${t.text.replace(/^/gm, "    ")}\n`);
      if (!values.yes) {
        if (!process.stdin.isTTY) fail("a hub task needs confirming in a terminal (or pass --yes)");
        if (!(await yesNo("Run this task? [y/n] "))) {
          console.log("Not running it.");
          process.exit(0);
        }
      }
      const slug = (t.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).slice(0, 5).join("-");
      target = { kind: "task", task: t.text, taskName: `hub${t.id}${slug ? `-${slug}` : ""}`,
        taskSource: { kind: "hub", url: t.url, hub: t.hub, id: t.id, title: t.title } };
    } else if (!fs.existsSync(p)) fail(`no such file: ${p}`);
    else target = fs.statSync(p).isDirectory() ? { kind: "suite", dir: p }
      : { kind: "task", task: fs.readFileSync(p, "utf8").trim(), taskName: path.basename(p).replace(/\.[^.]*$/, ""),
        taskSource: { kind: "file", path: p } };
  }
  if (target.kind === "task" && !target.task) fail("the task is empty");

  // Uploads go to the hub the task came from; credentials are settled before any run starts.
  let upload: HubCredentials | null = null;
  if (values.upload) {
    if (target.kind !== "task" || target.taskSource.kind !== "hub") fail("--upload works only for tasks from a hub");
    try {
      upload = await hubCredentials(target.taskSource.hub);
    } catch (e) {
      fail((e as Error).message);
    }
  }

  // The local copy: the repo containing the task file or suite (or the current directory for -t).
  // Hub tasks always clone the published repo, so their results match public code.
  const isHub = target.kind === "task" && target.taskSource.kind === "hub";
  if (isHub && values.local) fail("--local does not apply to hub tasks; they always clone the published repo");
  let localCopy: LocalCopy | null = null;
  if (!values.remote && !isHub) {
    const dir = target.kind === "suite" ? target.dir : target.taskSource.kind === "file" ? path.dirname(target.taskSource.path) : ".";
    const found = findRepo(path.resolve(dir));
    if ("reason" in found) {
      if (values.local) fail(`--local: ${found.reason}`);
    } else {
      try {
        localCopy = prepareLocalCopy(found.repo, found.origin);
      } catch (e) {
        fail((e as Error).message);
      }
    }
  }

  const common = { sandbox, confirm, localCopy, upload, maxTurns, keep: !!values.keep, version: VERSION,
    model: modelFor(values.model!), evaluatorModel: modelFor(values["evaluator-model"]!) };
  let code = 0;
  try {
    if (target.kind === "suite") {
      code = (await runBatch(path.basename(path.resolve(target.dir)), suiteTasks(target.dir), repeat, common)) ? 0 : 1;
    } else if (repeat > 1) {
      code = (await runBatch(`${target.taskName}-x${repeat}`, [target], repeat, common)) ? 0 : 1;
    } else {
      const out = await runTask({ ...common, task: target.task, taskName: target.taskName, taskSource: target.taskSource, runsDir: "runs" });
      code = out.summary.stop_reason === "error" ? 1 : 0;
    }
  } catch (e) {
    console.error(`gentl: ${(e as Error).message}`);
    code = 2;
  } finally {
    if (localCopy) removeLocalCopy(localCopy);
  }
  process.exit(code);
}

/** Ask a yes/no question; Ctrl-C or Ctrl-D counts as no. */
function yesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    // Resolve before closing: close() fires the "close" handler synchronously.
    rl.question(question, (a) => {
      resolve(/^y(es)?$/i.test(a.trim()));
      rl.close();
    });
    rl.on("close", () => resolve(false));
  });
}

async function uploadCommand(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
  if (values.help || !positionals.length) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const dirs = positionals.flatMap((p) => (fs.existsSync(p) ? runDirsIn(p) : fail(`no such directory: ${p}`)));
  if (!dirs.length) fail("no run directories found");
  const creds = new Map<string, HubCredentials>();
  let failed = 0;
  for (const dir of dirs) {
    try {
      const hub = runHub(dir);
      if (!hub) throw new Error("its task did not come from a hub, so there is nowhere to upload it");
      if (!creds.has(hub)) creds.set(hub, await hubCredentials(hub));
      console.log(`${dir}: uploaded ${await uploadRun(dir, creds.get(hub)!)}`);
    } catch (e) {
      failed++;
      console.log(`${dir}: ${(e as Error).message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

/** Checks the backend settings once and returns a function giving the config for a model. */
function modelConfig(backendOpt: string | undefined, baseUrl: string): (model: string) => ModelConfig {
  const backend = backendOpt ?? envValue("GENTL_BACKEND") ?? "openrouter";
  if (backend === "claude-code") return (model) => ({ backend, model, baseUrl: "", apiKey: "" });
  if (backend !== "openrouter") fail(`unknown backend ${JSON.stringify(backend)}; use openrouter or claude-code`);
  const apiKey = envValue("OPENROUTER_API_KEY");
  if (!apiKey) fail("OPENROUTER_API_KEY is not set (environment or ./.env); or use --backend claude-code");
  return (model) => ({ backend: "openrouter", model, baseUrl, apiKey });
}

async function evaluateCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "evaluator-model": { type: "string", default: DEFAULT_MODEL },
      backend: { type: "string" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) fail("give one run directory");
  const runDir = path.resolve(positionals[0]);
  for (const f of ["summary.json", "events.jsonl"]) {
    if (!fs.existsSync(path.join(runDir, f))) fail(`${f} not found in ${runDir}`);
  }
  const ok = await evaluate(runDir, modelConfig(values.backend, values["base-url"]!)(values["evaluator-model"]!));
  process.exit(ok ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "run") await run(rest);
  else if (cmd === "evaluate") await evaluateCommand(rest);
  else if (cmd === "upload") await uploadCommand(rest);
  else if (cmd === "--version" || cmd === "-V") console.log(VERSION);
  else {
    console.log(USAGE);
    process.exit(cmd === "-h" || cmd === "--help" ? 0 : 2);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
