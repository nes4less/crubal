// conditions.ts: the condition language (spec chapter 6.3) with three-valued empties (6.3.1). A test on
// an absent or unknown value is undetermined; `-` makes a test false, except `is -`. The Dictionary level
// uses it for class lines' `when`; the Rules level for rules.

import type { Json, JsonObject } from "./model.ts";
import { CrubalError } from "./tree.ts";

export type Truth = true | false | "undetermined";

/** What a condition can know beyond values: each address's states (6.3.2). */
export type StateOf = (path: string) => Set<string>;

export const STATES = new Set(["confirmed", "contradicted", "unobserved", "conflicted", "new", "held", "adopted", "suggested"]);

export type Expr =
  | { op: "and" | "or"; a: Expr; b: Expr }
  | { op: "not"; a: Expr }
  | { op: "test"; path: string; verb: string; arg: string };

const VERBS = [" shown to ", " may ", " wears ", " is not ", " is ", " in ", " has", " before ", " after ", " over ", " under "];

/** Split on a word outside parentheses and quotes. */
function splitWord(s: string, word: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && depth === 0 && s.startsWith(word, i)) {
      out.push(cur);
      cur = "";
      i += word.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function parseCondition(text: string, line?: number): Expr {
  const s = text.trim();
  const ors = splitWord(s, " or ");
  if (ors.length > 1) return ors.map((x) => parseCondition(x, line)).reduce((a, b) => ({ op: "or", a, b }));
  const ands = splitWord(s, " and ");
  if (ands.length > 1) return ands.map((x) => parseCondition(x, line)).reduce((a, b) => ({ op: "and", a, b }));
  if (s.startsWith("not ")) return { op: "not", a: parseCondition(s.slice(4), line) };
  if (s.startsWith("(") && s.endsWith(")")) return parseCondition(s.slice(1, -1), line);
  for (const v of VERBS) {
    const at = s.indexOf(v);
    if (at > 0) return { op: "test", path: s.slice(0, at).trim(), verb: v.trim(), arg: s.slice(at + v.length).trim() };
  }
  if (s.endsWith(" has")) return { op: "test", path: s.slice(0, -4).trim(), verb: "has", arg: "" };
  throw new CrubalError(`can't read the condition "${text}"`, line);
}

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const unq = (s: string) => (s.startsWith('"') ? (JSON.parse(s) as string) : s);

/** The plain text of a value, for comparing with what a condition writes. */
function plain(v: Json): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (isObj(v)) {
    if ("$value" in v) return plain(v.$value as Json);
    if ("$link" in v) return `&${v.$link}`;
    if ("$qty" in v) return `${v.$qty}${v.unit}`;
    if ("$money" in v) return `${v.$money}${v.currency}`;
  }
  return JSON.stringify(v);
}

function emptyOf(v: Json | undefined): "absent" | "unknown" | "n/a" | null {
  if (v === undefined) return "absent";
  if (isObj(v) && "$empty" in v) return v.$empty === "unknown" ? "unknown" : "n/a";
  return null;
}

/** A path's value, including aggregates: `count of languages`, `least of prices`, `most of …`, `sum of …`. */
function valueAt(values: JsonObject, path: string): Json | undefined {
  const agg = path.match(/^(count|least|most|sum) of (.+)$/);
  if (!agg) return values[path];
  const v = values[agg[2] as string];
  const items = v === undefined || emptyOf(v) ? [] : Array.isArray(v) ? v : [v];
  if (agg[1] === "count") return String(items.length);
  if (!items.length) return undefined;
  const nums = items.map((x) => Number.parseFloat(plain(x)));
  if (agg[1] === "least") return String(Math.min(...nums));
  if (agg[1] === "most") return String(Math.max(...nums));
  return String(nums.reduce((a, b) => a + b, 0));
}

