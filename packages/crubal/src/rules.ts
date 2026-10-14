// rules.ts: the Rules level (spec chapter 6). Rules are read from `rule:` blocks and from the facet
// shortcuts that expand to them (4.4); a rule set is checked at publish (6.8: layered, no contradictions,
// one spelling); and writes run through the rules in order (6.2, 6.4, 6.7, 6.9): refused, held, filled,
// derived, flagged, incomplete, complete and completeness.

import { type Expr, evaluate, parseCondition, reads, type StateOf } from "./conditions.ts";
import type { Dictionary, Facet } from "./defs.ts";
import { resolve } from "./dictionary.ts";
import type { Json, JsonObject, Record } from "./model.ts";
import { itemText } from "./print-text.ts";
import { CrubalError, readTree } from "./tree.ts";

export type Strength = "must" | "should" | "suggest";

export type Rule = {
  name: string;
  line: number;
  for: string;
  when: Expr | null;
  whenText: string;
  thenText: string;
  then: Expr | null;
  strength: Strength;
  because?: string;
  /** A production: `key is <value | template | aggregate>`. */
  produces?: { key: string; kind: "fill" | "template" | "rollup"; right: string };
  /** Where it came from when it was expanded from a shortcut. */
  shortcut?: boolean;
};

const AGG = /^(join|sum|best|narrow|worst|deduct|replace|keep|count|least|most) of (\S+)$/;
const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function production(thenText: string, strength: Strength): Rule["produces"] {
  const m = thenText.match(/^([A-Za-z_][\w:]*) is (.+)$/);
  if (!m) return undefined;
  const key = m[1] as string;
  const right = (m[2] as string).trim();
  if (right.startsWith('"')) return { key, kind: "template", right };
  if (AGG.test(right)) return { key, kind: "rollup", right };
  if (right === "unique" || right === "_" || right === "-") return undefined;
  if (strength === "suggest") return { key, kind: "fill", right };
  return undefined;
}

function makeRule(r: Omit<Rule, "when" | "then" | "produces">): Rule {
  const rule: Rule = { ...r, when: r.whenText ? parseCondition(r.whenText, r.line) : null, then: null };
  rule.produces = production(r.thenText, r.strength);
  if (!rule.produces || rule.produces.kind === "fill") {
    rule.then = r.thenText.endsWith(" is unique") ? null : parseCondition(r.thenText, r.line);
  }
  return rule;
}

/** Read `rule:` blocks from definition text. */
export function readRules(source: string): Rule[] {
  const out: Rule[] = [];
  for (const node of readTree(source)) {
    if (node.kind !== "pair" || node.key !== "rule") continue;
    const get = (k: string) => node.children.find((c) => c.key === k);
    const strength = get("strength")?.value as Strength | undefined;
    if (!strength || !["must", "should", "suggest"].includes(strength)) {
      throw new CrubalError(`the rule ${node.value} needs a strength: must, should or suggest`, node.line);
    }
    const thenNode = get("then");
    if (!thenNode) throw new CrubalError(`the rule ${node.value} needs a then`, node.line);
    const because = get("because")?.value;
    out.push(
      makeRule({
        name: node.value.trim(),
        line: node.line,
        for: get("for")?.value ?? "everywhere",
        whenText: get("when")?.value ?? "",
        thenText: thenNode.value,
        strength,
        ...(because ? { because } : {}),
      }),
    );
  }
  return out;
}

/** The rules a facet's shortcut settings expand to (4.4). */
export function shortcutRules(dict: Dictionary): Rule[] {
  const out: Rule[] = [];
  for (const f of dict.facets.values()) {
    const line = f.line ?? 0;
    const add = (name: string, thenText: string, strength: Strength, whenText = "") =>
      out.push(makeRule({ name: `${f.key}: ${name}`, line, for: "everywhere", whenText, thenText, strength, shortcut: true }));
    if (f.required) add("required", `${f.key} has`, "must");
    if (f.unique) add("unique", `${f.key} is unique`, "must");
    if (f.when) add("when", `${f.key} is -`, "must", `not (${f.when})`);
    if (f.length !== undefined) add("length", `${f.key} under ${f.length + 1}`, "should", `${f.key} has`);
    if (f.range) add("range", `${f.key} in ${f.range.min}..${f.range.max}`, "should", `${f.key} has`);
    if (f.combine) add("combine", `${f.key} is ${f.combine} of parts[*].${f.key}`, "must");
  }
  return out;
}

