// Calls to an OpenAI-compatible chat completions endpoint (OpenRouter by default).

import { RESPONSE_SCHEMA } from "./protocol.js";

export interface ModelConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
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

const RETRY_DELAYS_S = [2, 5, 15];

export class ModelClient {
  /** Whether responses are requested as structured JSON; turned off if the endpoint rejects it. */
  structured = true;
  private openrouter: boolean;

  constructor(private cfg: ModelConfig, private log: (msg: string) => void) {
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
        await this.wait(attempt, `network error: ${(e as Error).message}`, signal);
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
        await this.wait(attempt, `error in response: ${JSON.stringify(d.error ?? d).slice(0, 200)}`, signal);
        continue;
      }
      if (this.structured && [400, 404, 422].includes(r.status)) {
        this.fallBack(`HTTP ${r.status}: ${raw.slice(0, 200)}`);
        attempt--;
        continue;
      }
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= RETRY_DELAYS_S.length) throw new Error(`model call failed: HTTP ${r.status} ${raw.slice(0, 500)}`);
      await this.wait(attempt, `HTTP ${r.status}`, signal);
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
      body.response_format = { type: "json_schema", json_schema: { name: "turn", strict: true, schema: RESPONSE_SCHEMA } };
    }
    if (this.openrouter) {
      body.usage = { include: true };
      // Only route to providers that honor response_format.
      if (this.structured) body.provider = { require_parameters: true };
    }
    return body;
  }

  private async wait(attempt: number, why: string, signal: AbortSignal) {
    const s = RETRY_DELAYS_S[attempt];
    this.log(`${why}; retrying in ${s} s`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, s * 1000);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Interrupted());
      }, { once: true });
    });
  }
}
