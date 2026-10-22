// The final state of the workspace, for the evaluator: git status and diff of each repo, plus loose files.
// Everything runs inside the sandbox through `exec`, so it works the same for host and Docker.

import { clip, fence } from "./format.js";
import type { Sandbox } from "./sandbox.js";

const SKIP_DIRS = ["node_modules", ".venv", "venv", "env", "site-packages", "__pycache__", "build", "dist", "target"];
const MAX_DEPTH = 4; // how deep to look for .git below the working directory
const DIFF_CAP = 40000; // chars per repo diff
const FILE_CAP = 10000; // bytes per untracked or loose file
const FILES_CAP = 40000; // chars of file contents per section
const MAX_FILES = 40; // files listed per section

export interface RepoState {
  path: string; // relative to the working directory
  changed: boolean;
}

const PRUNE = SKIP_DIRS.map((d) => `-name ${d}`).join(" -o ");

function lines(s: string): string[] {
  return s.split("\n").map((l) => l.trim()).filter(Boolean);
}

function filesSection(sb: Sandbox, cwd: string, rels: string[]): string {
  let out = "";
  let budget = FILES_CAP;
  for (const rel of rels.slice(0, MAX_FILES)) {
    const r = sb.exec(["bash", "-c", `[ -f "$1" ] && [ "$(wc -c < "$1")" -le ${FILE_CAP} ] && cat "$1"`, "_", rel], cwd);
    if (!r.ok || r.out.includes("\0") || r.out.length > budget) {
      out += `\n${rel}: (not shown: binary, large, or over the size budget)\n`;
      continue;
    }
    budget -= r.out.length;
    out += `\n${rel}:\n${fence(r.out)}`;
  }
  if (rels.length > MAX_FILES) out += `\n(${rels.length - MAX_FILES} more files not listed)\n`;
  return out;
}

export function describeFinalState(sb: Sandbox): { text: string; repos: RepoState[] } {
  const sh = (script: string, cwd?: string) => sb.exec(["bash", "-c", script], cwd);
  const git = (cwd: string, ...args: string[]) => sb.exec(["git", "-c", "core.quotepath=off", ...args], cwd);

  const top = sh("ls -1Ap");
  const repoDirs = lines(sh(`find . -maxdepth ${MAX_DEPTH} \\( ${PRUNE} \\) -prune -o -name .git -prune -print`).out)
    .map((p) => p.replace(/\/\.git$/, "").replace(/^\.\//, "") || ".")
    .sort();
  const repos: RepoState[] = [];
  let text = `Top level of the working directory: ${lines(top.out).join(", ") || "(empty)"}\n\n`;

  for (const rel of repoDirs) {
    const upstream = git(rel, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    const base = upstream.ok ? upstream.out.trim() : "HEAD";
    const status = git(rel, "status", "--short", "--branch").out;
    const commits = base !== "HEAD" ? git(rel, "log", "--oneline", `${base}..HEAD`).out : "";
    const diff = git(rel, "diff", base).out;
    const untracked = lines(git(rel, "ls-files", "--others", "--exclude-standard").out);
    repos.push({ path: rel, changed: !!(commits.trim() || diff.trim() || untracked.length) });
    text += `## Repo ${rel}\n\ngit status:\n${fence(status || "(clean)")}`;
    if (commits.trim()) text += `\nCommits made since ${base}:\n${fence(commits)}`;
    text += `\ngit diff ${base} (committed and uncommitted changes to tracked files):\n${fence(clip(diff, DIFF_CAP) || "(none)", "diff")}`;
    if (untracked.length) text += `\nUntracked files:\n${filesSection(sb, rel, untracked)}`;
    text += "\n";
  }

  // Files in the working directory outside any repo (e.g. an example script the agent wrote), two levels deep.
  const loose = lines(sh(`find . -maxdepth 2 \\( -name '.?*' -o ${PRUNE} \\) -prune -o -type f -print`).out)
    .map((p) => p.replace(/^\.\//, ""))
    .filter((p) => !repoDirs.some((r) => r === "." || p.startsWith(r + "/")));
  if (loose.length) text += `## Files outside any repo\n${filesSection(sb, ".", loose)}`;
  if (!repoDirs.length) text += "No git repos found in the working directory.\n";
  return { text, repos };
}
