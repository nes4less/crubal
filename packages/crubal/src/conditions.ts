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

const VERBS = [" is not ", " is ", " in ", " has", " before ", " after ", " over ", " under "];

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

function test(e: Extract<Expr, { op: "test" }>, values: JsonObject, states?: StateOf): Truth {
  if (e.verb === "is" && STATES.has(e.arg)) return states ? states(e.path).has(e.arg) : false;
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
  if (e.verb === "before") return (items[0] ?? "") < e.arg;
  if (e.verb === "after") return (items[0] ?? "") > e.arg;
  return "undetermined";
}

export function evaluate(e: Expr, values: JsonObject, states?: StateOf): Truth {
  if (e.op === "test") return test(e, values, states);
  if (e.op === "not") {
    const a = evaluate(e.a, values, states);
    return a === "undetermined" ? a : !a;
  }
  const a = evaluate(e.a, values, states);
  const b = evaluate(e.b, values, states);
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
