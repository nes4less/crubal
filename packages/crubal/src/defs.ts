// defs.ts: facet, class and kind definitions (spec chapters 4, 5 and 11.2), read from the long form and
// the shorthand into one model. The Reader uses only a facet's type, how many, unit, words, children and
// identity; the Dictionary level uses the rest.

import { CrubalError, type Node, readTree } from "./tree.ts";
import { readList, splitTop } from "./lex.ts";

export const TYPES = ["text", "number", "date", "yes-no", "choice", "link", "image", "compound"] as const;
export type FacetType = (typeof TYPES)[number];
export type Precision = "year" | "month" | "day" | "any";

export type ChoiceValue = { value: string; aliases: string[] };

export type Facet = {
  key: string;
  type: FacetType;
  many: boolean;
  /** "any", or a number as a string ("1", "2"). */
  pick: string;
  ordered: boolean;
  line?: number;
  label?: string;
  ask?: string;
  describe?: string;
  state?: "candidate" | "active" | "retired";
  aliases: string[];
  sameAs: string[];
  version?: string;
  agreeBy?: string;
  qualifiers: string[];
  // text
  length?: number;
  // number
  unit?: string;
  accepts: string[];
  range?: { min: string; max: string; step?: string };
  places?: number;
  // date
  precision?: Precision;
  // yes-no
  words?: [string, string];
  // choice
  values?: ChoiceValue[];
  open?: boolean;
  fixed?: boolean;
  ranked?: boolean;
  scored?: boolean;
  // link
  to?: string;
  // compound
  children?: Map<string, Facet>;
  identity?: string;
  // shortcuts for rules (4.4)
  required?: boolean;
  na?: boolean;
  unique?: boolean;
  when?: string;
  combine?: string;
  /** Prefixed package settings, carried unchanged. */
  extra: { [key: string]: string };
};

/** A class line (5.3): a facet, how it is narrowed, and where it is placed. */
export type ClassLine = {
  facet: string;
  line: number;
  text: string;
  required?: boolean;
  values?: string[];
  length?: number;
  pick?: string;
  range?: { min: string; max: string };
  precision?: Precision;
  level?: string;
  when?: string;
  section?: string;
};

export type PartSlot = { slot: string; wears: string; many: boolean; fungible: boolean; match?: string; line: number };

export type ClassDef = {
  name: string;
  line: number;
  label?: string;
  for: string[];
  uses: string[];
  lines: ClassLine[];
  parts: PartSlot[];
  state?: "candidate" | "active" | "retired";
  version?: string;
};

export type Dictionary = {
  facets: Map<string, Facet>;
  classes: Map<string, ClassDef>;
  /** level name → kind name */
  levels: Map<string, string>;
  /** level name → the facets that vary at the step into it (11.2) */
  vary: Map<string, Set<string>>;
  /** The package's trust order and facets' own orders (11.3); empty means the default order. */
  trust: string[];
  facetTrust: Map<string, string[]>;
};

export function emptyDictionary(): Dictionary {
  const d: Dictionary = { facets: new Map(), classes: new Map(), levels: new Map(), vary: new Map(), trust: [], facetTrust: new Map() };
  // Core facets (spec 1.6, 5.6).
  d.facets.set("crubal:count", { ...blank("crubal:count", "number") });
  const notables = blank("crubal:notables", "compound");
  notables.many = true;
  notables.pick = "any";
  notables.children = new Map([
    ["key", blank("key", "text")],
    ["value", blank("value", "text")],
  ]);
  d.facets.set("crubal:notables", notables);
  return d;
}

export function blank(key: string, type: FacetType): Facet {
  return { key, type, many: false, pick: "1", ordered: false, aliases: [], sameAs: [], qualifiers: [], accepts: [], extra: {} };
}

const KEY = /^(?:[a-z][a-z0-9-]*:)?[A-Za-z_]\w*/;
const PRECISION: { [mark: string]: Precision } = { y: "year", ym: "month", ymd: "day", any: "any", "": "any" };

/** Tokens of a shorthand line: split on spaces outside quotes, braces and parentheses. */
export function tokens(s: string, line: number): string[] {
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

const unquote = (s: string) => (s.startsWith('"') ? (JSON.parse(s) as string) : s);

/** A choice list's inside: `DVD~"DVD Video"|Blu-ray~BD|...` */
function readChoices(inner: string, line: number): { values: ChoiceValue[]; open: boolean } {
  const parts = splitOutside(inner, "|", line);
  let open = false;
  const values: ChoiceValue[] = [];
  for (const p of parts) {
    if (p === "...") {
      open = true;
      continue;
    }
    const [v, ...aliases] = splitOutside(p, "~", line);
    values.push({ value: unquote(v ?? ""), aliases: aliases.map(unquote) });
  }
  return { values, open };
}

function splitOutside(s: string, sep: string, line: number): string[] {
  const out: string[] = [];
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
    if (!quoted && ch === sep) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quoted) throw new CrubalError(`a quote is not closed in ${s}`, line);
  out.push(cur.trim());
  return out;
}

