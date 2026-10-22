#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { checkDocker, ensureDefaultImage } from "./docker.js";
import { evaluate, runTask } from "./run.js";
import { runSuite } from "./suite.js";

const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

const USAGE = `gentl ${VERSION}: a readability test for codebases

usage:
  gentl run (TASK.md | DIR | -t TEXT) [options]   run the agent on a task, then evaluate the run;
                                                 DIR runs each *.md in it as a suite
  gentl evaluate RUN_DIR [options]                (re-)evaluate a finished run

options:
  -t, --task TEXT     task text given directly
  --image IMG         Docker image for the sandbox (default: built from gentl's sandbox/Dockerfile)
  --host              run in a fresh temp directory on this machine instead of Docker
  --confirm           ask before each action (the default with --host)
  --yes               with --host, run actions without asking
  --model M           model for the agent (default ${DEFAULT_MODEL})
  --evaluator-model M model for the evaluator (default ${DEFAULT_MODEL})
  --base-url URL      OpenAI-compatible endpoint (default ${DEFAULT_BASE_URL})
  --max-turns N       stop after N turns (default 50)
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
      model: { type: "string", default: DEFAULT_MODEL },
      "evaluator-model": { type: "string", default: DEFAULT_MODEL },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      "max-turns": { type: "string", default: "50" },
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
  const confirm = values.host ? !values.yes : !!values.confirm;
  if (confirm && !process.stdin.isTTY) fail("confirming each action needs a terminal (use --yes with --host to skip it)");
  const maxTurns = Number(values["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) fail("--max-turns must be a positive integer");
  const apiKey = requireApiKey();

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
  const common = { sandbox, confirm, maxTurns, keep: !!values.keep, version: VERSION,
    model: { model: values.model!, baseUrl: values["base-url"]!, apiKey },
    evaluatorModel: { model: values["evaluator-model"]!, baseUrl: values["base-url"]!, apiKey } };

  let task: string;
  let taskName: string;
  let taskSource: { kind: "file"; path: string } | { kind: "text" };
  if (values.task !== undefined) {
    task = values.task.trim();
    taskName = (task.toLowerCase().match(/[a-z0-9]+/g) ?? ["task"]).slice(0, 5).join("-");
    taskSource = { kind: "text" };
  } else {
    const p = positionals[0];
    if (/^https?:\/\//.test(p)) fail("hub tasks are not supported yet");
    if (!fs.existsSync(p)) fail(`no such file: ${p}`);
    if (fs.statSync(p).isDirectory()) {
      try {
        process.exit((await runSuite(p, common)) ? 0 : 1);
      } catch (e) {
        fail((e as Error).message);
      }
    }
    task = fs.readFileSync(p, "utf8").trim();
    taskName = path.basename(p).replace(/\.[^.]*$/, "");
    taskSource = { kind: "file", path: p };
  }
  if (!task) fail("the task is empty");

  try {
    const out = await runTask({ ...common, task, taskName, taskSource, runsDir: "runs" });
    process.exit(out.summary.stop_reason === "error" ? 1 : 0);
  } catch (e) {
    fail((e as Error).message);
  }
}

function requireApiKey(): string {
  const apiKey = envValue("OPENROUTER_API_KEY");
  if (!apiKey) fail("OPENROUTER_API_KEY is not set (environment or ./.env)");
  return apiKey;
}

async function evaluateCommand(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "evaluator-model": { type: "string", default: DEFAULT_MODEL },
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
  const ok = await evaluate(runDir, { model: values["evaluator-model"]!, baseUrl: values["base-url"]!, apiKey: requireApiKey() });
  process.exit(ok ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "run") await run(rest);
  else if (cmd === "evaluate") await evaluateCommand(rest);
  else if (cmd === "--version" || cmd === "-V") console.log(VERSION);
  else {
    console.log(USAGE);
    process.exit(cmd === "-h" || cmd === "--help" ? 0 : 2);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
