// The final state of the workspace, for the evaluator: git status and diff of each repo, plus loose files.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { clip, fence } from "./format.js";

const SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "env", "site-packages", "__pycache__", "build", "dist", "target"]);
const MAX_DEPTH = 3; // how deep to look for repos below the working directory
const DIFF_CAP = 40000; // chars per repo diff
const FILE_CAP = 10000; // chars per untracked or loose file
const FILES_CAP = 40000; // chars of file contents per repo

export interface RepoState {
  path: string; // relative to the working directory
  changed: boolean;
}

function findRepos(dir: string, depth: number, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === ".git")) {
    out.push(dir);
    return;
  }
  if (depth >= MAX_DEPTH) return;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) findRepos(path.join(dir, e.name), depth + 1, out);
  }
}

/** Contents of a small text file, or null for binary or large files. */
function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > FILE_CAP) return null;
    const b = fs.readFileSync(file);
    return b.subarray(0, 8000).includes(0) ? null : b.toString("utf8");
  } catch {
    return null;
  }
}

function filesSection(root: string, rels: string[]): string {
  let out = "";
  let budget = FILES_CAP;
  for (const rel of rels) {
    const text = readText(path.join(root, rel));
    if (text === null || text.length > budget) {
      out += `\n${rel}: (not shown: binary, large, or over the size budget)\n`;
      continue;
    }
    budget -= text.length;
    out += `\n${rel}:\n${fence(text)}`;
  }
  return out;
}

export function describeFinalState(workdir: string, env: NodeJS.ProcessEnv): { text: string; repos: RepoState[] } {
  const git = (cwd: string, ...args: string[]) => {
    const p = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, env, encoding: "utf8", maxBuffer: 64 << 20 });
    return { ok: p.status === 0, out: (p.stdout ?? "") + (p.status === 0 ? "" : p.stderr ?? "") };
  };
  const dirs: string[] = [];
  findRepos(workdir, 0, dirs);
  const repos: RepoState[] = [];
  let text = "";

  for (const dir of dirs) {
    const rel = path.relative(workdir, dir) || ".";
    const upstream = git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    const base = upstream.ok ? upstream.out.trim() : "HEAD";
    const status = git(dir, "status", "--short", "--branch").out;
    const commits = base !== "HEAD" ? git(dir, "log", "--oneline", `${base}..HEAD`).out : "";
    const diff = git(dir, "diff", base).out;
    const untracked = git(dir, "ls-files", "--others", "--exclude-standard").out.split("\n").filter(Boolean);
    repos.push({ path: rel, changed: !!(commits.trim() || diff.trim() || untracked.length) });
    text += `## Repo ${rel}\n\ngit status:\n${fence(status || "(clean)")}`;
    if (commits.trim()) text += `\nCommits made since ${base}:\n${fence(commits)}`;
    text += `\ngit diff ${base} (committed and uncommitted changes to tracked files):\n${fence(clip(diff, DIFF_CAP) || "(none)", "diff")}`;
    if (untracked.length) text += `\nUntracked files:\n${filesSection(dir, untracked)}`;
    text += "\n";
  }

  // Files in the working directory outside any repo (e.g. an example script the agent wrote).
  const loose: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 1 && !dirs.includes(abs) && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) walk(abs, depth + 1);
      } else if (e.isFile()) loose.push(path.relative(workdir, abs));
    }
  };
  walk(workdir, 0);
  const top = fs.readdirSync(workdir, { withFileTypes: true }).map((e) => e.name + (e.isDirectory() ? "/" : "")).sort();
  text = `Top level of the working directory: ${top.join(", ") || "(empty)"}\n\n` + text;
  if (loose.length) text += `## Files outside any repo\n${filesSection(workdir, loose)}`;
  if (!dirs.length) text += "No git repos found in the working directory.\n";
  return { text, repos };
}