// ─── Publish checks (6.8) ────────────────────────────────────────────────────

function readsOf(r: Rule): string[] {
  const keys = r.when ? reads(r.when) : [];
  if (r.produces?.kind === "template") {
    for (const m of r.produces.right.matchAll(/\{([^{}]+)\}/g)) {
      for (const alt of (m[1] as string).split("??")) keys.push(alt.trim().replace(/\?$/, ""));
    }
  }
  // A rollup reads its parts' addresses (parts[*].condition), not the key it produces on the whole.
  if (r.produces?.kind === "rollup") keys.push(r.produces.right.match(AGG)?.[2] ?? "");
  return keys.map((k) => k.replace(/^\w+::/, ""));
}

/** Top-level `and`-terms of a condition that pin a key to a set of values. */
function pins(e: Expr | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (x: Expr) => {
    if (x.op === "and") {
      walk(x.a);
      walk(x.b);
    } else if (x.op === "test" && (x.verb === "is" || x.verb === "in") && !/\.\./.test(x.arg)) {
      out.set(x.path, new Set(x.arg.split(",").map((s) => s.trim().replace(/^"|"$/g, ""))));
    }
  };
  if (e) walk(e);
  return out;
}

function disjoint(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return false;
  return true;
}

/** Check a rule set (6.8). Throws the first problem. */
export function checkRules(rules: Rule[], dict: Dictionary): void {
  const all = [...shortcutRules(dict), ...rules];
  // One spelling: an explicit rule that says what a shortcut says.
  for (const r of rules) {
    const twin = all.find((s) => s.shortcut && s.thenText === r.thenText && s.whenText === r.whenText && s.strength === r.strength);
    if (twin) throw new CrubalError(`${r.name} says the same as ${twin.name.replace(": ", "'s ")} setting`, r.line);
  }
  // Layered: no cycle from what a rule reads to what it produces.
  const producers = all.filter((r) => r.produces);
  const edges = new Map<string, { to: string; rule: Rule }[]>();
  for (const r of producers) {
    for (const k of readsOf(r)) edges.set(k, [...(edges.get(k) ?? []), { to: r.produces?.key as string, rule: r }]);
  }
  for (const start of producers) {
    const seen = new Set<string>();
    const stack: { key: string; path: Rule[] }[] = [{ key: start.produces?.key as string, path: [start] }];
    while (stack.length) {
      const { key, path } = stack.pop() as { key: string; path: Rule[] };
      for (const e of edges.get(key) ?? []) {
        if (e.rule === start) {
          const names = [...new Set(path.map((p) => p.name))];
          const first = [...path].sort((a, b) => a.line - b.line)[0] as Rule;
          throw new CrubalError(`the rules ${names.join(" and ")} depend on each other's effect`, first.line);
        }
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push({ key: e.to, path: [...path, e.rule] });
        }
      }
    }
  }
  // No contradictions: two must rules pinning one key to disjoint values, with whens that can both hold.
  const musts = all.filter((r) => r.strength === "must" && r.then && !r.produces);
  for (let i = 0; i < musts.length; i++) {
    for (let j = i + 1; j < musts.length; j++) {
      const a = musts[i] as Rule;
      const b = musts[j] as Rule;
      if (a.for !== b.for && a.for !== "everywhere" && b.for !== "everywhere") continue;
      const pa = pins(a.then);
      const pb = pins(b.then);
      const wa = pins(a.when);
      const wb = pins(b.when);
      const whensClash = [...wa].some(([k, s]) => wb.has(k) && disjoint(s, wb.get(k) as Set<string>));
      if (whensClash) continue;
      for (const [k, s] of pa) {
        const t = pb.get(k);
        if (t && disjoint(s, t)) {
          const when = a.whenText && a.whenText === b.whenText ? ` when ${a.whenText.replace(/ has$/, " has a value")}` : "";
          throw new CrubalError(`${a.name} and ${b.name} can't both hold${when}`, Math.min(a.line, b.line));
        }
      }
    }
  }
}

