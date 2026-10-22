// What the agent sees and how its responses are parsed.

export type Action = { type: string; [key: string]: unknown };

export interface AgentResponse {
  notes?: unknown;
  notes_edit?: unknown;
  notes_append?: unknown;
  notes_keep?: unknown;
  action: Action;
}

export const ACTION_TYPES = ["run", "read_file", "write_file", "edit_file", "ask", "finish"];
export const READ_MAX_CHARS = 20000; // a read_file result stops at a line boundary before this

export const ASK_RESULT = "No one is available to answer. Your question is recorded as a gap in the docs. Decide from the docs and code as best you can.";
export const DEFAULT_MAX_CHARS = 4000;
export const MAX_MAX_CHARS = 20000;
export const CMD_TIMEOUT_S = 300;

export function systemPrompt(workdir: string, platform: string): string {
  return `You are a newcomer to some software, carrying out a task on a ${platform} machine with internet access. Your working directory is ${workdir}; it starts empty. Tools include git, curl and w3m (\`w3m -dump URL\` renders a web page as plain text).

Treat the software as unfamiliar. Go by its docs and code, not by what you remember about it, since the version here may differ. Don't read files written for AI agents (CLAUDE.md, AGENTS.md, GEMINI.md, .cursorrules, .cursor/rules, copilot-instructions.md and the like): this test follows a human newcomer, so use what a person would read (README, docs, CONTRIBUTING, the code). Commands that name such files are refused.

This is a test of how readable the software and its docs are. We count the tokens of the results you read as a proxy for the effort a human newcomer would need, and we collect what was missing or unclear. So read in a targeted way (grep, sed -n, head, --help) rather than dumping whole files or long pages. When the docs and code don't answer something you need, don't keep searching or guess silently: use the ask action, then make a reasonable decision and move on. A gap in the docs is useful feedback, not a failure on your part.

You have no memory between turns. Each turn you see only the task, your notes, and your last action with its result. The result is shown once and is gone on the next turn; your notes are all you carry forward. They are your working memory and your record of what you have done. They start empty.

So every turn has two steps. First, update your notes with what the result (or the task, on the first turn) told you, and set "notes_keep": false; almost every result is worth at least a line (what you ran and what came of it), so set "notes_keep": true only if the result told you nothing worth keeping. Second, choose the action.

Be generous with notes. Forgetting is what costs: an agent with thin notes rereads files and reruns commands, and goes in circles. Notes of several hundred to a couple of thousand words are normal on a long task; a short note that forces you to read something again is the expensive choice. Record, specifically:
- each step you have taken and its outcome, as soon as the result confirms it (for example: "edit 1 applied to +pkg/list.m: added the --json flag at line 23; verified");
- what you have read and what it told you: file and line range or doc section, the key facts, and any exact snippets you will need again (a function signature, the lines you will edit);
- commands that worked, written out exactly, with the key part of their output; commands that failed, and why;
- your plan and the next step.
The task is shown to you every turn, above your notes, so your notes must not repeat or restate it (no Task or Goal line); record only your own decisions about it (such as which approach you chose) under Plan. A layout that stays the same from turn to turn makes this easy, with new lines appended under each heading:
Done: (each step and its outcome)
Learned: (file:lines and what they say; exact snippets)
Commands: (exact commands that worked, with key output; failures and why)
Plan: ...
Before acting, check whether your notes say it is already done or already read. Grow the notes with "notes_append" and "notes_edit" rather than rewriting them from scratch, so that nothing you still need is lost; rewrite only to reorganize, and remove things only once they are finished and will not be needed again.

You cannot hold a whole file in your notes, so don't collect one piece by piece. Instead, act on a result in the turn you see it: to change code, read the whole region you need at once and make the edit in your response to that result, copying the exact text to replace from it.

Each turn, respond with one JSON object and nothing else:
{"notes_keep": false, "notes": "...", "notes_edit": {"old": "...", "new": "..."}, "notes_append": "...", "action": {...}}
"notes_keep" and "action" are required. With "notes_keep": false, give at least one of "notes" (replaces your notes), "notes_edit" (replaces text that occurs exactly once in them) and "notes_append" (adds a line at the end); they are applied in that order. "notes_keep": true leaves your notes as they are.

Actions:
- {"type": "run", "cmd": "..."}: run with bash in your working directory. Each command starts a fresh shell (cd and exported variables do not persist) with no input. stdout and stderr are combined; output longer than ${DEFAULT_MAX_CHARS} characters is cut in the middle, keeping its start and end, and the result's first line says so (add "max_chars": N, at most ${MAX_MAX_CHARS}, to see more). Timeout ${CMD_TIMEOUT_S} s.
- {"type": "read_file", "path": "...", "start_line": N, "end_line": M}: show lines N to M of a file, numbered (both optional: the whole file, or from N to the end). It shows exactly the lines asked for and is never cut in the middle; a range over ${READ_MAX_CHARS} characters stops early and says where to go on. Use it, not cat or sed, to read files.
- {"type": "write_file", "path": "...", "content": "..."}: create or overwrite a file. Relative paths are under your working directory.
- {"type": "edit_file", "path": "...", "old": "...", "new": "..."}: replace text that occurs exactly once in the file.
- {"type": "ask", "question": "..."}: ask the maintainers something the docs and code don't tell you. No one will answer during this test; the question is recorded as feedback on the docs.
- {"type": "finish", "success": true|false, "summary": "...", "friction": "..."}: end the task. Verify your work before finishing. If success is true, the summary must cite the evidence: what you ran and what it showed. "friction" (optional) is what in the docs was missing, wrong or unclear, and where you had to guess.

A person watching may decline an action; the result then says so, with their reason if they gave one.`;
}

