// The hub client: fetch tasks from a gentl hub, upload runs to the hub their task came from, and remember the
// name and passcode to use for each hub (in ~/.config/gentl/hubs.json, readable only by you).

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

export interface HubTask {
  hub: string; // origin, e.g. https://gentl-hub.example.workers.dev
  id: number;
  title: string;
  text: string;
  url: string; // the task's page
}

export interface HubCredentials {
  user: string;
  passcode: string;
}

/** A task page URL (https://<hub>/tasks/<id>), or null if `s` is not one. */
export function parseHubTaskUrl(s: string): { hub: string; id: number } | null {
  const m = s.match(/^(https?:\/\/[^/]+)\/tasks\/(\d+)\/?$/);
  return m ? { hub: m[1], id: Number(m[2]) } : null;
}

export async function fetchHubTask(url: string): Promise<HubTask> {
  const p = parseHubTaskUrl(url);
  if (!p) throw new Error(`not a hub task URL: ${url} (expected https://<hub>/tasks/<id>)`);
  const r = await fetch(`${p.hub}/api/tasks/${p.id}`);
  if (!r.ok) throw new Error(`could not fetch task ${p.id} from ${p.hub}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const { task } = (await r.json()) as { task: { id: number; title: string; text: string } };
  return { hub: p.hub, id: task.id, title: task.title, text: task.text.trim(), url: `${p.hub}/tasks/${task.id}` };
}

// ---------- credentials ----------

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "gentl", "hubs.json");
}

function readConfig(): { hubs: Record<string, HubCredentials> } {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return { hubs: {} };
  }
}

function saveCredentials(hub: string, creds: HubCredentials) {
  const file = configPath();
  const config = readConfig();
  config.hubs[hub] = creds;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function ask(question: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  if (hidden) (rl as any)._writeToOutput = (s: string) => { if (!muted) process.stdout.write(s); };
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.on("close", () => { if (!answered) reject(new Error("cancelled")); });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

function gitUserName(): string {
  try {
    return execFileSync("git", ["config", "user.name"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Name and passcode for a hub: from GENTL_HUB_USER and GENTL_HUB_PASSCODE, the saved config, or by asking. */
export async function hubCredentials(hub: string): Promise<HubCredentials> {
  const saved = readConfig().hubs[hub];
  const user = process.env.GENTL_HUB_USER || saved?.user;
  const passcode = process.env.GENTL_HUB_PASSCODE || saved?.passcode;
  if (user && passcode) return { user, passcode };
  if (!process.stdin.isTTY) throw new Error(`no credentials for ${hub}: set GENTL_HUB_USER and GENTL_HUB_PASSCODE, or run gentl upload in a terminal once`);
  console.log(`Uploading to ${hub} needs your name (shown with your runs) and the hub's passcode.`);
  const def = user || gitUserName();
  const name = (await ask(`Your name${def ? ` [${def}]` : ""}: `)) || def;
  if (!name) throw new Error("a name is required");
  const code = passcode || (await ask("Passcode: ", true));
  if (!code) throw new Error("a passcode is required");
  const creds = { user: name, passcode: code };
  const remember = (await ask(`Remember them in ${configPath()}? [y/n] `)).toLowerCase();
  if (remember === "y" || remember === "yes") saveCredentials(hub, creds);
  return creds;
}

// ---------- upload ----------

function readJsonl(file: string): any[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The hub a run's task came from, or null for a local task. */
export function runHub(runDir: string): string | null {
  const s = JSON.parse(fs.readFileSync(path.join(runDir, "summary.json"), "utf8"));
  return s.task_source?.kind === "hub" ? s.task_source.hub : null;
}

/** The upload payload: summary, evaluation, final state, and each turn as the agent saw it (not full results). */
export function buildUpload(runDir: string, user: string) {
  const read = (f: string) => (fs.existsSync(path.join(runDir, f)) ? fs.readFileSync(path.join(runDir, f), "utf8") : null);
  const summary = JSON.parse(read("summary.json")!);
  const evaluation = read("evaluation.json");
  const turns = readJsonl(path.join(runDir, "events.jsonl")).filter((e) => e.type === "turn").map((e) => ({
    turn: e.turn,
    notes_tokens: e.notes_tokens,
    result_tokens: e.result_tokens,
    notes: e.notes ?? null,
    notes_ops: e.notes_ops ?? null,
    action: e.parsed?.action ?? null,
    result_shown: e.result_shown ?? null,
    result_full_chars: typeof e.result_full === "string" ? e.result_full.length : null,
    parse_error: e.parse_error ?? null,
    raw_response: e.parse_error ? e.response : null,
    notes_reminder: !!e.notes_reminder,
  }));
  return { user, summary, evaluation: evaluation ? JSON.parse(evaluation) : null, final_state: read("final-state.md"), turns };
}

/** Upload a run to the hub its task came from. Returns the run's page URL. */
export async function uploadRun(runDir: string, creds: HubCredentials): Promise<string> {
  const hub = runHub(runDir);
  if (!hub) throw new Error(`${runDir}: its task did not come from a hub, so there is nowhere to upload it`);
  const r = await fetch(`${hub}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.passcode}` },
    body: JSON.stringify(buildUpload(runDir, creds.user)),
  });
  const text = await r.text();
  if (r.status !== 201) throw new Error(`upload to ${hub} failed: HTTP ${r.status} ${text.slice(0, 300)}`);
  return `${hub}/runs/${JSON.parse(text).id}`;
}

/** Run directories under `dir`: the directory itself if it is a run, else its subdirectories that are runs (a batch). */
export function runDirsIn(dir: string): string[] {
  if (fs.existsSync(path.join(dir, "summary.json"))) return [dir];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "summary.json")))
    .map((e) => path.join(dir, e.name))
    .sort();
}
