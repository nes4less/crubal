// defs.ts: what the Reader needs from definitions (spec chapter 4.2, 4.5, 11.2): each facet's type, how
// many values it holds, its unit, its yes-no words, its compound children and identity, and which kind
// each level belongs to. The Dictionary level reads the rest of a definition; the Reader keeps only this.

import { CrubalError, type Node, readTree } from "./tree.ts";
import { splitTop } from "./lex.ts";

export const TYPES = ["text", "number", "date", "yes-no", "choice", "link", "image", "compound"] as const;
export type FacetType = (typeof TYPES)[number];

export type Facet = {
  key: string;
  type: FacetType;
  many: boolean;
  ordered: boolean;
  /** number: a unit spelling, an ISO 4217 code, or "currency". */
  unit?: string;
  /** yes-no: the two words when they aren't yes and no. */
  words?: [string, string];
  /** compound: the children, and the child that identifies a row. */
  children?: Map<string, Facet>;
  identity?: string;
};

export type Dictionary = {
  facets: Map<string, Facet>;
  /** level name → kind name */
  levels: Map<string, string>;
};

export function emptyDictionary(): Dictionary {
  return { facets: new Map(), levels: new Map() };
}

const KEY = /^(?:[a-z][a-z0-9-]*:)?[A-Za-z_]\w*/;

/** Tokens of a shorthand tail list: split on spaces outside quotes, braces and parentheses. */
function tokens(s: string, line: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quoted && ch === "\\") {
      cur += ch + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "{" || ch === "(")) depth++;
    if (!quoted && (ch === "}" || ch === ")")) depth--;
    if (!quoted && depth === 0 && ch === " ") {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quoted || depth !== 0) throw new CrubalError(`an unbalanced line: ${s}`, line);
  if (cur) out.push(cur);
  return out;
}

/** The matching close for an open bracket at `start`. */
function closing(s: string, start: number, open: string, close: string, line: number): number {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quoted && ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === open) depth++;
    if (ch === close && --depth === 0) return i;
  }
  throw new CrubalError(`"${open}" is not closed in ${s}`, line);
}

/** Read one shorthand facet line (spec 4.5). */
export function readShorthand(text: string, line: number): Facet {
  let s = text.trim();
  if (s.startsWith("!")) s = s.slice(1);
  const keyMatch = s.match(KEY);
  if (!keyMatch) throw new CrubalError(`a facet line must start with a key: ${text}`, line);
  const key = keyMatch[0];
  let rest = s.slice(key.length);
  const facet: Facet = { key, type: "text", many: false, ordered: false };

  const mark = rest[0];
  if (mark === "$") {
    facet.type = "text";
    rest = rest.slice(1).replace(/^\d+/, "");
  } else if (mark === "#") {
    facet.type = "number";
    const unit = rest.slice(1).match(/^[A-Za-z%°µ/]+/);
    if (unit) facet.unit = unit[0];
    rest = rest.slice(1 + (unit?.[0].length ?? 0));
  } else if (mark === "@") {
    facet.type = "date";
    rest = rest.slice(1).replace(/^(ymd|ym|y|any)/, "");
  } else if (mark === "?") {
    facet.type = "yes-no";
    rest = rest.slice(1);
  } else if (mark === "{") {
    facet.type = "choice";
    rest = rest.slice(closing(rest, 0, "{", "}", line) + 1);
  } else if (mark === "&") {
    facet.type = "link";
    rest = rest.slice(1).replace(/^[^\s*]+/, "");
  } else if (mark === "^") {
    facet.type = "image";
    rest = rest.slice(1);
  } else if (mark === "(") {
    facet.type = "compound";
    const end = closing(rest, 0, "(", ")", line);
    facet.children = new Map();
    for (const child of tokens(rest.slice(1, end), line)) {
      const c = readShorthand(child, line);
      facet.children.set(c.key, c);
    }
    rest = rest.slice(end + 1);
  }
  const count = rest.match(/^\*(\d*)/);
  if (count) {
    facet.many = count[1] !== "1";
    rest = rest.slice(count[0].length);
  }

  const tails = tokens(rest, line);
  for (let i = 0; i < tails.length; i++) {
    const t = tails[i] as string;
    if (t.endsWith(":")) {
      applySetting(facet, t.slice(0, -1), tails[i + 1] ?? "", line);
      i++;
    } else if (/^[a-z][\w-]*$/.test(t)) {
      applySetting(facet, t, "yes", line);
    }
    // ~alias, =same-as, +combine, /version and ranges don't change how the Reader reads values.
  }
  return facet;
}

function applySetting(facet: Facet, name: string, value: string, line: number) {
  const v = value.trim();
  switch (name) {
    case "type":
      if (!(TYPES as readonly string[]).includes(v)) throw new CrubalError(`unknown type ${v}`, line);
      facet.type = v as FacetType;
      if (v === "compound" && !facet.children) facet.children = new Map();
      break;
    case "pick":
      facet.many = v !== "1";
      break;
    case "ordered":
      facet.ordered = v === "yes";
      break;
    case "unit":
      facet.unit = v;
      break;
    case "identity":
      facet.identity = v;
      break;
    case "words": {
      const [a, b] = splitTop(v, ",", line);
      if (a && b) facet.words = [JSON.parse(quote(a)), JSON.parse(quote(b))];
      break;
    }
  }
}

function quote(s: string): string {
  return s.startsWith('"') ? s : JSON.stringify(s);
}

/** Read a `facet: key` block (spec 4.2). */
function readLongForm(node: Node): Facet {
  const key = node.value.trim();
  const facet: Facet = { key, type: "text", many: false, ordered: false };
  for (const child of node.children) {
    if (child.kind !== "pair" || !child.key) continue;
    if (child.key === "facets") {
      facet.children ??= new Map();
      for (const c of child.children) {
        const f = c.kind === "pair" && c.key === "facet" ? readLongForm(c) : readShorthand(c.text, c.line);
        facet.children.set(f.key, f);
      }
      continue;
    }
    applySetting(facet, child.key, child.value, child.line);
  }
  return facet;
}

const BLOCKS = new Set(["facet", "class", "rule", "contract", "kind", "view", "shape", "filter", "role", "migration", "package", "trust", "facet-trust"]);

/** Read definition text (facets and kinds; other blocks are skipped at this level) into a dictionary. */
export function readDefinitions(source: string, into: Dictionary = emptyDictionary()): Dictionary {
  for (const node of readTree(source)) {
    if (node.kind === "pair" && node.key && BLOCKS.has(node.key)) {
      if (node.key === "facet") {
        const f = readLongForm(node);
        into.facets.set(f.key, f);
      } else if (node.key === "kind") {
        const kind = node.value.trim();
        const levels = node.children.find((c) => c.key === "levels");
        const names = levels ? splitTop(levels.value, ",", levels.line) : [kind];
        for (const level of names) into.levels.set(level, kind);
      }
      continue;
    }
    if (node.kind === "pair" && node.key && /^(crubal|owner)$/.test(node.key)) continue;
    const f = readShorthand(node.text, node.line);
    into.facets.set(f.key, f);
  }
  return into;
}