// ─── Evaluating writes (6.2, 6.4, 6.7, 6.9) ──────────────────────────────────

export type Result = { record: string; result: string; address?: string; value?: Json; rule?: string };

type Stored = { rec: Record; produced: Set<string>; held: Set<string> };

function emptyOf(v: Json | undefined): boolean {
  return v === undefined || (isObj(v) && v.$empty === "unknown");
}

export class Engine {
  readonly dict: Dictionary;
  readonly rules: Rule[];
  /** The moment `now` means in conditions; unset means the clock's. */
  now?: string;
  private store = new Map<string, Stored>();
  private order: string[] = [];

  constructor(dict: Dictionary, rules: Rule[]) {
    this.dict = dict;
    this.rules = [...shortcutRules(dict), ...rules];
  }

  /** The values a record reads: its own over everything above it (1.7). */
  effective(rec: Record): JsonObject {
    const up = rec.of ? this.store.get(rec.of)?.rec : undefined;
    return { ...(up ? this.effective(up) : {}), ...rec.values };
  }

  private applies(r: Rule, rec: Record): boolean {
    if (r.for === "everywhere") return true;
    if (this.dict.classes.has(r.for)) return (rec.wears ?? []).some((w) => w === r.for || resolveUses(this.dict, w).includes(r.for));
    if (this.dict.levels.has(r.for)) return rec.level === r.for;
    return rec.kind === r.for;
  }

  /** Where a produced key may be stored: the top of its chain, or a level where it varies. */
  private storesAt(key: string, rec: Record): boolean {
    return !rec.of || (this.dict.vary.get(rec.level)?.has(key) ?? false);
  }

  private states(rec: Record, held: Set<string>): StateOf {
    return (path) => {
      const s = new Set<string>();
      const alt = (rec as unknown as { alternatives?: { [a: string]: Json[] } }).alternatives?.[path];
      if (alt?.length) s.add("conflicted");
      if (held.has(path)) s.add("held");
      const f = this.dict.facets.get(path);
      const v = rec.values[path];
      if (f?.type === "choice" && typeof v === "string" && !(f.values ?? []).some((x) => x.value === v)) s.add("new");
      if (rec.sources?.[path]?.adopted) s.add("adopted");
      return s;
    };
  }

  /** A path a check tests, for reporting. */
  private pathOf(e: Expr | null): string | undefined {
    if (!e) return undefined;
    if (e.op === "test") return e.path;
    if (e.op === "not") return this.pathOf(e.a);
    return this.pathOf(e.a);
  }

  private uniqueClash(r: Rule, rec: Record): boolean {
    const key = r.thenText.replace(/ is unique$/, "");
    const mine = rec.values[key];
    if (emptyOf(mine) || (isObj(mine) && "$empty" in mine)) return false;
    const want = JSON.stringify(mine);
    for (const [id, s] of this.store) if (id !== rec.id && JSON.stringify(s.rec.values[key]) === want) return true;
    return false;
  }

