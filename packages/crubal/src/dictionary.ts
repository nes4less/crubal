// dictionary.ts: the Dictionary level (spec chapters 4 and 5). Definitions as JSON (4.6), the publish
// checks on definitions and classes (4.7, 5.10), class resolution by meet (5.4), alias folding (4.3), and
// checking each value against its facet and the classes its record wears (4.9, 5.3, 5.5, 5.6).

import { type Truth, evaluate, parseCondition } from "./conditions.ts";
import type { ClassDef, ClassLine, Dictionary, Facet } from "./defs.ts";
import type { Json, JsonObject, Record } from "./model.ts";
import { itemText } from "./print-text.ts";
import { readUnder } from "./read-text.ts";
import { CrubalError } from "./tree.ts";
import { convert, unitOf } from "./units.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A fold key (4.3): NFC, case-folded, trimmed, inner white space made one space. */
export function foldKey(s: string): string {
  return s.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ");
}

// ─── Definitions as JSON (4.6) ────────────────────────────────────────────────

export function facetJson(f: Facet): JsonObject {
  const o: JsonObject = { facet: f.key, type: f.type };
  const put = (k: string, v: Json | undefined, skip?: Json) => {
    if (v === undefined || v === skip) return;
    if (Array.isArray(v) && v.length === 0) return;
    o[k] = v;
  };
  put("label", f.label);
  put("ask", f.ask);
  put("describe", f.describe);
  put("pick", f.pick, "1");
  put("ordered", f.ordered || undefined);
  put("state", f.state, "active");
  put("qualifiers", f.qualifiers);
  put("aliases", f.aliases);
  put("same-as", f.sameAs);
  put("agree-by", f.agreeBy);
  put("length", f.length === undefined ? undefined : String(f.length));
  put("unit", f.unit);
  put("accepts", f.accepts);
  if (f.range) o.range = { ...f.range };
  put("places", f.places === undefined ? undefined : String(f.places));
  put("precision", f.precision, "any");
  if (f.words) o.words = [...f.words];
  if (f.values) o.values = f.values.map((v): JsonObject => (v.aliases.length ? { value: v.value, aliases: [...v.aliases] } : { value: v.value }));
  put("open", f.open || undefined);
  for (const k of ["fixed", "ranked", "scored", "required", "na", "unique"] as const) put(k, f[k] || undefined);
  put("to", f.to);
  if (f.children) o.facets = [...f.children.values()].map(facetJson);
  put("identity", f.identity);
  put("when", f.when);
  put("combine", f.combine);
  put("version", f.version);
  for (const [k, v] of Object.entries(f.extra)) o[k] = v;
  return o;
}

// ─── Publish checks (4.7, 5.10) ──────────────────────────────────────────────

export type Warning = { line: number; message: string };

function checkFacet(f: Facet) {
  const line = f.line;
  if (f.type === "choice" && !f.values?.length) throw new CrubalError(`the choice facet ${f.key} has no values`, line);
  if (f.type === "compound" && !f.children?.size) throw new CrubalError(`the compound facet ${f.key} has no children`, line);
  if (f.open && f.fixed) throw new CrubalError(`the list of ${f.key} is both open and fixed`, line);
  if ((f.ranked || f.scored || f.fixed || f.open) && f.type !== "choice") {
    throw new CrubalError(`${f.key}: ranked, scored, fixed and open lists are for choice facets`, line);
  }
  if (f.ordered && !f.many) throw new CrubalError(`${f.key} is ordered but holds one value`, line);
  if (f.accepts.length && !f.unit) throw new CrubalError(`${f.key} accepts other units but has no unit`, line);
  if (f.range && Number(f.range.min) > Number(f.range.max)) throw new CrubalError(`${f.key}'s range runs backwards`, line);
  if (f.identity) {
    const child = f.children?.get(f.identity);
    if (!child) throw new CrubalError(`the identity child ${f.identity} of ${f.key} isn't one of its children`, line);
    if (child.type !== "link") throw new CrubalError(`the identity child ${f.identity} of ${f.key} is not a link`, line);
  }
  const seen = new Map<string, string>();
  for (const v of f.values ?? []) {
    for (const spelling of [v.value, ...v.aliases]) {
      const k = foldKey(spelling);
      const owner = seen.get(k);
      if (owner !== undefined && owner !== v.value) {
        throw new CrubalError(`${f.key}: the spelling ${spelling} folds to the same as ${owner}`, line);
      }
      seen.set(k, v.value);
    }
  }
  for (const c of f.children?.values() ?? []) {
    if (["row", "origin", "via", "owner"].includes(c.key)) throw new CrubalError(`${f.key} has a child named ${c.key}, which is reserved`, line);
    checkFacet(c);
  }
}

