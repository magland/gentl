// Where the agent's actions run. A sandbox runs commands with a timeout in their own process group, writes and
// edits files, and runs short commands for gentl itself (e.g. to record the final state).

import { spawnSync, type ChildProcess } from "node:child_process";
import { CMD_TIMEOUT_S, countOccurrences, DEFAULT_MAX_CHARS, MAX_MAX_CHARS, READ_MAX_CHARS } from "./protocol.js";

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
  sandboxError: string | null; // the sandbox failed (e.g. its container disappeared); the run cannot go on
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
  /** The command's own stderr arrives on stdout; stderr carries only the sandbox's messages (e.g. docker's).
   * This classifies them: lines to drop, and a fatal error meaning the sandbox itself is gone. */
  sandboxStderr?: (text: string) => { keep: string; fatal: string | null };
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
    let sandboxStderr = "";
    child.stderr!.on("data", (b: Buffer) => {
      if (started.sandboxStderr) sandboxStderr += b.toString("utf8");
      else cap.add(b);
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
        const classified = started.sandboxStderr?.(sandboxStderr) ?? { keep: "", fatal: null };
        if (classified.keep) cap.add(Buffer.from(classified.keep));
        const out = cap.text();
        let status = cur.interrupted ? "stopped by the person running gentl (Ctrl-C)"
          : timedOut ? `timed out after ${CMD_TIMEOUT_S} s` : code !== null ? `exit code ${code}` : `killed by ${signal}`;
        if (out.length > maxChars) status += `; output cut in the middle (${out.length - Math.floor((maxChars * 3) / 5) - Math.floor((maxChars * 2) / 5)} of ${out.length} chars left out)`;
        const truncation = out.length > maxChars
          ? { head: status.length + 1 + Math.floor((maxChars * 3) / 5), tail: Math.floor((maxChars * 2) / 5) } : null;
        resolve({ exitCode: code, signal, full: `${status}\n${out}`, shown: `${status}\n${truncate(out, maxChars)}`,
          truncation, seconds: (Date.now() - t0) / 1000, timedOut, interrupted: cur.interrupted,
          sandboxError: classified.fatal });
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

  /** Lines `start` to `end` of a file, numbered; never cut in the middle, stopped at a line boundary if too long. */
  readFile(p: string, start?: number, end?: number): string {
    const r = this.exec(["cat", "--", p]);
    if (!r.ok) return `error: ${r.out.trim()}`;
    if (r.out.includes("\0")) return `error: ${p} is a binary file`;
    const lines = r.out.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const from = Math.max(1, start ?? 1);
    const to = Math.min(total, end ?? total);
    if (from > total) return `${p} has ${total} lines; nothing at line ${from}`;
    const width = String(to).length;
    let body = "";
    let last = from - 1;
    for (let i = from; i <= to; i++) {
      const line = `${String(i).padStart(width)}  ${lines[i - 1]}\n`;
      if (body.length + line.length > READ_MAX_CHARS && i > from) break;
      body += line;
      last = i;
    }
    const head = `${p}: lines ${from}-${last} of ${total}`;
    const more = last < to ? `\n[stopped at line ${last} to stay under ${READ_MAX_CHARS} chars; read on with "start_line": ${last + 1}]` : "";
    return `${head}\n${body}${more}`;
  }

  editFile(p: string, old: string, replacement: string): string {
    const r = this.exec(["cat", "--", p]);
    if (!r.ok) return `error: ${r.out.trim()}`;
    const n = countOccurrences(r.out, old);
    if (n > 1) return `error: the old text occurs ${n} times in ${p}; it must occur exactly once (include more of the surrounding lines)`;
    if (n === 0) return `error: the old text occurs 0 times in ${p}; it must occur exactly once${editHint(r.out, old)}`;
    const w = this.exec(["sh", "-c", 'cat > "$1"', "sh", p], undefined, r.out.replace(old, () => replacement));
    return w.ok ? `edited ${p}` : `error: ${w.out.trim()}`;
  }
}

/**
 * Why an edit's old text may not have matched, for the error message: the commonest cause is a backslash
 * sequence in the code (a \\n inside a string) written in JSON as a real line break or tab; otherwise the
 * file's lines that come closest to the old text's first line, so the agent can copy them exactly.
 */
export function editHint(text: string, old: string): string {
  const unescaped = old.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  for (const candidate of [old.replace(/\t/g, "\\t"), unescaped]) {
    if (candidate !== old && countOccurrences(text, candidate) === 1) {
      return ". It would match if a line break or tab inside the old text were the two characters \\n or \\t, as the file has them: in JSON, write a backslash in the code as \\\\ (\\n in the code is \"\\\\n\")";
    }
  }
  const first = old.split("\n").map((l) => l.trim()).find((l) => l.length >= 3);
  if (!first) return "";
  const lines = text.split("\n");
  const words = first.split(/\W+/).filter((w) => w.length >= 3);
  const scored = lines.map((l, i) => {
    const t = l.trim();
    const score = t === first ? 1000 : t.includes(first) ? 500 : words.filter((w) => t.includes(w)).length;
    return { i, l, score };
  }).filter((x) => x.score > 0 && (x.score >= 500 || x.score >= Math.max(2, Math.ceil(words.length / 2))));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  if (!scored.length) return "";
  const shown = scored.slice(0, 3).sort((a, b) => a.i - b.i).map((x) => `${x.i + 1}: ${x.l}`).join("\n");
  return `. The file's lines closest to the old text's first line (copy the old text exactly, including indentation; read_file shows the lines around them):\n${shown}`;
}

/** spawnSync wrapper returning stdout (plus stderr on failure). */
export function execLocal(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }): ExecResult {
  const p = spawnSync(cmd, args, { ...opts, encoding: "utf8", maxBuffer: 64 << 20 });
  if (p.error) return { ok: false, out: p.error.message };
  return { ok: p.status === 0, out: (p.stdout ?? "") + (p.status === 0 ? "" : p.stderr ?? "") };
}