  /** Write a record (a create, or values merged onto one already stored). Returns its results. */
  write(incoming: Record): Result[] {
    const before = this.store.get(incoming.id);
    const rec: Record = before
      ? { ...before.rec, values: { ...before.rec.values, ...incoming.values }, parts: incoming.parts ?? before.rec.parts }
      : { ...incoming, values: { ...incoming.values } };
    const touched = new Set(Object.keys(incoming.values));
    const produced = new Set(before?.produced ?? []);
    const held = new Set<string>();
    const results: Result[] = [];

    // 1. Must checks against the write: refuse what the write broke; hold what a changed verdict broke.
    for (const r of this.rules) {
      if (r.strength !== "must" || r.produces || !this.applies(r, rec)) continue;
      const vals = this.effective(rec);
      if (r.when && evaluate(r.when, vals, this.states(rec, held), this.now) !== true) continue;
      if (r.thenText.endsWith(" is unique")) {
        const key = r.thenText.replace(/ is unique$/, "");
        if (this.uniqueClash(r, rec)) {
          if (touched.has(key)) return [{ record: rec.id, result: "refused", address: key, rule: r.name }];
          held.add(key);
          results.push({ record: rec.id, result: "held", address: key, rule: r.name });
        }
        continue;
      }
      const path = this.pathOf(r.then) as string;
      if (emptyOf(vals[path])) continue; // an empty value is incompleteness, reported below
      if (r.then && evaluate(r.then, vals, this.states(rec, held), this.now) === false) {
        if (touched.has(path)) return [{ record: rec.id, result: "refused", address: path, rule: r.name }];
        held.add(path);
        results.push({ record: rec.id, result: "held", address: path, rule: r.name });
      }
    }
    const visible = (): JsonObject => {
      const v = this.effective(rec);
      for (const h of held) delete v[h];
      return v;
    };

    // 2a. A gate that fails produces "does not apply" when the value is empty (chapter 1.5).
    for (const r of this.rules) {
      if (r.strength !== "must" || !this.applies(r, rec)) continue;
      const gate = r.thenText.match(/^([A-Za-z_][\w:]*) is -$/);
      if (!gate) continue;
      const key = gate[1] as string;
      if (held.has(key) || rec.values[key] !== undefined || !this.storesAt(key, rec)) continue;
      if (r.when && evaluate(r.when, visible(), this.states(rec, held), this.now) !== true) continue;
      rec.values[key] = { $empty: "n/a" };
      produced.add(key);
      results.push({ record: rec.id, result: "filled", address: key, value: { $empty: "n/a" }, rule: r.name });
    }

    // 2. Productions, in layer order (a rule's inputs before its output).
    for (const r of this.layered()) {
      if (!r.produces || !this.applies(r, rec)) continue;
      const { key, kind, right } = r.produces;
      if (!this.storesAt(key, rec)) continue;
      const vals = visible();
      if (r.when && evaluate(r.when, vals, this.states(rec, held), this.now) !== true) continue;
      const current = rec.values[key];
      const mine = produced.has(key);
      if (kind === "fill") {
        if (!emptyOf(current)) continue;
        const f = this.dict.facets.get(key);
        const v = f?.type === "choice" || !f ? right.replace(/^"|"$/g, "") : right;
        rec.values[key] = v;
        produced.add(key);
        results.push({ record: rec.id, result: "filled", address: key, value: v, rule: r.name });
        continue;
      }
      if (!emptyOf(current) && !mine) continue; // a person's value: adopted, not overwritten
      const v = kind === "template" ? this.template(right, vals) : this.rollup(right, rec);
      if (v === undefined) continue;
      rec.values[key] = v;
      produced.add(key);
      results.push({ record: rec.id, result: "derived", address: key, value: v, rule: r.name });
    }

    // 3. Results: incomplete, flagged, complete, completeness.
    let complete = held.size === 0;
    const vals = visible();
    for (const r of this.rules) {
      if (r.produces || !this.applies(r, rec)) continue;
      if (r.when && evaluate(r.when, vals, this.states(rec, held), this.now) !== true) continue;
      if (r.thenText.endsWith(" is unique")) continue;
      const truth = r.then ? evaluate(r.then, vals, this.states(rec, held), this.now) : true;
      const path = this.pathOf(r.then);
      const needsValue = path !== undefined && emptyOf(vals[path]);
      if (r.strength === "must" && (truth === "undetermined" || (truth === false && needsValue))) {
        complete = false;
        results.push({ record: rec.id, result: "incomplete", rule: r.name, ...(path ? { address: path } : {}) });
      } else if (r.strength === "should" && truth !== true) {
        results.push({ record: rec.id, result: "flagged", rule: r.name, ...(path ? { address: path } : {}) });
      }
    }
    if (complete) results.unshift({ record: rec.id, result: "complete" });
    results.push(...this.completeness(rec));

    this.store.set(rec.id, { rec, produced, held });
    if (!this.order.includes(rec.id)) this.order.push(rec.id);
    return results;
  }

  private layered(): Rule[] {
    const prods = this.rules.filter((r) => r.produces);
    const out: Rule[] = [];
    const placed = new Set<Rule>();
    while (out.length < prods.length) {
      const before = out.length;
      for (const r of prods) {
        if (placed.has(r)) continue;
        const needs = readsOf(r);
        const blocked = prods.some((p) => !placed.has(p) && p !== r && needs.includes(p.produces?.key as string));
        if (!blocked) {
          out.push(r);
          placed.add(r);
        }
      }
      if (out.length === before) return [...out, ...prods.filter((p) => !placed.has(p))];
    }
    return out;
  }