/** Run every publish check on a dictionary. Throws the first error; returns warnings. */
export function checkPackage(dict: Dictionary): Warning[] {
  const warnings: Warning[] = [];
  const keys = new Map<string, string>();
  for (const f of dict.facets.values()) {
    if (f.key.startsWith("crubal:")) continue;
    checkFacet(f);
    for (const spelling of [f.key, ...f.aliases]) {
      const k = foldKey(spelling);
      const owner = keys.get(k);
      if (owner !== undefined && owner !== f.key) {
        const what = spelling === f.key ? `the key ${f.key}` : `the alias ${spelling} of ${f.key}`;
        throw new CrubalError(`${what} folds to ${owner === k ? "the key" : "an alias"} of ${owner}`, f.line);
      }
      keys.set(k, f.key);
    }
  }
  for (const c of dict.classes.values()) {
    for (const l of c.lines) checkClassLine(c, l, dict);
    for (const slot of c.parts) {
      if (!dict.classes.has(slot.wears)) throw new CrubalError(`the part slot ${slot.slot} wears ${slot.wears}, which isn't a class`, slot.line);
    }
  }
  for (const c of dict.classes.values()) {
    findCycle(c.name, dict, []);
    resolve(dict, [c.name], c.line);
    warnings.push(...redundantLines(c, dict));
  }
  return warnings;
}

function checkClassLine(c: ClassDef, l: ClassLine, dict: Dictionary) {
  const f = dict.facets.get(l.facet);
  if (!f) throw new CrubalError(`the class line ${l.text} names a facet that isn't defined`, l.line);
  if (f.state === "candidate") throw new CrubalError(`${f.key} is a candidate; a class line can only name an active facet`, l.line);
  if (f.state === "retired") throw new CrubalError(`${f.key} is retired; a class line can only name an active facet`, l.line);
  const type = (l as ClassLine & { type?: string }).type;
  if (type && type !== f.type) throw new CrubalError(`the class line ${l.text} marks ${f.key} as ${type}, but it is ${f.type}`, l.line);
  if (l.values) {
    const real = new Set((f.values ?? []).map((v) => v.value));
    const extra = l.values.filter((v) => !real.has(v));
    if (extra.length) throw new CrubalError(`the class line ${l.text} widens ${f.key}: ${extra.join(", ")} is not one of its values`, l.line);
  }
  if (l.length !== undefined && f.length !== undefined && l.length > f.length) throw new CrubalError(`the class line ${l.text} widens ${f.key}'s length`, l.line);
  if (l.pick && f.pick !== "any" && (l.pick === "any" || Number(l.pick) > Number(f.pick))) throw new CrubalError(`the class line ${l.text} widens ${f.key}'s pick`, l.line);
  if (l.range && f.range && (Number(l.range.min) < Number(f.range.min) || Number(l.range.max) > Number(f.range.max))) {
    throw new CrubalError(`the class line ${l.text} widens ${f.key}'s range`, l.line);
  }
  if (l.when) parseCondition(l.when, l.line);
  void c;
}

function findCycle(name: string, dict: Dictionary, path: string[]) {
  if (path.includes(name)) {
    const loop = path.slice(path.indexOf(name));
    const first = dict.classes.get(loop[0] as string);
    throw new CrubalError(`the classes ${loop.join(" and ")} use each other`, first?.line);
  }
  const c = dict.classes.get(name);
  if (!c) return;
  for (const u of c.uses) {
    if (!dict.classes.has(u)) throw new CrubalError(`${name} uses ${u}, which isn't a class`, c.line);
    findCycle(u, dict, [...path, name]);
  }
}

// ─── Resolution by meet (5.4) ────────────────────────────────────────────────

export type ResolvedLine = {
  facet: string;
  required?: boolean;
  values?: string[];
  length?: number;
  pick?: string;
  range?: { min: string; max: string };
  levels: string[];
  when?: string;
  section?: string;
  /** Every line that contributed, as `Class: line`, in resolution order. */
  from: { cls: string; line: ClassLine }[];
};

function order(dict: Dictionary, names: string[], seen = new Set<string>()): ClassDef[] {
  const out: ClassDef[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    const c = dict.classes.get(n);
    if (!c) continue;
    seen.add(n);
    out.push(...order(dict, c.uses, seen), c);
  }
  return out;
}

