// lex.ts: the spellings of a value in the text form (spec chapter 2.4–2.7): quoting with the JSON string
// syntax, `[ … ]` detail after a value, and short lists separated by commas. Nothing here knows facets;
// read-text.ts gives the pieces their meaning.

import { CrubalError } from "./tree.ts";

/** One value as written: its main text, whether it was quoted, and its detail pairs. */
export type Piece = {
  /** The main text, unquoted (escapes decoded when it was quoted). */
  text: string;
  quoted: boolean;
  /** Detail pairs in written order; each value is itself a piece without detail. */
  detail: [string, Piece][];
};

/** Find the end of a quoted string starting at `start` (the opening quote). Returns the closing index. */
function closeQuote(s: string, start: number, line?: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === '"') return i;
  }
  throw new CrubalError(`a quote is not closed in ${s}`, line);
}

/** Split on `sep` characters that sit outside quotes and brackets. */
export function splitTop(s: string, sep: string, line?: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === '"') {
      const end = closeQuote(s, i, line);
      cur += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0 && ch === sep) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (depth > 0) throw new CrubalError(`a "[" is not closed in ${s}`, line);
  out.push(cur.trim());
  return out;
}

/** Decode one scalar spelling: a quoted JSON string, or the text as written. */
function scalar(raw: string, line?: number): { text: string; quoted: boolean } {
  const t = raw.trim();
  if (t.startsWith('"')) {
    const end = closeQuote(t, 0, line);
    if (end !== t.length - 1) throw new CrubalError(`text after a closing quote in ${t}`, line);
    try {
      return { text: JSON.parse(t) as string, quoted: true };
    } catch {
      throw new CrubalError(`a quoted value isn't valid: ${t}`, line);
    }
  }
  return { text: t, quoted: false };
}

/** Read one value with its optional detail: `PG-13 [region: US]`. */
export function readPiece(raw: string, line?: number): Piece {
  const t = raw.trim();
  // A detail is the last top-level `[ … ]`, after a space, ending the value.
  let detailAt = -1;
  if (t.endsWith("]")) {
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (ch === '"') {
        i = closeQuote(t, i, line);
        continue;
      }
      if (ch === "[") {
        if (depth === 0 && (i === 0 || t[i - 1] === " ")) detailAt = i;
        depth++;
      }
      if (ch === "]") depth--;
    }
    if (depth !== 0) throw new CrubalError(`a "[" is not closed in ${t}`, line);
  } else if (/\[[^\]"]*$/.test(t.replace(/"(?:\\.|[^"\\])*"/g, ""))) {
    throw new CrubalError(`a "[" is not closed in ${t}`, line);
  }
  const main = detailAt >= 0 ? t.slice(0, detailAt).trim() : t;
  const detail: [string, Piece][] = [];
  if (detailAt >= 0) {
    const inner = t.slice(detailAt + 1, -1);
    for (const part of splitTop(inner, ",", line)) {
      if (!part) continue;
      const colon = part.indexOf(": ");
      if (colon <= 0) throw new CrubalError(`a detail needs "name: value", not ${part}`, line);
      const name = part.slice(0, colon).trim();
      const value = scalar(part.slice(colon + 2), line);
      detail.push([name, { ...value, detail: [] }]);
    }
  }
  return { ...scalar(main, line), detail };
}

/** Read a short list: `Comedy, "Blu-ray, 3D", Drama`. */
export function readList(raw: string, line?: number): Piece[] {
  return splitTop(raw, ",", line).map((p) => readPiece(p, line));
}

const MARK_START = /^(&|_|\[|"|\{|\.\.\.)/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Should the printer quote this text (spec 2.5)? `inDetail` adds `]`; `otherShapes` lists spellings that
 * would read as another shape under the facet (`yes`, `-`).
 */
export function needsQuotes(text: string, inDetail = false, otherShapes: string[] = []): boolean {
  if (text === "") return true;
  if (MARK_START.test(text)) return true;
  if (text.startsWith("-") && !NUMBER.test(text)) return true;
  if (text === "n/a" || text === "N/A") return true;
  if (text.includes(": ") || text.includes(" //") || text.includes(",")) return true;
  if (inDetail && text.includes("]")) return true;
  if (/^\s|\s$/.test(text)) return true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters must be quoted
  if (/[\u0000-\u001f\u007f]/.test(text)) return true;
  if (text.endsWith(":")) return true;
  return otherShapes.includes(text);
}

/** Write text, quoted only when it needs to be. */
export function writeText(text: string, inDetail = false, otherShapes: string[] = []): string {
  return needsQuotes(text, inDetail, otherShapes) ? JSON.stringify(text) : text;
}