  /** A value's plain text in a template: the value itself, never quoted, without detail. */
  private text(key: string, v: Json): string {
    const c = isObj(v) && "$value" in v ? (v.$value as Json) : v;
    if (typeof c === "string") return c;
    const f = this.dict.facets.get(key);
    return f ? itemText(f, c) : JSON.stringify(c);
  }

  /** A template (6.4.1): `{a}`, `{a ?? b}`, `{a?}`, `{{`, `}}`. Nothing when a needed value is empty. */
  template(right: string, vals: JsonObject): string | undefined {
    const src = JSON.parse(right) as string;
    let out = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i] as string;
      if (src.startsWith("{{", i) || src.startsWith("}}", i)) {
        out += ch;
        i++;
        continue;
      }
      if (ch !== "{") {
        out += ch;
        continue;
      }
      const end = src.indexOf("}", i);
      const inner = src.slice(i + 1, end).trim();
      i = end;
      const optional = inner.endsWith("?") && !inner.includes("??");
      const alts = (optional ? inner.slice(0, -1) : inner).split("??").map((s) => s.trim());
      const found = alts.find((a) => !emptyOf(vals[a]) && !(isObj(vals[a]) && "$empty" in (vals[a] as JsonObject)));
      if (found === undefined) {
        if (!optional) return undefined;
        out = out.replace(/[\s·,:-]+$/, "");
        continue;
      }
      out += this.text(found, vals[found] as Json);
    }
    return out;
  }

  /** A rollup over parts: `worst of parts[*].condition`. */
  rollup(right: string, rec: Record): Json | undefined {
    const m = right.match(AGG);
    if (!m) return undefined;
    const how = m[1] as string;
    const key = (m[2] as string).replace(/^parts\[\*\]\./, "");
    const items = (rec.parts ?? [])
      .map((p) => (isObj(p) && isObj(p.values) ? p.values[key] : undefined))
      .filter((v): v is Json => v !== undefined && !(isObj(v) && "$empty" in v));
    if (how === "count") return String(items.length);
    if (!items.length) return undefined;
    const f = this.dict.facets.get(key);
    if ((how === "worst" || how === "best") && f?.values) {
      const rank = (v: Json) => (f.values ?? []).findIndex((x) => x.value === v);
      const sorted = [...items].sort((a, b) => rank(a) - rank(b));
      return (how === "best" ? sorted[0] : sorted.at(-1)) as Json;
    }
    const nums = items.map((v) => Number(isObj(v) ? (v.$qty ?? v.$money) : v));
    if (how === "sum") return String(nums.reduce((a, b) => a + b, 0));
    if (how === "least" || how === "worst") return String(Math.min(...nums));
    if (how === "most" || how === "best") return String(Math.max(...nums));
    if (how === "join") return items;
    return items.at(-1);
  }

  /** Completeness (6.9): asked facets with a value ÷ asked facets, per record and per part. */
  completeness(rec: Record): Result[] {
    const out: Result[] = [];
    const measure = (worn: string[], values: JsonObject): string | null => {
      const asked = resolve(this.dict, worn.filter((w) => this.dict.classes.has(w))).filter(
        (l) => !l.when || evaluate(parseCondition(l.when), values, undefined, this.now) === true,
      );
      if (!asked.length) return null;
      const had = asked.filter((l) => !emptyOf(values[l.facet])).length;
      return String(Number((had / asked.length).toFixed(4)));
    };
    const own = measure(rec.wears ?? [], this.effective(rec));
    if (own !== null) out.push({ record: rec.id, result: "completeness", value: own });
    for (const p of rec.parts ?? []) {
      if (!isObj(p)) continue;
      const v = measure(Array.isArray(p.wears) ? p.wears.map(String) : [], isObj(p.values) ? p.values : {});
      if (v !== null) out.push({ record: rec.id, address: `parts[${p.$row}]`, result: "completeness", value: v });
    }
    return out;
  }
}

function resolveUses(dict: Dictionary, name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const c = dict.classes.get(name);
  return c ? c.uses.flatMap((u) => [u, ...resolveUses(dict, u, seen)]) : [];
}

export type { Facet };
