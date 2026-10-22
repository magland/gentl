// Host-mode workspace: a fresh temp directory with work/ (where the agent's commands run) and home/ (HOME).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CMD_TIMEOUT_S, countOccurrences, DEFAULT_MAX_CHARS, MAX_MAX_CHARS } from "./protocol.js";

// Environment variables passed through from the user's environment; everything else (API keys, tokens, XDG dirs) is dropped.
const PASSTHROUGH_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SHELL",
  "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];

const CAPTURE_HEAD = 1 << 20; // bytes of output kept from the start of a command
const CAPTURE_TAIL = 1 << 20; // and from the end

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  full: string; // everything captured (up to 2 MB)
  shown: string; // what the agent sees
  truncation: { head: number; tail: number } | null; // chars of `full` shown at the start and end, if cut
  seconds: number;
  timedOut: boolean;
  interrupted: boolean;
}

/** Keep the head and tail, with a note on what was cut and how to see more. */
export function truncate(out: string, maxChars: number): string {
  if (out.length <= maxChars) return out;
  const head = out.slice(0, Math.floor((maxChars * 3) / 5));
  const tail = out.slice(out.length - Math.floor((maxChars * 2) / 5));
  const omitted = out.slice(head.length, out.length - tail.length);
  const lines = countOccurrences(omitted, "\n");
  return `${head}\n[... ${omitted.length} chars, ${lines} lines omitted; narrow the command (grep, sed -n, head) or raise max_chars (at most ${MAX_MAX_CHARS}) ...]\n${tail}`;
}

/** Collects output, keeping only the first and last megabyte of very long output. */
class Capture {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailLen = 0;
  private dropped = 0;

  add(b: Buffer) {
    if (this.head.length < CAPTURE_HEAD) {
      const n = Math.min(CAPTURE_HEAD - this.head.length, b.length);
      this.head = Buffer.concat([this.head, b.subarray(0, n)]);
      b = b.subarray(n);
    }
    if (!b.length) return;
    this.tail.push(b);
    this.tailLen += b.length;
    while (this.tailLen - this.tail[0].length >= CAPTURE_TAIL) {
      const first = this.tail.shift()!;
      this.tailLen -= first.length;
      this.dropped += first.length;
    }
  }

  text(): string {
    const gap = this.dropped ? `\n[... ${this.dropped} bytes not captured ...]\n` : "";
    return this.head.toString("utf8") + gap + Buffer.concat(this.tail).toString("utf8");
  }
}

export class HostWorkspace {
  readonly root: string;
  readonly workdir: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  private current: { child: ChildProcess; interrupted: boolean } | null = null;
  private groups = new Set<number>(); // process groups of all commands, killed on remove()

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "gentl-"));
    this.workdir = path.join(this.root, "work");
    this.home = path.join(this.root, "home");
    fs.mkdirSync(this.workdir);
    fs.mkdirSync(this.home);
    this.env = {};
    for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) this.env[k] = process.env[k];
    Object.assign(this.env, { HOME: this.home, TERM: "dumb", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0" });
  }

  /** Run a command with bash in its own process group, with no input and a timeout. */
  run(cmd: string, maxChars = DEFAULT_MAX_CHARS): Promise<RunResult> {
    maxChars = Math.max(200, Math.min(MAX_MAX_CHARS, Math.floor(maxChars)));
    const t0 = Date.now();
    const child = spawn("bash", ["-c", cmd], { cwd: this.workdir, env: this.env, detached: true,
      stdio: ["ignore", "pipe", "pipe"] });
    const cur = { child, interrupted: false };
    this.current = cur;
    if (child.pid) this.groups.add(child.pid);
    const cap = new Capture();
    child.stdout!.on("data", (b: Buffer) => cap.add(b));
    child.stderr!.on("data", (b: Buffer) => cap.add(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.killGroup(child.pid);
    }, CMD_TIMEOUT_S * 1000);

    return new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.current = null;
        const out = cap.text();
        const status = cur.interrupted ? "stopped by the person running gentl (Ctrl-C)"
          : timedOut ? `timed out after ${CMD_TIMEOUT_S} s` : code !== null ? `exit code ${code}` : `killed by ${signal}`;
        const truncation = out.length > maxChars
          ? { head: status.length + 1 + Math.floor((maxChars * 3) / 5), tail: Math.floor((maxChars * 2) / 5) } : null;
        resolve({ exitCode: code, signal, full: `${status}\n${out}`, shown: `${status}\n${truncate(out, maxChars)}`,
          truncation, seconds: (Date.now() - t0) / 1000, timedOut, interrupted: cur.interrupted });
      };
      child.on("error", (e) => {
        cap.add(Buffer.from(`error: ${e.message}\n`));
        finish(null, "spawn error");
      });
      child.on("close", (code, signal) => finish(code, signal));
      // A background process (`server &`) can keep the pipes open after bash exits; don't wait for it.
      child.on("exit", (code, signal) => setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish(code, signal);
      }, 1000));
    });
  }

  /** Stop the running command (Ctrl-C). Returns false if no command is running. */
  interrupt(): boolean {
    if (!this.current) return false;
    this.current.interrupted = true;
    this.killGroup(this.current.child.pid);
    return true;
  }

  private killGroup(pid: number | undefined) {
    if (!pid) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  private resolve(p: string): string {
    return path.resolve(this.workdir, p);
  }

  writeFile(p: string, content: string): string {
    try {
      const abs = this.resolve(p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return `wrote ${p}`;
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  editFile(p: string, old: string, replacement: string): string {
    let text: string;
    try {
      text = fs.readFileSync(this.resolve(p), "utf8");
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
    const n = countOccurrences(text, old);
    if (n !== 1) return `error: the old text occurs ${n} times in ${p}; it must occur exactly once`;
    try {
      fs.writeFileSync(this.resolve(p), text.replace(old, () => replacement));
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
    return `edited ${p}`;
  }

  /** Kill leftover background processes and delete the workspace. */
  remove() {
    for (const pid of this.groups) this.killGroup(pid);
    try {
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch {
      // Some caches (e.g. Go modules) are read-only.
      spawnSync("chmod", ["-R", "u+w", this.root]);
      fs.rmSync(this.root, { recursive: true, force: true });
    }
  }
}
