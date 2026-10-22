// Where the agent's actions run. A sandbox runs commands with a timeout in their own process group, writes and
// edits files, and runs short commands for gentl itself (e.g. to record the final state).

import { spawnSync, type ChildProcess } from "node:child_process";
import { CMD_TIMEOUT_S, countOccurrences, DEFAULT_MAX_CHARS, MAX_MAX_CHARS } from "./protocol.js";

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

export interface ExecResult {
  ok: boolean;
  out: string; // stdout, plus stderr on failure
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

/** A started command: the local child process (bash, or the docker client) and how to kill its process group. */
export interface Started {
  child: ChildProcess;
  kill: () => void;
  ignoreStderr?: boolean; // the command's stderr already arrives on stdout
}

export abstract class Sandbox {
  abstract readonly kind: "host" | "docker";
  /** The working directory as the agent sees it. */
  abstract readonly workdir: string;
  private current: { started: Started; interrupted: boolean } | null = null;

  /** Start `cmd` with bash in the working directory, in its own process group, with no input. */
  protected abstract start(cmd: string): Started;
  /** Run a program (argv, no shell) in the sandbox for gentl's own use; `cwd` defaults to the working directory. */
  abstract exec(args: string[], cwd?: string, input?: string): ExecResult;
  /** Stop everything and delete the sandbox. */
  abstract remove(): void;
  /** One line for the console: where the sandbox is. */
  abstract describe(): string;

  run(cmd: string, maxChars = DEFAULT_MAX_CHARS): Promise<RunResult> {
    maxChars = Math.max(200, Math.min(MAX_MAX_CHARS, Math.floor(maxChars)));
    const t0 = Date.now();
    const started = this.start(cmd);
    const { child } = started;
    const cur = { started, interrupted: false };
    this.current = cur;
    const cap = new Capture();
    child.stdout!.on("data", (b: Buffer) => cap.add(b));
    child.stderr!.on("data", (b: Buffer) => {
      if (!started.ignoreStderr) cap.add(b);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      started.kill();
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
      // A background process (`server &`) can keep the pipes open after the command exits; don't wait for it.
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
    this.current.started.kill();
    return true;
  }

  writeFile(p: string, content: string): string {
    const r = this.exec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", p], undefined, content);
    return r.ok ? `wrote ${p}` : `error: ${r.out.trim()}`;
  }

  editFile(p: string, old: string, replacement: string): string {
    const r = this.exec(["cat", "--", p]);
    if (!r.ok) return `error: ${r.out.trim()}`;
    const n = countOccurrences(r.out, old);
    if (n !== 1) return `error: the old text occurs ${n} times in ${p}; it must occur exactly once`;
    const w = this.exec(["sh", "-c", 'cat > "$1"', "sh", p], undefined, r.out.replace(old, () => replacement));
    return w.ok ? `edited ${p}` : `error: ${w.out.trim()}`;
  }
}

/** spawnSync wrapper returning stdout (plus stderr on failure). */
export function execLocal(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): ExecResult {
  const p = spawnSync(cmd, args, { ...opts, encoding: "utf8", maxBuffer: 64 << 20 });
  if (p.error) return { ok: false, out: p.error.message };
  return { ok: p.status === 0, out: (p.stdout ?? "") + (p.status === 0 ? "" : p.stderr ?? "") };
}
