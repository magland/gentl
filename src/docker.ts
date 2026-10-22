// Docker mode: a fresh container per run, from the bundled default image or one given with --image.
// The image needs bash and setsid (util-linux); git is needed by most tasks and by the final-state record.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { execLocal, Sandbox, type ExecResult, type Started } from "./sandbox.js";

const WORKDIR = "/work";

function docker(args: string[], input?: string): ExecResult {
  return execLocal("docker", args, { input });
}

/** The default image, built from sandbox/Dockerfile on first use; its tag follows the Dockerfile's content. */
export function ensureDefaultImage(): string {
  const dockerfile = fs.readFileSync(new URL("../sandbox/Dockerfile", import.meta.url));
  const tag = "gentl-sandbox:" + createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
  if (docker(["image", "inspect", tag]).ok) return tag;
  console.log(`Building the sandbox image ${tag} (first run only) ...`);
  const p = spawnSync("docker", ["build", "-t", tag, "-"], { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });
  if (p.status !== 0) throw new Error(`docker build failed for ${tag}`);
  return tag;
}

export function checkDocker() {
  const r = docker(["version", "--format", "{{.Server.Version}}"]);
  if (!r.ok) throw new Error(`Docker is not available (${r.out.trim().split("\n")[0]}). Install or start Docker, or use --host.`);
}

export class DockerSandbox extends Sandbox {
  readonly kind = "docker";
  readonly workdir = WORKDIR;
  readonly imageId: string;
  private count = 0;

  /** `mounts` are read-only bind mounts (host directory to container directory). */
  constructor(readonly name: string, readonly image: string, mounts: { host: string; container: string }[] = []) {
    super();
    const volumes = mounts.flatMap((m) => ["-v", `${m.host}:${m.container}:ro`]);
    const r = docker(["run", "-d", "--init", "--name", name, "-w", WORKDIR, ...volumes, "--entrypoint", "sleep", image, "infinity"]);
    if (!r.ok) throw new Error(`could not start container from ${image}: ${r.out.trim()}`);
    this.imageId = docker(["image", "inspect", "-f", "{{.Id}}", image]).out.trim();
  }

  describe(): string {
    return `docker, image ${this.image}, container ${this.name}`;
  }

  protected start(cmd: string): Started {
    // setsid gives the command its own process group inside the container; its id goes to a pid file so the group
    // can be killed (killing the local docker client would leave the command running). The command's stderr is
    // merged into stdout inside the container, so the client's stderr holds only messages from setsid and docker.
    const pidFile = `/tmp/.gentl-cmd-${++this.count}.pid`;
    const child = spawn("docker", ["exec", "-w", WORKDIR, this.name, "setsid", "-w", "bash", "-c",
      `echo $$ > ${pidFile}; exec bash -c "$1" 2>&1`, "gentl", cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      docker(["exec", this.name, "bash", "-c", `kill -9 -- -$(cat ${pidFile}) 2>/dev/null`]);
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    };
    return { child, kill, ignoreStderr: true };
  }

  exec(args: string[], cwd?: string, input?: string): ExecResult {
    const w = cwd ? (cwd.startsWith("/") ? cwd : `${WORKDIR}/${cwd}`) : WORKDIR;
    return docker(["exec", ...(input !== undefined ? ["-i"] : []), "-w", w, this.name, ...args], input);
  }

  remove() {
    docker(["rm", "-f", this.name]);
  }
}