/** The type mark, count and tails of a shorthand line or class line, after its key. */
type Parsed = { facet: Facet; marked: boolean; count: string | null; whenText?: string; level?: string; required: boolean };

function parseLine(text: string, line: number): Parsed {
  let s = text.trim();
  let whenText: string | undefined;
  const w = s.search(/ when /);
  if (w >= 0) {
    whenText = s.slice(w + 6).trim();
    s = s.slice(0, w).trim();
  }
  let required = false;
  if (s.startsWith("!")) {
    required = true;
    s = s.slice(1);
  }
  let level: string | undefined;
  const lv = s.match(/^([a-z]\w*)::/);
  if (lv) {
    level = lv[1];
    s = s.slice(lv[0].length);
  }
  const keyMatch = s.match(KEY);
  if (!keyMatch) throw new CrubalError(`a facet line must start with a key: ${text}`, line);
  const key = keyMatch[0];
  let rest = s.slice(key.length);
  const facet = blank(key, "text");
  facet.line = line;
  if (required) facet.required = true;
  let marked = true;

  const mark = rest[0];
  if (mark === "$") {
    const len = rest.slice(1).match(/^\d+/);
    if (len) facet.length = Number(len[0]);
    rest = rest.slice(1 + (len?.[0].length ?? 0));
  } else if (mark === "#") {
    facet.type = "number";
    const unit = rest.slice(1).match(/^[A-Za-z%°µ/]+/);
    if (unit) facet.unit = unit[0];
    rest = rest.slice(1 + (unit?.[0].length ?? 0));
  } else if (mark === "@") {
    facet.type = "date";
    const p = rest.slice(1).match(/^(ymd|ym|y|any)?/)?.[0] ?? "";
    facet.precision = PRECISION[p];
    rest = rest.slice(1 + p.length);
  } else if (mark === "?") {
    facet.type = "yes-no";
    rest = rest.slice(1);
  } else if (mark === "{") {
    facet.type = "choice";
    const end = closing(rest, 0, "{", "}", line);
    const { values, open } = readChoices(rest.slice(1, end), line);
    facet.values = values;
    if (open) facet.open = true;
    rest = rest.slice(end + 1);
  } else if (mark === "&") {
    facet.type = "link";
    const to = rest.slice(1).match(/^[^\s*]+/);
    if (to) facet.to = to[0];
    rest = rest.slice(1 + (to?.[0].length ?? 0));
  } else if (mark === "^") {
    facet.type = "image";
    rest = rest.slice(1);
  } else if (mark === "(") {
    facet.type = "compound";
    const end = closing(rest, 0, "(", ")", line);
    facet.children = new Map();
    for (const child of tokens(rest.slice(1, end), line)) {
      const c = parseLine(child, line).facet;
      facet.children.set(c.key, c);
    }
    rest = rest.slice(end + 1);
  } else {
    marked = false;
  }
  let count: string | null = null;
  const cm = rest.match(/^\*(\d*)/);
  if (cm) {
    count = cm[1] || "any";
    facet.pick = count;
    facet.many = count !== "1";
    rest = rest.slice(cm[0].length);
  }

  const tails = tokens(rest, line);
  for (let i = 0; i < tails.length; i++) {
    const t = tails[i] as string;
    if (t.startsWith("~")) facet.aliases.push(unquote(t.slice(1)));
    else if (t.startsWith("=")) facet.sameAs.push(t.slice(1));
    else if (t.startsWith("+")) facet.combine = t.slice(1);
    else if (t.startsWith("/")) facet.version = t.slice(1);
    else if (/^-?[\d.]+\.\.-?[\d.]+$/.test(t)) {
      const [min, max] = t.split("..");
      facet.range = { min: min as string, max: max as string };
      if (tails[i + 1] === "step") {
        facet.range.step = tails[i + 2];
        i += 2;
      }
    } else if (t.endsWith(":")) {
      // A value runs on after a trailing comma: `accepts: g, lb, oz`.
      let value = tails[i + 1] ?? "";
      i++;
      while (value.endsWith(",") && i + 1 < tails.length) value += ` ${tails[++i]}`;
      applySetting(facet, t.slice(0, -1), value, line);
    } else if (/^[a-z][\w-]*$/.test(t)) applySetting(facet, t, "yes", line);
    else throw new CrubalError(`unknown tail ${t} in ${text}`, line);
  }
  return { facet, marked, count, whenText, level, required };
}

