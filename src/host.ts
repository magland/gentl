// Host mode: a fresh temp directory on this machine, with work/ (where the agent's commands run) and home/ (HOME).

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execLocal, Sandbox, type ExecResult, type Started } from "./sandbox.js";

// Environment variables passed through from the user's environment; everything else (API keys, tokens, XDG dirs) is dropped.
const PASSTHROUGH_ENV = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SHELL",
  "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];

function killGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export class HostSandbox extends Sandbox {
  readonly kind = "host";
  readonly root: string;
  readonly workdir: string;
  private env: NodeJS.ProcessEnv = {};
  private groups = new Set<number>(); // process groups of all commands, killed on remove()

  constructor() {
    super();
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "gentl-"));
    this.workdir = path.join(this.root, "work");
    const home = path.join(this.root, "home");
    fs.mkdirSync(this.workdir);
    fs.mkdirSync(home);
    for (const k of PASSTHROUGH_ENV) if (process.env[k] !== undefined) this.env[k] = process.env[k];
    Object.assign(this.env, { HOME: home, TERM: "dumb", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0" });
  }

  describe(): string {
    return `host, workspace ${this.root}`;
  }

  protected start(cmd: string): Started {
    const child = spawn("bash", ["-c", cmd], { cwd: this.workdir, env: this.env, detached: true,
      stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid) this.groups.add(child.pid);
    return { child, kill: () => killGroup(child.pid) };
  }

  exec(args: string[], cwd?: string, input?: string): ExecResult {
    return execLocal(args[0], args.slice(1), { cwd: path.resolve(this.workdir, cwd ?? "."), env: this.env, input });
  }

  remove() {
    for (const pid of this.groups) killGroup(pid);
    try {
      fs.rmSync(this.root, { recursive: true, force: true });
    } catch {
      // Some caches (e.g. Go modules) are read-only.
      spawnSync("chmod", ["-R", "u+w", this.root]);
      fs.rmSync(this.root, { recursive: true, force: true });
    }
  }
}
