/** Code block whose fence is longer than any backtick run in the text. */
export function fence(text: string, lang = ""): string {
  const runs = text.match(/`{3,}/g) ?? [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = "`".repeat(n);
  return `${f}${lang}\n${text.replace(/\n+$/, "")}\n${f}\n`;
}

/** Keep the start and end of a long text, noting how much was cut. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars / 2));
  const tail = text.slice(text.length - Math.floor(maxChars / 2));
  return `${head}\n[... ${text.length - head.length - tail.length} chars cut ...]\n${tail}`;
}