/** Read one shorthand facet line (spec 4.5). */
export function readShorthand(text: string, line: number): Facet {
  const p = parseLine(text, line);
  if (p.level) throw new CrubalError("the level mark belongs to class lines, not a facet's definition", line);
  if (p.whenText) p.facet.when = p.whenText;
  return p.facet;
}

const yes = (v: string) => v === "yes" || v === "true";

function applySetting(f: Facet, name: string, value: string, line: number) {
  const v = value.trim();
  switch (name) {
    case "type":
      if (!(TYPES as readonly string[]).includes(v)) throw new CrubalError(`unknown type ${v}`, line);
      f.type = v as FacetType;
      if (v === "compound" && !f.children) f.children = new Map();
      return;
    case "pick":
      f.pick = v;
      f.many = v !== "1";
      return;
    case "ordered":
      f.ordered = yes(v);
      return;
    case "unit":
      f.unit = v;
      return;
    case "identity":
      f.identity = v;
      return;
    case "words": {
      const [a, b] = splitTop(v, ",", line);
      if (a && b) f.words = [unquote(a), unquote(b)];
      return;
    }
    case "label":
    case "ask":
    case "describe":
    case "version":
    case "to":
    case "combine":
    case "when":
      (f as unknown as { [k: string]: string })[name] = unquote(v);
      return;
    case "agree-by":
      f.agreeBy = v;
      return;
    case "state":
      if (v !== "candidate" && v !== "active" && v !== "retired") throw new CrubalError(`unknown state ${v}`, line);
      f.state = v;
      return;
    case "aliases":
      f.aliases.push(...readList(v, line).map((p) => p.text));
      return;
    case "same-as":
      f.sameAs.push(...readList(v, line).map((p) => p.text));
      return;
    case "qualifiers":
      f.qualifiers.push(...readList(v, line).map((p) => p.text));
      return;
    case "accepts":
      f.accepts.push(...readList(v, line).map((p) => p.text));
      return;
    case "length":
      f.length = Number(v);
      return;
    case "places":
      f.places = Number(v);
      return;
    case "precision":
      f.precision = v as Precision;
      return;
    case "range": {
      const m = v.match(/^(-?[\d.]+)\.\.(-?[\d.]+)(?: step (\S+))?$/);
      if (!m) throw new CrubalError(`a range is "min..max": ${v}`, line);
      f.range = { min: m[1] as string, max: m[2] as string };
      if (m[3]) f.range.step = m[3];
      return;
    }
    case "values": {
      f.values = [];
      for (const piece of splitTop(v, ",", line)) {
        if (piece === "...") {
          f.open = true;
          continue;
        }
        const [val, ...al] = splitOutside(piece, "~", line);
        f.values.push({ value: unquote(val ?? ""), aliases: al.map(unquote) });
      }
      return;
    }
    case "fixed":
    case "ranked":
    case "scored":
    case "required":
    case "na":
    case "unique":
    case "open":
      (f as unknown as { [k: string]: boolean })[name] = yes(v);
      return;
    case "fungible":
    case "match":
      return; // part-slot settings; read by the class reader
  }
  if (name.includes(":")) {
    f.extra[name] = v;
    return;
  }
  throw new CrubalError(`unknown setting ${name}`, line);
}

/** Read a `facet: key` block (spec 4.2). */
function readLongForm(node: Node): Facet {
  const f = blank(node.value.trim(), "text");
  f.line = node.line;
  for (const child of node.children) {
    if (child.kind !== "pair" || !child.key) throw new CrubalError(`expected "setting: value": ${child.text}`, child.line);
    if (child.key === "facets") {
      f.children ??= new Map();
      for (const c of child.children) {
        const cf = c.kind === "pair" && c.key === "facet" ? readLongForm(c) : readShorthand(c.text, c.line);
        f.children.set(cf.key, cf);
      }
      continue;
    }
    applySetting(f, child.key, child.value, child.line);
  }
  return f;
}

export function readClassLine(text: string, line: number, section?: string): ClassLine {
  const p = parseLine(text, line);
  const f = p.facet;
  const cl: ClassLine = { facet: f.key, line, text: text.trim() };
  if (p.required) cl.required = true;
  if (p.level) cl.level = p.level;
  if (p.whenText) cl.when = p.whenText;
  if (section) cl.section = section;
  if (p.marked) {
    (cl as ClassLine & { type?: FacetType }).type = f.type;
    if (f.values) cl.values = f.values.map((v) => v.value);
    if (f.length !== undefined) cl.length = f.length;
    if (f.precision && f.type === "date") cl.precision = f.precision;
  }
  if (p.count) cl.pick = p.count;
  if (f.range) cl.range = { min: f.range.min, max: f.range.max };
  return cl;
}