/** Resolve the meet of classes (a class with its uses, or everything a record wears). */
export function resolve(dict: Dictionary, names: string[], line?: number): ResolvedLine[] {
  const lines = new Map<string, ResolvedLine>();
  for (const c of order(dict, names)) {
    for (const l of c.lines) {
      const f = dict.facets.get(l.facet);
      let r = lines.get(l.facet);
      if (!r) {
        r = { facet: l.facet, levels: [], from: [] };
        if (l.section) r.section = l.section;
        lines.set(l.facet, r);
      }
      r.from.push({ cls: c.name, line: l });
      if (l.required) r.required = true;
      if (l.level && !r.levels.includes(l.level)) r.levels.push(l.level);
      if (l.when) r.when = r.when ? `(${r.when}) and (${l.when})` : l.when;
      if (l.values) {
        const base = r.values ?? (f?.values ?? []).map((v) => v.value);
        const next = base.filter((v) => l.values?.includes(v));
        if (!next.length) {
          const others = r.from.filter((x) => x.line.values && x.cls !== c.name).map((x) => x.cls);
          throw new CrubalError(
            `${names.join(", ")} allows no value of ${l.facet}: ${[...new Set([...others, c.name])].join(" and ")} have nothing in common`,
            line ?? l.line,
          );
        }
        r.values = next;
      }
      if (l.length !== undefined) r.length = Math.min(r.length ?? Number.POSITIVE_INFINITY, l.length);
      if (l.pick) r.pick = r.pick && r.pick !== "any" && (l.pick === "any" || Number(r.pick) < Number(l.pick)) ? r.pick : l.pick;
      if (l.range) {
        const min = r.range ? String(Math.max(Number(r.range.min), Number(l.range.min))) : l.range.min;
        const max = r.range ? String(Math.min(Number(r.range.max), Number(l.range.max))) : l.range.max;
        r.range = { min, max };
      }
    }
  }
  return [...lines.values()];
}

/** A resolved class as JSON, as the corpus states it. */
export function resolvedJson(lines: ResolvedLine[]): JsonObject[] {
  return lines.map((r) => {
    const o: JsonObject = { facet: r.facet };
    if (r.required) o.required = true;
    if (r.values) o.values = r.values;
    if (r.length !== undefined) o.length = String(r.length);
    if (r.pick) o.pick = r.pick;
    if (r.range) o.range = r.range;
    if (r.levels.length === 1) o.level = r.levels[0] as string;
    else if (r.levels.length > 1) o.levels = r.levels;
    if (r.when) o.when = r.when;
    return o;
  });
}

function redundantLines(c: ClassDef, dict: Dictionary): Warning[] {
  const inherited = new Map(resolve(dict, c.uses).map((r) => [r.facet, r]));
  const out: Warning[] = [];
  for (const l of c.lines) {
    if (!inherited.has(l.facet)) continue;
    const narrows = l.required || l.values || l.length !== undefined || l.pick || l.range || l.level || l.when;
    if (!narrows) out.push({ line: l.line, message: `${c.name} restates ${l.facet}, which a used class already asks for` });
  }
  return out;
}

// ─── Folding (4.3) ───────────────────────────────────────────────────────────

function keyIndex(dict: Dictionary): Map<string, string> {
  const idx = new Map<string, string>();
  for (const f of dict.facets.values()) {
    for (const s of [f.key, ...f.aliases]) idx.set(foldKey(s), f.key);
  }
  return idx;
}

function foldChoice(f: Facet, v: Json): Json {
  if (typeof v === "string" && f.values) {
    const k = foldKey(v);
    for (const cv of f.values) if ([cv.value, ...cv.aliases].some((s) => foldKey(s) === k)) return cv.value;
    return v;
  }
  if (isObj(v) && "$value" in v) return { ...v, $value: foldChoice(f, v.$value as Json) };
  return v;
}

function foldQuantity(f: Facet, v: Json): Json {
  if (!isObj(v) || !("$qty" in v) || !f.unit) return v;
  const from = unitOf(String(v.unit)) ?? String(v.unit);
  if (from === f.unit) return from === v.unit ? v : { $qty: v.$qty as Json, unit: from };
  if (!f.accepts.includes(from) && !f.accepts.includes(String(v.unit))) return v;
  const amount = convert(String(v.$qty), from, f.unit, f.places);
  return amount === null ? v : { $qty: amount, unit: f.unit };
}