/** JSON schema for the response, sent to endpoints that support structured output. Each action is its own
 * variant with its fields required, since optional fields make grammar compilation slow (it timed out on Anthropic). */
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" };
const actionType = (t: string) => ({ type: "string", enum: [t] });
export const RESPONSE_SCHEMA = obj({
  notes_keep: { type: "boolean" },
  notes: str,
  notes_edit: obj({ old: str, new: str }, ["old", "new"]),
  notes_append: str,
  action: {
    anyOf: [
      obj({ type: actionType("run"), cmd: str, max_chars: { type: "integer" } }, ["type", "cmd"]),
      obj({ type: actionType("read_file"), path: str, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["type", "path"]),
      obj({ type: actionType("write_file"), path: str, content: str }, ["type", "path", "content"]),
      obj({ type: actionType("edit_file"), path: str, old: str, new: str }, ["type", "path", "old", "new"]),
      obj({ type: actionType("ask"), question: str }, ["type", "question"]),
      obj({ type: actionType("finish"), success: { type: "boolean" }, summary: str, friction: str }, ["type", "success", "summary"]),
    ],
  },
}, ["notes_keep", "action"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Index of the brace closing the object that starts at `start`, or -1. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
  }
  return -1;
}

/** The first JSON object in the text that satisfies `accept`; anything around it is ignored. */
export function parseFirstJson(text: string, accept: (v: Record<string, unknown>) => boolean): Record<string, unknown> {
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    const end = matchBrace(text, i);
    if (end === -1) continue;
    let v: unknown;
    try {
      v = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;
    }
    if (isObject(v) && accept(v)) return v;
  }
  throw new Error("no matching JSON object was found");
}

/** The first JSON object in the text that contains an "action" object. */
export function parseResponse(text: string): AgentResponse {
  try {
    return parseFirstJson(text, (v) => isObject(v.action)) as unknown as AgentResponse;
  } catch {
    throw new Error('no JSON object with an "action" object was found');
  }
}

export function countOccurrences(text: string, sub: string): number {
  return sub === "" ? 0 : text.split(sub).length - 1;
}

/** Whether the response makes a notes decision: an operation, or "notes_keep": true. */
export function hasNotesDecision(r: AgentResponse): boolean {
  return r.notes !== undefined || r.notes_edit !== undefined || r.notes_append !== undefined || r.notes_keep === true;
}

/** The reminder sent, within the same turn, when a response has no notes decision. */
export const NOTES_REMINDER = 'Your response did not update your notes or set "notes_keep": true. The result above will be gone on the next turn. Respond again with your notes update ("notes", "notes_edit" or "notes_append"), or "notes_keep": true if nothing is worth keeping, together with your action.';

