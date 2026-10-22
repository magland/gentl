import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

const enc = new Tiktoken(o200k_base);

/** Tokens in text (o200k_base). Special-token strings are counted as plain text. */
export function ntok(text: string): number {
  return enc.encode(text, [], []).length;
}