function foldValue(f: Facet, v: Json, dict: Dictionary): Json {
  if (Array.isArray(v)) return v.map((x) => foldValue(f, x, dict));
  if (f.type === "choice") return foldChoice(f, v);
  if (f.type === "number") return foldQuantity(f, v);
  if (f.type === "compound" && isObj(v)) return foldFields(v, f.children ?? new Map(), dict);
  return v;
}

function foldFields(obj: JsonObject, within: Map<string, Facet> | null, dict: Dictionary): JsonObject {
  const idx = within ? new Map([...within.keys()].map((k) => [foldKey(k), k])) : keyIndex(dict);
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(obj)) {
    const lookup = within ?? dict.facets;
    let key = k;
    let value = v;
    let f = lookup.get(k);
    if (!f) {
      const real = idx.get(foldKey(k));
      const rf = real ? lookup.get(real) : undefined;
      if (real && rf && typeof v === "string") {
        key = real;
        f = rf;
        value = readUnder(rf, v, dict) ?? v;
      }
    }
    out[key] = f ? foldValue(f, value, dict) : value;
  }
  return out;
}

/** Fold a record: key aliases, value aliases and accepted units become real names (chapter 4.3). */
export function foldRecord(r: Record, dict: Dictionary): Record {
  const out: Record = { ...r, values: foldFields(r.values, null, dict) };
  if (r.parts) {
    out.parts = r.parts.map((p) => (isObj(p) && isObj(p.values) ? { ...p, values: foldFields(p.values, null, dict) } : p));
  }
  return out;
}

// ─── Checking values (4.9, 5.3, 5.5, 5.6) ────────────────────────────────────

export type Outcome = { [key: string]: Json };

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

function core(v: Json): Json {
  return isObj(v) && "$value" in v ? (v.$value as Json) : v;
}

function precisionOf(d: string): "year" | "month" | "day" {
  return d.length === 4 ? "year" : d.length === 7 ? "month" : "day";
}

/** Check one scalar against its facet: an outcome and an optional flag. */
function checkScalar(f: Facet, v: Json): { outcome: string; flag?: string } {
  const c = core(v);
  if (isObj(c) && "$empty" in c) return { outcome: "absorbed" };
  switch (f.type) {
    case "number": {
      let amount: string | null = null;
      if (typeof c === "string" && NUMBER.test(c) && !f.unit) amount = c;
      if (isObj(c) && "$qty" in c && c.unit === f.unit) amount = String(c.$qty);
      if (isObj(c) && "$money" in c && (f.unit === "currency" || c.currency === f.unit)) amount = String(c.$money);
      if (amount === null) return { outcome: "contradiction" };
      if (f.range && (Number(amount) < Number(f.range.min) || Number(amount) > Number(f.range.max))) return { outcome: "absorbed", flag: "range" };
      return { outcome: "absorbed" };
    }
    case "date": {
      if (typeof c !== "string" || !DATE.test(c)) return { outcome: "contradiction" };
      const want = f.precision ?? "any";
      const rank = { year: 0, month: 1, day: 2 };
      if (want !== "any" && rank[precisionOf(c)] < rank[want]) return { outcome: "absorbed", flag: "precision" };
      return { outcome: "absorbed" };
    }
    case "yes-no":
      return typeof c === "boolean" ? { outcome: "absorbed" } : { outcome: "contradiction" };
    case "link":
      return isObj(c) && "$link" in c ? { outcome: "absorbed" } : { outcome: "contradiction" };
    case "image":
      return isObj(c) && "$image" in c ? { outcome: "absorbed" } : { outcome: "contradiction" };
    case "choice": {
      if (typeof c !== "string") return { outcome: "contradiction" };
      if ((f.values ?? []).some((x) => x.value === c)) return { outcome: "absorbed" };
      return f.fixed ? { outcome: "contradiction" } : { outcome: "new" };
    }
    case "compound":
      return isObj(c) ? { outcome: "absorbed" } : { outcome: "contradiction" };
    default: {
      if (typeof c !== "string") return { outcome: "contradiction" };
      if (f.length !== undefined && [...c].length > f.length) return { outcome: "absorbed", flag: "length" };
      return { outcome: "absorbed" };
    }
  }
}