/** Apply the notes operations in order (rewrite, edit, append). Problems are returned as feedback for the agent. */
export function applyNotes(notes: string, r: AgentResponse): { notes: string; ops: string[]; feedback: string[] } {
  const ops: string[] = [];
  const feedback: string[] = [];
  if (r.notes !== undefined) {
    if (typeof r.notes === "string") {
      notes = r.notes;
      ops.push("rewritten");
    } else feedback.push('"notes" must be a string; it was ignored.');
  }
  if (r.notes_edit !== undefined) {
    const e = r.notes_edit;
    if (!isObject(e) || typeof e.old !== "string" || typeof e.new !== "string") {
      feedback.push('"notes_edit" must be {"old": string, "new": string}; it was ignored.');
    } else {
      const n = countOccurrences(notes, e.old);
      if (n !== 1) feedback.push(`notes_edit failed: the old text occurs ${n} times in your notes; it must occur exactly once.`);
      else {
        const replacement = e.new;
        notes = notes.replace(e.old, () => replacement);
        ops.push("edited");
      }
    }
  }
  if (r.notes_append !== undefined) {
    if (typeof r.notes_append === "string") {
      notes = notes ? `${notes}\n${r.notes_append}` : r.notes_append;
      ops.push("appended");
    } else feedback.push('"notes_append" must be a string; it was ignored.');
  }
  return { notes, ops, feedback };
}

/** Files written for AI coding agents, which a human newcomer would not use; actions that name them are refused. */
export const AI_AGENT_FILES = /(^|[\s/'"=:(])(CLAUDE\.md|CLAUDE\.local\.md|AGENTS?\.md|GEMINI\.md|\.cursorrules|\.cursor\/rules|copilot-instructions\.md|\.windsurfrules|\.clinerules)(?=$|[\s'"/;|&)<>]|$)/i;

/** The AI-agent file an action names, if any (read_file's path, or a run command). */
export function namedAiFile(a: Action): string | null {
  const text = a.type === "read_file" ? String(a.path) : a.type === "run" ? String(a.cmd) : null;
  if (text === null) return null;
  const m = text.match(AI_AGENT_FILES);
  return m ? m[2] : null;
}

const TASK_LINE = /^\s*[-*]?\s*(task|goal)\s*:.*(\n|$)/gim;

/** Notes without lines restating the task (the agent sees the task every turn), and whether any were removed. */
export function withoutTaskLines(notes: string): { notes: string; removed: boolean } {
  const out = notes.replace(TASK_LINE, "");
  return { notes: out, removed: out !== notes };
}

/** Why the action is malformed, or null if it is fine. */
export function validateAction(a: Action): string | null {
  const str = (k: string) => typeof a[k] === "string";
  switch (a.type) {
    case "run":
      if (!str("cmd")) return 'run needs "cmd" (string)';
      if (a.max_chars !== undefined && typeof a.max_chars !== "number") return '"max_chars" must be a number';
      return null;
    case "read_file":
      if (!str("path")) return 'read_file needs "path" (string)';
      for (const k of ["start_line", "end_line"]) {
        if (a[k] !== undefined && !(Number.isInteger(a[k]) && (a[k] as number) >= 1)) return `"${k}" must be a whole number, at least 1`;
      }
      return null;
    case "write_file":
      return str("path") && str("content") ? null : 'write_file needs "path" and "content" (strings)';
    case "edit_file":
      return str("path") && str("old") && str("new") ? null : 'edit_file needs "path", "old" and "new" (strings)';
    case "ask":
      return str("question") ? null : 'ask needs "question" (string)';
    case "finish":
      if (typeof a.success !== "boolean" || !str("summary")) return 'finish needs "success" (boolean) and "summary" (string)';
      if (a.friction !== undefined && !str("friction")) return '"friction" must be a string';
      return null;
    default:
      return `unknown action type ${JSON.stringify(a.type)}; use ${ACTION_TYPES.join(", ")}`;
  }
}

/** The action as echoed back to the agent on the next turn. Files are shown by path only. */
export function describeAction(a: Action): string {
  switch (a.type) {
    case "run":
      return a.max_chars !== undefined && a.max_chars !== DEFAULT_MAX_CHARS ? `run (max_chars ${a.max_chars}): ${a.cmd}` : `run: ${a.cmd}`;
    case "read_file":
      return `read_file: ${a.path}${a.start_line !== undefined || a.end_line !== undefined ? ` (lines ${a.start_line ?? 1}-${a.end_line ?? "end"})` : ""}`;
    case "write_file":
    case "edit_file":
      return `${a.type}: ${a.path}`;
    case "ask":
      return `ask: ${a.question}`;
    default:
      return JSON.stringify(a);
  }
}
