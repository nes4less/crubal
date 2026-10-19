// defs.ts: facet, class and kind definitions (spec chapters 4, 5 and 11.2), read from the long form and
// the shorthand into one model. The Reader uses only a facet's type, how many, unit, words, children and
// identity; the Dictionary level uses the rest.

import type { UnitsTable } from "./units.ts";
import { CrubalError, type Node, readTree } from "./tree.ts";
import { readList, splitTop } from "./lex.ts";
import { unitOf } from "./units.ts";

/** The table's unit for a spelling (`hr` → `h`); a currency, `currency` or an unknown word as written. */
const canonicalUnit = (u: string) => unitOf(u) ?? u;

export const TYPES = ["text", "number", "date", "time", "yes-no", "choice", "link", "image", "compound"] as const;
export type FacetType = (typeof TYPES)[number];
export type Precision = "year" | "month" | "day" | "hour" | "minute" | "second" | "any";

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
  // date, time
  precision?: Precision;
  /** date: `local` for wall-clock dates with no offset (1.4.5). */
  zone?: string;
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
  /** A state facet (4.2): a later value of equal or higher trust replaces the current one instead of conflicting. */
  transitions?: boolean;
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
  /** Which photo slot an image fills (5.3.3). */
  frame?: string;
};

export type PartSlot = { slot: string; wears: string; many: boolean; fungible: boolean; match?: string; line: number };

export type ClassDef = {
  name: string;
  line: number;
  label?: string;
  describe?: string;
  for: string[];
  uses: string[];
  lines: ClassLine[];
  parts: PartSlot[];
  state?: "candidate" | "active" | "retired";
  version?: string;
};

/** A kind as declared (11.2), beyond what the engine indexes by level. */
export type KindDef = { name: string; line: number; levels: string[]; base?: string; schema?: string | { [level: string]: string }; follows?: { [facet: string]: string } };

export type Dictionary = {
  facets: Map<string, Facet>;
  classes: Map<string, ClassDef>;
  /** kind name → its declaration (11.2) */
  kinds: Map<string, KindDef>;
  /** level name → kind name */
  levels: Map<string, string>;
  /** level name → the facets that vary at the step into it (11.2) */
  vary: Map<string, Set<string>>;
  /** level name → the line its vary step was written at, for a refusal */
  varyLines: Map<string, number>;
  /** The package's trust order and facets' own orders (11.3); empty means the default order. */
  trust: string[];
  facetTrust: Map<string, string[]>;
  /** level name → the strong keys an arrival is bound by (11.2 `identify`) */
  identify: Map<string, string[]>;
  /** level name → the weak key groups that propose candidates (11.2 `match`); each group is all-of */
  match: Map<string, string[][]>;
  /** kind name → `independent`, `cascade of`, `cascade within` or `cascade both` (11.2 `archive`) */
  archive: Map<string, string>;
  /** The units table this dictionary reads with (11.9): the standard table plus the owner's extension; absent, the process's. */
  units?: UnitsTable;
};

export function emptyDictionary(): Dictionary {
  const d: Dictionary = { facets: new Map(), classes: new Map(), kinds: new Map(), levels: new Map(), vary: new Map(), varyLines: new Map(), trust: [], facetTrust: new Map(), identify: new Map(), match: new Map(), archive: new Map() };
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
  // The core's list facet (12.2): a hand-made list holds ordered links to the records it shows.
  const items = blank("crubal:items", "link");
  items.many = true;
  items.pick = "any";
  items.ordered = true;
  items.label = "Items";
  d.facets.set("crubal:items", items);
  // The core's read-through link (7.8 observed): the presenter's record this one reads, never copied.
  const observes = blank("crubal:observes", "link");
  observes.label = "Observes";
  d.facets.set("crubal:observes", observes);
  return d;
}

export function blank(key: string, type: FacetType): Facet {
  return { key, type, many: false, pick: "1", ordered: false, aliases: [], sameAs: [], qualifiers: [], accepts: [], extra: {} };
}

const KEY = /^(?:[a-z][a-z0-9-]*:)?[A-Za-z_]\w*/;
const PRECISION: { [mark: string]: Precision } = {
  y: "year", ym: "month", ymd: "day", ymdh: "hour", ymdhm: "minute", ymdhms: "second", any: "any", "": "any",
  hm: "minute", hms: "second",
};

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