function readClass(node: Node): ClassDef {
  const c: ClassDef = { name: node.value.trim(), line: node.line, for: [], uses: [], lines: [], parts: [] };
  for (const child of node.children) {
    if (child.kind !== "pair" || !child.key) throw new CrubalError(`expected "setting: value": ${child.text}`, child.line);
    switch (child.key) {
      case "for":
        c.for = readList(child.value, child.line).map((p) => p.text);
        break;
      case "uses":
        c.uses = readList(child.value, child.line).map((p) => p.text);
        break;
      case "label":
        c.label = child.value;
        break;
      case "version":
        c.version = child.value;
        break;
      case "state":
        c.state = child.value as ClassDef["state"];
        break;
      case "facets": {
        let section: string | undefined;
        for (const l of child.children) {
          if (l.kind === "pair" && l.key === "section") {
            section = unquote(l.value);
            continue;
          }
          c.lines.push(readClassLine(l.text, l.line, section));
        }
        break;
      }
      case "parts":
        for (const l of child.children) {
          const pair = l.kind === "pair" && l.key ? { key: l.key, value: l.value } : null;
          if (!pair) throw new CrubalError(`a part slot is "slot: Class": ${l.text}`, l.line);
          const t = tokens(pair.value, l.line);
          const wears = t[0] ?? "";
          const slot: PartSlot = { slot: pair.key, wears, many: false, fungible: false, line: l.line };
          for (let i = 1; i < t.length; i++) {
            const tok = t[i] as string;
            if (tok.startsWith("*")) slot.many = tok !== "*1";
            else if (tok === "fungible:") slot.fungible = yes(t[++i] ?? "");
            else if (tok === "match:") slot.match = t[++i];
            else if (tok === "fungible") slot.fungible = true;
          }
          c.parts.push(slot);
        }
        break;
      default:
        if (!child.key.includes(":")) throw new CrubalError(`unknown class setting ${child.key}`, child.line);
    }
  }
  return c;
}

const SKIP = new Set(["rule", "contract", "view", "shape", "filter", "role", "migration", "package", "resolve"]);

/** Read definition text (facets, classes and kinds) into a dictionary. Other blocks are skipped. */
export function readDefinitions(source: string, into: Dictionary = emptyDictionary()): Dictionary {
  for (const node of readTree(source)) {
    if (node.kind === "pair" && node.key) {
      if (node.key === "facet") {
        const f = readLongForm(node);
        into.facets.set(f.key, f);
        continue;
      }
      if (node.key === "class") {
        const c = readClass(node);
        into.classes.set(c.name, c);
        continue;
      }
      if (node.key === "trust") {
        into.trust = node.children.map((c) => c.text.trim());
        continue;
      }
      if (node.key === "facet-trust") {
        for (const c of node.children) if (c.key) into.facetTrust.set(c.key, readList(c.value, c.line).map((p) => p.text));
        continue;
      }
      if (node.key === "kind") {
        const kind = node.value.trim();
        const levels = node.children.find((c) => c.key === "levels");
        const names = levels ? splitTop(levels.value, ",", levels.line) : [kind];
        for (const level of names) into.levels.set(level, kind);
        const vary = node.children.find((c) => c.key === "vary");
        for (const step of vary?.children ?? []) {
          if (!step.key) continue;
          const set = into.vary.get(step.key) ?? new Set<string>();
          for (const k of splitTop(step.value, ",", step.line)) if (k) set.add(k);
          into.vary.set(step.key, set);
        }
        continue;
      }
      if (SKIP.has(node.key) || node.key === "crubal" || node.key === "owner") continue;
    }
    const f = readShorthand(node.text, node.line);
    into.facets.set(f.key, f);
  }
  return into;
}

/** Split a case input into its definitions part and its data part (the data starts at `crubal:`). */
export function splitCaseInput(source: string): { defs: string; data: string; dataLine: number } {
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((l) => /^crubal: /.test(l));
  if (at < 0) return { defs: source, data: "", dataLine: 0 };
  // Blank the other part's lines instead of cutting them, so line numbers stay true.
  const defs = lines.map((l, i) => (i < at ? l : "")).join("\n");
  const data = lines.map((l, i) => (i >= at ? l : "")).join("\n");
  return { defs, data, dataLine: at + 1 };
}
