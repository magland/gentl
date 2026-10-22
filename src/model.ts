// Model backends. "openrouter": an OpenAI-compatible chat completions endpoint (OpenRouter by default).
// "claude-code": the user's Claude Code login, through `claude -p` (see claude.ts).

import { ClaudeCodeClient } from "./claude.js";

export interface ModelConfig {
  backend: "openrouter" | "claude-code";
  model: string;
  baseUrl: string; // openrouter only
  apiKey: string; // openrouter only
}

/** One stateless call: system prompt plus one user message in, text out. */
export interface ModelClient {
  /** Whether responses are requested as structured JSON; turned off if the backend rejects it. */
  structured: boolean;
  call(system: string, user: string, signal: AbortSignal): Promise<ModelReply>;
}

export type ResponseSchema = { name: string; schema: object };

/** `cwd` is where a claude-code call runs; ideally a directory that matches the agent's working directory. */
export function createModelClient(cfg: ModelConfig, schema: ResponseSchema, log: (msg: string) => void,
  cwd?: string): ModelClient {
  return cfg.backend === "claude-code" ? new ClaudeCodeClient(cfg.model, schema, log, cwd) : new OpenAIClient(cfg, schema, log);
}

export interface ModelReply {
  text: string;
  usage: Record<string, unknown>;
}

export class Interrupted extends Error {
  constructor() {
    super("interrupted");
  }
}

export const RETRY_DELAYS_S = [2, 5, 15];

/** Wait before a retry; Ctrl-C ends the wait. */
export async function retryWait(attempt: number, why: string, signal: AbortSignal, log: (msg: string) => void) {
  const s = RETRY_DELAYS_S[attempt];
  log(`${why}; retrying in ${s} s`);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, s * 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Interrupted());
    }, { once: true });
  });
}

class OpenAIClient implements ModelClient {
  structured = true;
  private openrouter: boolean;

  /** `schema` is the JSON schema requested for responses (structured output). */
  constructor(private cfg: ModelConfig, private schema: ResponseSchema, private log: (msg: string) => void) {
    this.openrouter = cfg.baseUrl.includes("openrouter.ai");
  }

  async call(system: string, user: string, signal: AbortSignal): Promise<ModelReply> {
    for (let attempt = 0; ; attempt++) {
      let r: Response;
      try {
        r = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(this.body(system, user)),
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new Interrupted();
        if (attempt >= RETRY_DELAYS_S.length) throw new Error(`model call failed: ${(e as Error).message}`);
        await retryWait(attempt, `network error: ${(e as Error).message}`, signal, this.log);
        continue;
      }
      const raw = await r.text().catch(() => "");
      if (r.ok) {
        let d: any;
        try {
          d = JSON.parse(raw);
        } catch {
          d = { error: { message: `response is not JSON: ${raw.slice(0, 200)}` } };
        }
        if (!d.error && d.choices?.[0]?.message) {
          return { text: d.choices[0].message.content ?? "", usage: d.usage ?? {} };
        }
        if (this.structured) {
          this.fallBack(`error in response: ${JSON.stringify(d.error ?? d).slice(0, 200)}`);
          attempt--;
          continue;
        }
        if (attempt >= RETRY_DELAYS_S.length) throw new Error(`model call failed: ${JSON.stringify(d.error ?? d).slice(0, 500)}`);
        await retryWait(attempt, `error in response: ${JSON.stringify(d.error ?? d).slice(0, 200)}`, signal, this.log);
        continue;
      }
      if (this.structured && [400, 404, 422].includes(r.status)) {
        this.fallBack(`HTTP ${r.status}: ${raw.slice(0, 200)}`);
        attempt--;
        continue;
      }
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_S.length) throw new Error(`model call failed: HTTP ${r.status} ${raw.slice(0, 500)}`);
      await retryWait(attempt, `HTTP ${r.status}`, signal, this.log);
    }
  }

  private fallBack(why: string) {
    this.structured = false;
    this.log(`structured output failed (${why}); using plain text from now on`);
  }

  private body(system: string, user: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: 8000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    };
    if (this.structured) {
      body.response_format = { type: "json_schema", json_schema: { name: this.schema.name, strict: true, schema: this.schema.schema } };
    }
    if (this.openrouter) {
      body.usage = { include: true };
      // Only route to providers that honor response_format.
      if (this.structured) body.provider = { require_parameters: true };
    }
    return body;
  }

}