/** A quoted value's text (2.5); an unquoted one as it is. */
export const unquote = (s: string) => (s.startsWith('"') ? (JSON.parse(s) as string) : s);

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
type Parsed = { facet: Facet; marked: boolean; count: string | null; whenText?: string; level?: string; required: boolean; frame?: string };

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
    if (unit) facet.unit = canonicalUnit(unit[0]);
    rest = rest.slice(1 + (unit?.[0].length ?? 0));
  } else if (mark === "@") {
    // The letters run y, m, d, h, m, s: `@ymdhm` is a date with a time to the minute, `@hm` a time of day.
    const p = rest.slice(1).match(/^(ymdhms|ymdhm|ymdh|ymd|ym|y|hms|hm|any)?/)?.[0] ?? "";
    facet.type = p.startsWith("h") ? "time" : "date";
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
  let frame: string | undefined;
  for (let i = 0; i < tails.length; i++) {
    const t = tails[i] as string;
    if (t === "frame:") {
      // Placement (5.3.3): which photo slot an image fills; a class line's setting, never the facet's.
      frame = tails[++i];
      continue;
    }
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
  return { facet, marked, count, whenText, level, required, ...(frame ? { frame } : {}) };
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
      // A unit is a spelling (4.2); the definition keeps the table's unit so values convert and compare by it.
      f.unit = canonicalUnit(v);
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
    case "zone":
      if (v !== "local") throw new CrubalError(`zone is "local" or absent, not ${v}`, line);
      f.zone = v;
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
      f.accepts.push(...readList(v, line).map((p) => canonicalUnit(p.text)));
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
    case "transitions":
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
  // A line narrows; it never sets what the facet means (5.3.1).
  const meaning = ["label", "ask", "describe"].find((k) => (f as unknown as { [k: string]: unknown })[k] !== undefined) ?? (f.aliases.length ? "aliases" : f.sameAs.length ? "same-as" : f.values?.some((v) => v.aliases.length) ? "value aliases" : undefined);
  if (meaning) throw new CrubalError(`the class line ${text.trim()} sets ${meaning}, which is the facet's meaning, not a narrowing`, line);
  const cl: ClassLine = { facet: f.key, line, text: text.trim() };
  if (p.required) cl.required = true;
  if (p.level) cl.level = p.level;
  if (p.whenText) cl.when = p.whenText;
  if (p.frame) cl.frame = p.frame;
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
        c.label = unquote(child.value);
        break;
      case "describe":
        c.describe = unquote(child.value);
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

const SKIP = new Set(["rule", "contract", "view", "shape", "filter", "role", "migration", "package", "resolve", "permissions", "ownership", "emergency", "edge", "instructions", "utility"]);

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
        for (const level of names) {
          // Level names are unique across the kinds of one package (1.2), so a level names its kind.
          const had = into.levels.get(level);
          if (had && had !== kind) throw new CrubalError(`${level} is already a level of ${had}`, levels?.line ?? node.line);
          into.levels.set(level, kind);
        }
        const def: KindDef = { name: kind, line: node.line, levels: names };
        const base = node.children.find((c) => c.key === "base");
        if (base) def.base = base.value.trim();
        const schema = node.children.find((c) => c.key === "schema");
        if (schema) def.schema = schema.children.length ? Object.fromEntries(schema.children.filter((c) => c.key).map((c) => [c.key as string, c.value.trim()])) : schema.value.trim();
        const follows = node.children.find((c) => c.key === "follows");
        if (follows) def.follows = Object.fromEntries(follows.children.filter((c) => c.key).map((c) => [c.key as string, c.value.trim()]));
        into.kinds.set(kind, def);
        const vary = node.children.find((c) => c.key === "vary");
        for (const step of vary?.children ?? []) {
          if (!step.key) continue;
          const set = into.vary.get(step.key) ?? new Set<string>();
          for (const k of splitTop(step.value, ",", step.line)) if (k) set.add(k);
          into.vary.set(step.key, set);
          into.varyLines.set(step.key, step.line);
        }
        // Arrival keys (9.2a) and the archive cascade (1.12).
        const identify = node.children.find((c) => c.key === "identify");
        for (const l of identify?.children ?? []) if (l.key) into.identify.set(l.key, splitTop(l.value, ",", l.line).filter(Boolean));
        const match = node.children.find((c) => c.key === "match");
        for (const l of match?.children ?? []) {
          if (!l.key) continue;
          const groups = l.value.split(";").map((g) => g.split("+").map((k) => k.trim()).filter(Boolean)).filter((g) => g.length);
          into.match.set(l.key, groups);
        }
        const archive = node.children.find((c) => c.key === "archive");
        if (archive) {
          const a = archive.value.trim();
          if (!["independent", "cascade of", "cascade within", "cascade both"].includes(a)) throw new CrubalError(`archive is independent, cascade of, cascade within or cascade both, not ${a}`, archive.line);
          into.archive.set(kind, a);
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
