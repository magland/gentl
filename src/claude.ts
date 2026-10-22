// The claude-code backend: each call is a fresh `claude -p` process using the user's Claude Code login.
// It runs with no tools, no settings files (so no CLAUDE.md, memory, hooks or plugins), no MCP servers and no saved
// session. Claude Code still adds a short preamble and an environment block (cwd, platform, date) to the system
// prompt, about 740 tokens; `--bare` would remove them but only works with an API key, not a subscription login.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Interrupted, retryWait, RETRY_DELAYS_S, type ModelClient, type ModelReply, type ResponseSchema } from "./model.js";

const CALL_TIMEOUT_S = 600;

/** OpenRouter-style ids (anthropic/claude-haiku-5.5) to Claude Code ids (claude-haiku-5-5); aliases pass through. */
export function claudeModelName(model: string): string {
  return model.replace(/^anthropic\//, "").replace(/(\d+)\.(\d+)/g, "$1-$2");
}

let scratchDir: string | null = null;

/** An empty directory to run `claude` in when no better cwd is given, removed when gentl exits. */
function emptyDir(): string {
  if (!scratchDir) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gentl-claude-"));
    scratchDir = dir;
    process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  return scratchDir;
}

export class ClaudeCodeClient implements ModelClient {
  structured = true;
  private model: string;

  constructor(model: string, private schema: ResponseSchema, private log: (msg: string) => void, private cwd?: string) {
    this.model = claudeModelName(model);
  }

  async call(system: string, user: string, signal: AbortSignal): Promise<ModelReply> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(system, user, signal);
      if (r.ok) return r.reply;
      if (/not logged in|\/login/i.test(r.error)) throw new Error(`claude: ${r.error} (log in to Claude Code first)`);
      if (this.structured && /schema/i.test(r.error)) {
        this.structured = false;
        this.log(`structured output failed (${r.error.slice(0, 200)}); using plain text from now on`);
        attempt--;
        continue;
      }
      if (attempt >= RETRY_DELAYS_S.length) throw new Error(`claude call failed: ${r.error.slice(0, 500)}`);
      await retryWait(attempt, `claude call failed: ${r.error.slice(0, 200)}`, signal, this.log);
    }
  }

  private once(system: string, user: string, signal: AbortSignal):
    Promise<{ ok: true; reply: ModelReply } | { ok: false; error: string }> {
    const args = ["-p", "--system-prompt", system, "--tools", "", "--output-format", "json", "--no-session-persistence",
      "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--model", this.model];
    // Claude Code's default effort unless GENTL_CLAUDE_EFFORT is set (low, medium, high, ...).
    if (process.env.GENTL_CLAUDE_EFFORT) args.push("--effort", process.env.GENTL_CLAUDE_EFFORT);
    if (this.structured) args.push("--json-schema", JSON.stringify(this.schema.schema));
    const cwd = this.cwd && fs.existsSync(this.cwd) ? this.cwd : emptyDir();
    return new Promise((resolve, reject) => {
      const child = spawn("claude", args, { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr.on("data", (b: Buffer) => (err += b.toString("utf8")));
      const kill = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      };
      const timer = setTimeout(kill, CALL_TIMEOUT_S * 1000);
      const onAbort = () => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => resolve({ ok: false, error: `could not run claude: ${e.message}` }));
      child.on("close", () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) return reject(new Interrupted());
        let parsed: any;
        try {
          parsed = JSON.parse(out);
        } catch {
          return resolve({ ok: false, error: (err || out || "no output").trim() });
        }
        // The output is a single result object, or (with verbose settings) an array of messages ending in one.
        const r = Array.isArray(parsed) ? parsed.find((m) => m?.type === "result") : parsed;
        if (!r) return resolve({ ok: false, error: "no result in claude output" });
        if (r.is_error) return resolve({ ok: false, error: String(r.result ?? r.subtype ?? "error") });
        const text = r.structured_output !== undefined ? JSON.stringify(r.structured_output) : String(r.result ?? "");
        const u = r.usage ?? {};
        resolve({ ok: true, reply: { text, usage: {
          prompt_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          completion_tokens: u.output_tokens ?? 0,
          cost: r.total_cost_usd ?? 0, // notional: billed to the subscription
          claude: u,
        } } });
      });
      child.stdin.end(user);
    });
  }
}