const MOMENT = /^(\d{4}-\d{2}-\d{2})T(\d{2})(?::(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/** The instant a moment names, in ms; null for a local date, a plain date or anything else. */
function instant(s: string): number | null {
  const m = s.match(MOMENT);
  if (!m || !m[5]) return null;
  return Date.parse(`${m[1]}T${m[2]}:${m[3] ?? "00"}:${m[4] ?? "00"}${m[5]}`);
}

/**
 * Compare two temporal values (6.3): moments by instant; a plain date with a moment by the moment's UTC
 * date; local dates only with local dates; times of day as clock times. Undetermined across kinds.
 */
function compareTime(a: string, b: string): number | "undetermined" {
  const ia = instant(a);
  const ib = instant(b);
  if (ia !== null && ib !== null) return Math.sign(ia - ib);
  const plain = /^\d{4}(-\d{2}(-\d{2})?)?$/;
  // A plain date against a moment: compare the moment's UTC date, cut to the plain date's precision.
  const cut = (ms: number, len: number) => new Date(ms).toISOString().slice(0, len);
  if (ia !== null && plain.test(b)) return cmp(cut(ia, b.length), b);
  if (ib !== null && plain.test(a)) return cmp(a, cut(ib, a.length));
  const localA = MOMENT.test(a) && ia === null;
  const localB = MOMENT.test(b) && ib === null;
  if (ia !== null || ib !== null) return "undetermined"; // a moment against a local date or a time of day
  if (localA !== localB) return "undetermined";
  return cmp(a, b);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function test(e: Extract<Expr, { op: "test" }>, values: JsonObject, states?: StateOf, now?: string): Truth {
  if (e.verb === "is" && STATES.has(e.arg)) return states ? states(e.path).has(e.arg) : false;
  // `caller may run listing`, `caller wears Staff` (chapter 7.6): what the caller is, not a value.
  if (e.verb === "may" || e.verb === "wears") return states ? states(e.path).has(`${e.verb}:${e.arg}`) : false;
  // `cost shown to staff` declares visibility (chapter 12.4); views apply it, so as a check it holds.
  if (e.verb === "shown to") return true;
  const v = valueAt(values, e.path);
  const empty = emptyOf(v);
  if (e.verb === "has") {
    if (empty) return false;
    if (!e.arg) return true;
    const items = Array.isArray(v) ? v : [v as Json];
    return items.some((x) => plain(x) === unq(e.arg));
  }
  if (e.verb === "is" && e.arg === "_") return empty === "unknown";
  if (e.verb === "is" && e.arg === "-") return empty === "n/a";
  if (empty === "absent" || empty === "unknown") return "undetermined";
  if (empty === "n/a") return false;
  const items = (Array.isArray(v) ? v : [v as Json]).map(plain);
  if (e.verb === "is") return items.includes(unq(e.arg));
  if (e.verb === "is not") return !items.includes(unq(e.arg));
  if (e.verb === "in") {
    const range = e.arg.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/);
    if (range) return items.some((x) => Number.parseFloat(x) >= Number(range[1]) && Number.parseFloat(x) <= Number(range[2]));
    const set = e.arg.split(",").map((x) => unq(x.trim()));
    return items.some((x) => set.includes(x));
  }
  const n = Number.parseFloat(items[0] ?? "");
  const m = Number.parseFloat(e.arg);
  if (e.verb === "over") return n > m;
  if (e.verb === "under") return n < m;
  if (e.verb === "before" || e.verb === "after") {
    const other = e.arg === "now" ? (now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) : unq(e.arg);
    const c = compareTime(items[0] ?? "", other);
    if (c === "undetermined") return c;
    return e.verb === "before" ? c < 0 : c > 0;
  }
  return "undetermined";
}

/** Evaluate a condition. `now` is the moment `now` means (6.3); the caller supplies it for reproducibility. */
export function evaluate(e: Expr, values: JsonObject, states?: StateOf, now?: string): Truth {
  if (e.op === "test") return test(e, values, states, now);
  if (e.op === "not") {
    const a = evaluate(e.a, values, states, now);
    return a === "undetermined" ? a : !a;
  }
  const a = evaluate(e.a, values, states, now);
  const b = evaluate(e.b, values, states, now);
  if (e.op === "and") {
    if (a === false || b === false) return false;
    return a === true && b === true ? true : "undetermined";
  }
  if (a === true || b === true) return true;
  return a === false && b === false ? false : "undetermined";
}

/** The keys a condition reads, for layering checks. */
export function reads(e: Expr): string[] {
  if (e.op === "test") return [e.path];
  if (e.op === "not") return reads(e.a);
  return [...reads(e.a), ...reads(e.b)];
}
