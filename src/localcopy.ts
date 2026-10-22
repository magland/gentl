// The local copy: clones of your repo's origin URL are served from a temporary bare mirror of your checkout,
// including uncommitted changes as an extra commit, so you can edit docs and rerun without pushing.
// The sandbox's git config gets url.<mirror>.insteadOf <origin URL variants>, so the agent runs the git clone the
// task names and gets your working copy.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execLocal, type Sandbox } from "./sandbox.js";

export interface LocalCopy {
  repo: string; // top level of your checkout
  origin: string; // its origin URL
  urls: string[]; // URL forms that are redirected to the mirror
  branch: string | null; // checked-out branch, or null if detached
  head: string; // commit checked out
  uncommitted_commit: string | null; // extra commit holding uncommitted changes, if any
  uncommitted_files: number;
  mirrorDir: string; // directory holding <name>.git on this machine
  mirrorName: string; // <name>.git
}

/** Info recorded in summary.json. */
export function localCopyInfo(lc: LocalCopy) {
  return { repo: lc.repo, origin: lc.origin, urls: lc.urls, branch: lc.branch, head: lc.head,
    uncommitted_commit: lc.uncommitted_commit, uncommitted_files: lc.uncommitted_files };
}

function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return execLocal("git", args, { cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : undefined });
}

/** URL forms a task might use for the same repo: https, http, scp-style ssh and ssh://, each with and without .git. */
export function urlVariants(origin: string): string[] {
  const m = origin.match(/^(?:https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)|git@([^:]+):(.+?)|ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?))(?:\.git)?\/?$/);
  if (!m) return [origin];
  const host = m[1] ?? m[3] ?? m[5];
  const repoPath = m[2] ?? m[4] ?? m[6];
  const forms = [`https://${host}/${repoPath}`, `http://${host}/${repoPath}`, `git@${host}:${repoPath}`, `ssh://git@${host}/${repoPath}`];
  return [...new Set([origin, ...forms.flatMap((f) => [f, `${f}.git`])])];
}

/** URLs in the task text that a variant would also rewrite by prefix (e.g. owner/foo-extra for owner/foo). */
export function prefixCollisions(task: string, urls: string[]): string[] {
  const found = new Set<string>();
  for (const u of urls) {
    const re = new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([A-Za-z0-9_-][^\\s)\"'`]*)", "g");
    for (const m of task.matchAll(re)) found.add(m[0]);
  }
  return [...found];
}

/** The repo to mirror: the git checkout containing `dir`, if it has an origin. Returns a reason when there is none. */
export function findRepo(dir: string): { repo: string; origin: string } | { reason: string } {
  const top = git(["rev-parse", "--show-toplevel"], { cwd: dir });
  if (!top.ok) return { reason: `${dir} is not in a git repo` };
  const repo = top.out.trim();
  const origin = git(["remote", "get-url", "origin"], { cwd: repo });
  if (!origin.ok) return { reason: `${repo} has no origin remote` };
  return { repo, origin: origin.out.trim() };
}

/** Make the mirror: a bare clone of the checkout, with uncommitted changes (tracked and untracked, not ignored)
 * committed on top of HEAD. Your own repo, index and working tree are not modified. */
export function prepareLocalCopy(repo: string, origin: string): LocalCopy {
  const mirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), "gentl-mirror-"));
  const name = (origin.replace(/\/$/, "").split(/[/:]/).pop() ?? "repo").replace(/\.git$/, "").replace(/[^A-Za-z0-9_.-]/g, "-") || "repo";
  const mirrorName = `${name}.git`;
  const mirror = path.join(mirrorDir, mirrorName);
  const clone = git(["clone", "--quiet", "--bare", repo, mirror]);
  if (!clone.ok) throw new Error(`could not mirror ${repo}: ${clone.out.trim()}`);

  const branchRef = git(["symbolic-ref", "-q", "HEAD"], { cwd: repo });
  const branch = branchRef.ok ? branchRef.out.trim().replace(/^refs\/heads\//, "") : null;
  const head = git(["rev-parse", "HEAD"], { cwd: repo }).out.trim();

  // Honor the checkout's own excludes (.git/info/exclude), which git would not read with GIT_DIR set to the mirror.
  const exclude = git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: repo }).out.trim();
  if (exclude && fs.existsSync(exclude)) {
    fs.mkdirSync(path.join(mirror, "info"), { recursive: true });
    fs.copyFileSync(exclude, path.join(mirror, "info", "exclude"));
  }

  // Build a tree of the working copy with a temporary index, writing objects into the mirror only.
  const index = path.join(mirrorDir, "index");
  const env = { GIT_DIR: mirror, GIT_WORK_TREE: repo, GIT_INDEX_FILE: index };
  const steps = [["read-tree", head], ["add", "-A"]];
  for (const args of steps) {
    const r = git(args, { cwd: repo, env });
    if (!r.ok) throw new Error(`could not record uncommitted changes (git ${args.join(" ")}): ${r.out.trim()}`);
  }
  const tree = git(["write-tree"], { cwd: repo, env }).out.trim();
  fs.rmSync(index, { force: true });
  const headTree = git(["--git-dir", mirror, "rev-parse", `${head}^{tree}`]).out.trim();
  let uncommitted: string | null = null;
  let files = 0;
  if (tree && tree !== headTree) {
    files = git(["--git-dir", mirror, "diff-tree", "-r", "--name-only", headTree, tree]).out.split("\n").filter(Boolean).length;
    // An ordinary-looking commit under your identity, so the agent has no reason to dig into where its clone came from.
    const name = git(["config", "user.name"], { cwd: repo }).out.trim() || "gentl";
    const email = git(["config", "user.email"], { cwd: repo }).out.trim() || "gentl@localhost";
    const ident = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const c = git(["--git-dir", mirror, "commit-tree", tree, "-p", head, "-m", "Work in progress"], { env: ident });
    if (!c.ok) throw new Error(`could not commit uncommitted changes: ${c.out.trim()}`);
    uncommitted = c.out.trim();
    const ref = branch ? ["update-ref", `refs/heads/${branch}`, uncommitted] : ["update-ref", "--no-deref", "HEAD", uncommitted];
    git(["--git-dir", mirror, ...ref]);
  }
  return { repo, origin, urls: urlVariants(origin), branch, head, uncommitted_commit: uncommitted,
    uncommitted_files: files, mirrorDir, mirrorName };
}

export function describeLocalCopy(lc: LocalCopy): string {
  const at = `${lc.branch ?? "detached HEAD"} @ ${lc.head.slice(0, 7)}`;
  const extra = lc.uncommitted_commit ? ` + uncommitted changes in ${lc.uncommitted_files} file(s)` : "";
  return `clones of ${lc.origin} are served from your checkout ${lc.repo} (${at}${extra})`;
}

/** Point the sandbox's git at the mirror. `mirrorPath` is where the mirror is seen inside the sandbox. */
export function configureLocalCopy(sb: Sandbox, lc: LocalCopy, mirrorPath: string): string | null {
  const url = `file://${mirrorPath}`;
  for (const u of lc.urls) {
    const r = sb.exec(["git", "config", "--global", "--add", `url.${url}.insteadOf`, u]);
    if (!r.ok) return `could not configure git in the sandbox: ${r.out.trim()}`;
  }
  // The mirror belongs to another user inside a container; without this git refuses to clone it.
  sb.exec(["git", "config", "--global", "--add", "safe.directory", mirrorPath]);
  return null;
}

export function removeLocalCopy(lc: LocalCopy) {
  fs.rmSync(lc.mirrorDir, { recursive: true, force: true });
}
