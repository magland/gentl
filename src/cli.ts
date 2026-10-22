#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { runTask } from "./run.js";

const VERSION: string = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const USAGE = `gentl ${VERSION}: a readability test for codebases

usage:
  gentl run (TASK.md | -t TEXT) --host [options]

options:
  -t, --task TEXT     task text given directly
  --host              run in a fresh temp directory on this machine, confirming each action
                      (required for now; a Docker sandbox comes later)
  --model M           model (default anthropic/claude-haiku-5.5)
  --base-url URL      OpenAI-compatible endpoint (default https://openrouter.ai/api/v1)
  --max-turns N       stop after N turns (default 50)
  --keep              keep the temp workspace instead of deleting it

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
      model: { type: "string", default: "anthropic/claude-haiku-5.5" },
      "base-url": { type: "string", default: "https://openrouter.ai/api/v1" },
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
  if (!values.host) fail("only --host is supported for now (a Docker sandbox comes later); pass --host to run in a temp directory on this machine, confirming each action");
  if (!process.stdin.isTTY) fail("--host needs a terminal to confirm each action");
  const maxTurns = Number(values["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) fail("--max-turns must be a positive integer");
  const apiKey = envValue("OPENROUTER_API_KEY");
  if (!apiKey) fail("OPENROUTER_API_KEY is not set (environment or ./.env)");

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
    if (fs.statSync(p).isDirectory()) fail("task suites (directories) are not supported yet");
    task = fs.readFileSync(p, "utf8").trim();
    taskName = path.basename(p).replace(/\.[^.]*$/, "");
    taskSource = { kind: "file", path: p };
  }
  if (!task) fail("the task is empty");

  const ok = await runTask({ task, taskName, taskSource, maxTurns, keep: !!values.keep, version: VERSION,
    model: { model: values.model!, baseUrl: values["base-url"]!, apiKey } });
  process.exit(ok ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "run") await run(rest);
  else if (cmd === "--version" || cmd === "-V") console.log(VERSION);
  else {
    console.log(USAGE);
    process.exit(cmd === "-h" || cmd === "--help" ? 0 : 2);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
