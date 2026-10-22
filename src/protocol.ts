// What the agent sees and how its responses are parsed.

export type Action = { type: string; [key: string]: unknown };

export interface AgentResponse {
  notes?: unknown;
  notes_edit?: unknown;
  notes_append?: unknown;
  action: Action;
}

export const ACTION_TYPES = ["run", "write_file", "edit_file", "ask", "finish"];

export const ASK_RESULT = "No one is available to answer. Your question is recorded as a gap in the docs. Decide from the docs and code as best you can.";
export const DEFAULT_MAX_CHARS = 2000;
export const MAX_MAX_CHARS = 20000;
export const CMD_TIMEOUT_S = 300;

export function systemPrompt(workdir: string, platform: string): string {
  return `You are a newcomer to some software, carrying out a task on a ${platform} machine with internet access. Your working directory is ${workdir}; it starts empty. Tools include git, curl and w3m (\`w3m -dump URL\` renders a web page as plain text).

Treat the software as unfamiliar. Go by its docs and code, not by what you remember about it, since the version here may differ.

This is a test of how readable the software and its docs are. We count the tokens you read (every result you see, plus your notes each turn) as a proxy for the effort a human newcomer would need, and we collect what was missing or unclear. So read in a targeted way (grep, sed -n, head, --help) rather than dumping whole files or long pages. When the docs and code don't answer something you need, don't keep searching or guess silently: use the ask action, then make a reasonable decision and move on. A gap in the docs is useful feedback, not a failure on your part.

You have no memory between turns. Each turn you see only the task, your notes, and your last action with its result (shown once). Your notes are your working memory, like what a person can hold in their head at once: keep them small, with only what you still need (key facts, where things are, what is done, what is next). They are counted every turn.

Each turn, respond with one JSON object and nothing else:
{"notes": "...", "notes_edit": {"old": "...", "new": "..."}, "notes_append": "...", "action": {...}}
Only "action" is required. "notes" replaces your notes, "notes_edit" replaces text that occurs exactly once in them, and "notes_append" adds a line at the end; they are applied in that order. Leave all three out to keep your notes unchanged.

Actions:
- {"type": "run", "cmd": "..."}: run with bash in your working directory. Each command starts a fresh shell (cd and exported variables do not persist) with no input. stdout and stderr are combined; output longer than ${DEFAULT_MAX_CHARS} characters is cut in the middle (add "max_chars": N, at most ${MAX_MAX_CHARS}, to see more). Timeout ${CMD_TIMEOUT_S} s.
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
  notes: str,
  notes_edit: obj({ old: str, new: str }, ["old", "new"]),
  notes_append: str,
  action: {
    anyOf: [
      obj({ type: actionType("run"), cmd: str, max_chars: { type: "integer" } }, ["type", "cmd"]),
      obj({ type: actionType("write_file"), path: str, content: str }, ["type", "path", "content"]),
      obj({ type: actionType("edit_file"), path: str, old: str, new: str }, ["type", "path", "old", "new"]),
      obj({ type: actionType("ask"), question: str }, ["type", "question"]),
      obj({ type: actionType("finish"), success: { type: "boolean" }, summary: str, friction: str }, ["type", "success", "summary"]),
    ],
  },
}, ["action"]);

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

/** Why the action is malformed, or null if it is fine. */
export function validateAction(a: Action): string | null {
  const str = (k: string) => typeof a[k] === "string";
  switch (a.type) {
    case "run":
      if (!str("cmd")) return 'run needs "cmd" (string)';
      if (a.max_chars !== undefined && typeof a.max_chars !== "number") return '"max_chars" must be a number';
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
    case "write_file":
    case "edit_file":
      return `${a.type}: ${a.path}`;
    case "ask":
      return `ask: ${a.question}`;
    default:
      return JSON.stringify(a);
  }
}