function outcome(record: string, address: string, r: { outcome: string; flag?: string }, cites?: JsonObject): Outcome {
  const o: Outcome = { record, address, outcome: r.outcome };
  if (r.flag) o.flag = r.flag;
  if (cites) o.cites = cites;
  else if (r.outcome === "contradiction") o.cites = { type: address.replace(/\[.*$/, "").split(".").at(-1) as string };
  return o;
}

function checkValue(record: string, f: Facet, key: string, v: Json, address: string, narrow: ResolvedLine | undefined): Outcome[] {
  const items = Array.isArray(v) ? v : null;
  const pickLimit = narrow?.pick ?? f.pick;
  if (items) {
    if (pickLimit !== "any" && items.length > Number(pickLimit)) {
      return [{ record, address, outcome: "contradiction", cites: { type: f.key } }];
    }
    return items.map((item) => itemOutcome(record, f, key, item, `${address}[${JSON.stringify(itemText(f, item))}]`, narrow));
  }
  return [itemOutcome(record, f, key, v, address, narrow)];
}

function citeLine(cls: string, l: ClassLine): string {
  return `${cls}: ${l.text}`;
}

function itemOutcome(record: string, f: Facet, _key: string, v: Json, address: string, narrow: ResolvedLine | undefined): Outcome {
  const base = checkScalar(f, v);
  const c = core(v);
  if (narrow?.values && typeof c === "string" && !(isObj(c) && "$empty" in c) && !narrow.values.includes(c)) {
    const by = narrow.from.find((x) => x.line.values && !x.line.values.includes(c));
    return outcome(record, address, { outcome: "contradiction" }, { rule: by ? citeLine(by.cls, by.line) : f.key });
  }
  return outcome(record, address, base);
}

function isEmptyValue(v: Json | undefined): boolean {
  return v === undefined || (isObj(v) && v.$empty === "unknown");
}

/** Check a record: every value against its facet and worn classes, required facets, and parts. */
export function checkRecord(r: Record, dict: Dictionary): { outcomes: Outcome[]; summary: Outcome } {
  const outcomes: Outcome[] = [];
  const worn = (r.wears ?? []).filter((w) => dict.classes.has(w));
  const resolved = resolve(dict, worn);
  const byFacet = new Map(resolved.map((l) => [l.facet, l]));
  const asked: string[] = [];
  const missing: string[] = [];

  for (const l of resolved) {
    let holds: Truth = true;
    if (l.when) holds = evaluate(parseCondition(l.when), r.values);
    if (holds !== true) continue;
    asked.push(l.facet);
    if (l.required && isEmptyValue(r.values[l.facet])) {
      missing.push(l.facet);
      const by = l.from.find((x) => x.line.required);
      outcomes.push({ record: r.id, address: l.facet, outcome: "incomplete", cites: { rule: by ? citeLine(by.cls, by.line) : l.facet } });
    }
  }

  for (const [key, v] of Object.entries(r.values)) {
    const f = dict.facets.get(key);
    if (!f) {
      outcomes.push({ record: r.id, address: key, outcome: "unknown" });
      continue;
    }
    outcomes.push(...checkValue(r.id, f, key, v, key, byFacet.get(key)));
  }

  const slots = worn.flatMap((w) => (dict.classes.get(w)?.parts ?? []).map((s) => ({ cls: w, s })));
  for (const p of r.parts ?? []) {
    if (!isObj(p)) continue;
    const row = String(p.$row);
    const wears = Array.isArray(p.wears) ? p.wears.map(String) : [];
    const slot = slots.find((x) => wears.includes(x.s.wears));
    const at = `parts[${row}]`;
    const cite = slot ? { type: `${slot.cls}: ${slot.s.slot}` } : undefined;
    if (slot && !slot.s.fungible && (row === `${slot.s.slot}s` || row === `${slot.s.slot}es`)) {
      outcomes.push({ record: r.id, address: at, outcome: "contradiction", cites: cite as JsonObject, reason: "plural of a non-fungible slot" });
    }
    const values = isObj(p.values) ? p.values : {};
    for (const [key, v] of Object.entries(values)) {
      const address = `${at}.${key}`;
      if (key === "crubal:count") {
        if (slot && !slot.s.fungible) {
          outcomes.push({ record: r.id, address, outcome: "contradiction", cites: cite as JsonObject, reason: "count on a non-fungible slot" });
          continue;
        }
      }
      const f = dict.facets.get(key);
      if (!f) {
        outcomes.push({ record: r.id, address, outcome: "unknown" });
        continue;
      }
      outcomes.push(...checkValue(r.id, f, key, v, address, undefined));
    }
  }

  const summary: Outcome = { record: r.id, asked, outcome: missing.length ? "incomplete" : "complete" };
  if (missing.length) summary.missing = missing;
  return { outcomes, summary };
}
