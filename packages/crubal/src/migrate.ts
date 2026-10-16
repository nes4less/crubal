// migrate.ts: migration recipes (spec chapter 10). A recipe names the version it leaves and the version it
// reaches, then steps grouped by facet, run in the order written. Restamping applies it to every record;
// steps that need a person send items to the review queue and hold the value. Nothing is dropped.

import { serialize } from "./canonical.ts";
import { evaluate, parseCondition } from "./conditions.ts";
import { checkScalar } from "./dictionary.ts";
import { readUnder } from "./read-text.ts";
import type { Dictionary } from "./defs.ts";
import { splitTop } from "./lex.ts";
import type { Json, JsonObject, Record } from "./model.ts";
import { CrubalError, readTree } from "./tree.ts";
import { convert, unitOf } from "./units.ts";

export type Step =
  | { verb: "rename"; facet: string; from: string; to: string; line: number; text: string }
  | { verb: "merge"; facet: string; from: string[]; to: string; line: number; text: string }
  | { verb: "convert"; facet: string; from: string; to: string; rounding: string; line: number; text: string }
  | { verb: "precision"; facet: string; from: string; to: string; line: number; text: string }
  | { verb: "split"; facet: string; value: string; when: { cond: string; to: string }[]; else?: string; line: number; text: string }
  | { verb: "move"; facet: string; to: string; line: number; text: string }
  | { verb: "review"; facet: string; cond: string; line: number; text: string }
  | { verb: "recompute"; facet: string; line: number; text: string }
  | { verb: "retype"; facet: string; from: string; to: string; line: number; text: string };

export type Recipe = { from: string; to: string; steps: Step[]; line: number };

const unq = (s: string) => (s.trim().startsWith('"') ? (JSON.parse(s.trim()) as string) : s.trim());

function arrow(text: string, line: number): [string, string] {
  const at = text.lastIndexOf(" -> ");
  if (at < 0) {
    if (text.startsWith("-> ")) return ["", text.slice(3).trim()];
    throw new CrubalError(`expected "from -> to": ${text}`, line);
  }
  return [text.slice(0, at).trim(), text.slice(at + 4).trim()];
}

/** Read `migration:` blocks. */
export function readRecipes(source: string): Recipe[] {
  const out: Recipe[] = [];
  for (const node of readTree(source)) {
    if (node.kind !== "pair" || node.key !== "migration") continue;
    const [from, to] = arrow(node.value, node.line);
    const recipe: Recipe = { from, to, steps: [], line: node.line };
    for (const group of node.children) {
      if (group.key !== "facet") throw new CrubalError(`a recipe groups its steps under "facet: key"`, group.line);
      const facet = group.value.trim();
      const kids = group.children;
      for (let i = 0; i < kids.length; i++) {
        const s = kids[i] as (typeof kids)[number];
        const base = { facet, line: s.line, text: s.text };
        if (s.kind === "line" && s.text === "recompute") {
          recipe.steps.push({ verb: "recompute", ...base });
          continue;
        }
        switch (s.key) {
          case "rename": {
            const [a, b] = arrow(s.value, s.line);
            recipe.steps.push({ verb: "rename", from: unq(a), to: unq(b), ...base });
            break;
          }
          case "merge": {
            const [a, b] = arrow(s.value, s.line);
            recipe.steps.push({ verb: "merge", from: splitTop(a, ",", s.line).map(unq), to: unq(b), ...base });
            break;
          }
          case "convert": {
            const [a, b] = arrow(s.value, s.line);
            const next = kids[i + 1];
            const rounding = next?.key === "rounding" ? next.value : "nearest";
            if (next?.key === "rounding") i++;
            recipe.steps.push({ verb: "convert", from: a, to: b, rounding, ...base });
            break;
          }
          case "precision":
          case "retype": {
            const [a, b] = arrow(s.value, s.line);
            recipe.steps.push({ verb: s.key, from: a, to: b, ...base });
            break;
          }
          case "split": {
            const when: { cond: string; to: string }[] = [];
            let otherwise: string | undefined;
            for (const b of s.children) {
              if (b.key === "when") {
                const [cond, to] = arrow(b.value, b.line);
                when.push({ cond, to: unq(to) });
              } else if (b.key === "else") otherwise = unq(b.value);
            }
            recipe.steps.push({ verb: "split", value: unq(s.value), when, ...(otherwise !== undefined ? { else: otherwise } : {}), ...base });
            break;
          }
          case "move":
            recipe.steps.push({ verb: "move", to: arrow(s.value, s.line)[1], ...base });
            break;
          case "review":
            recipe.steps.push({ verb: "review", cond: s.value, ...base });
            break;
          default:
            throw new CrubalError(`unknown recipe step: ${s.text}`, s.line);
        }
      }
    }
    out.push(recipe);
  }
  return out;
}

/** Publish checks (10.5) against the version the recipe reaches, given as `dict`. */
export function checkRecipe(r: Recipe, dict: Dictionary): void {
  for (const s of r.steps) {
    const f = dict.facets.get(s.facet);
    const real = new Set((f?.values ?? []).map((v) => v.value));
    const need = (v: string) => {
      if (f?.type === "choice" && !real.has(v)) throw new CrubalError(`${v} is not a value of ${s.facet} in ${r.to}`, s.line);
    };
    if (s.verb === "rename" || s.verb === "merge") need(s.to);
    if (s.verb === "split") {
      for (const b of s.when) need(b.to);
      if (s.else !== undefined) need(s.else);
    }
    if (s.verb === "convert" && convert("1", s.from, s.to) === null) throw new CrubalError(`can't convert ${s.from} to ${s.to}`, s.line);
  }
}

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

function mapScalars(v: Json, fn: (x: Json) => Json): Json {
  if (Array.isArray(v)) return v.map((x) => mapScalars(x, fn));
  if (isObj(v) && "$value" in v) return { ...v, $value: fn(v.$value as Json) };
  return fn(v);
}

export type ReviewItem = { record: string; address: string; step: string; held: true };

/** Restamp records with a recipe. Returns the restamped records and the review queue. */
export type StepStats = { step: string; facet: string; verb: string; changed: number; review: number };

/** A value's text as the text form writes it, for a retype to re-read (10.3). */
function textOf(v: Json): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v) && "$qty" in v) return `${v.$qty}${v.unit}`;
  if (isObj(v) && "$money" in v) return `${v.$money}${v.currency}`;
  if (isObj(v) && "$link" in v) return `&${v.$link}`;
  if (isObj(v) && "$value" in v) return textOf(v.$value as Json);
  return JSON.stringify(v);
}

export function restamp(records: Record[], recipe: Recipe, dict: Dictionary, stats?: StepStats[]): { records: Record[]; review: ReviewItem[] } {
  const review: ReviewItem[] = [];
  if (stats) for (const s of recipe.steps) stats.push({ step: s.text, facet: s.facet, verb: s.verb, changed: 0, review: 0 });
  const out = records.map((rec) => {
    const values: JsonObject = { ...rec.values };
    recipe.steps.forEach((s, si) => {
      const v = values[s.facet];
      if (v === undefined && s.verb !== "review") return;
      const before = serialize((values[s.facet] ?? null) as Json);
      const reviewsBefore = review.length;
      switch (s.verb) {
        case "rename":
          values[s.facet] = mapScalars(v as Json, (x) => (x === s.from ? s.to : x));
          break;
        case "merge":
          values[s.facet] = mapScalars(v as Json, (x) => (typeof x === "string" && s.from.includes(x) ? s.to : x));
          break;
        case "convert":
          values[s.facet] = mapScalars(v as Json, (x) => {
            if (!isObj(x) || !("$qty" in x)) return x;
            const unit = unitOf(String(x.unit)) ?? String(x.unit);
            if (unit !== s.from) return x;
            const places = dict.facets.get(s.facet)?.places ?? 0;
            const exact = Number(convert(String(x.$qty), s.from, s.to, 12));
            const scale = 10 ** places;
            const round = s.rounding === "down" ? Math.floor : s.rounding === "up" ? Math.ceil : Math.round;
            return { $qty: String(round(exact * scale) / scale), unit: s.to };
          });
          break;
        case "precision": {
          const len = s.to === "year" ? 4 : s.to === "month" ? 7 : 10;
          values[s.facet] = mapScalars(v as Json, (x) => (typeof x === "string" && x.length > len ? x.slice(0, len) : x));
          break;
        }
        case "split":
          values[s.facet] = mapScalars(v as Json, (x) => {
            if (x !== s.value) return x;
            for (const b of s.when) if (evaluate(parseCondition(b.cond, s.line), values) === true) return b.to;
            if (s.else !== undefined) return s.else;
            review.push({ record: rec.id, address: s.facet, step: s.text, held: true });
            return x;
          });
          break;
        case "move":
          if (!/^[A-Za-z_][\w:]*$/.test(s.to) || values[s.to] !== undefined) {
            review.push({ record: rec.id, address: s.facet, step: s.text, held: true });
            break;
          }
          values[s.to] = v as Json;
          delete values[s.facet];
          break;
        case "review":
          if (evaluate(parseCondition(s.cond, s.line), values) === true) review.push({ record: rec.id, address: s.facet, step: s.text, held: true });
          break;
        case "retype": {
          // Each value is read again under the facet's new type (10.3): what fits lands, the rest goes to review.
          const f = dict.facets.get(s.facet);
          if (!f) break;
          const again = readUnder(f, textOf(v as Json), dict);
          const ok = again !== undefined && checkScalar(f, again).outcome === "absorbed";
          if (ok) values[s.facet] = again as Json;
          else review.push({ record: rec.id, address: s.facet, step: s.text, held: true });
          break;
        }
        case "recompute":
          break; // the rules rebuild produced values
      }
      if (stats) {
        const st = stats[si] as StepStats;
        if (serialize((values[s.facet] ?? null) as Json) !== before) st.changed += 1;
        st.review += review.length - reviewsBefore;
      }
    });
    return { ...rec, values };
  });
  return { records: out, review };
}

/** What a restamp would do, without doing it (10.4): per step, how many values change and how many go to review. */
export function dryRun(records: Record[], recipe: Recipe, dict: Dictionary): { steps: StepStats[]; records: number; review: number } {
  const stats: StepStats[] = [];
  const { review } = restamp(structuredClone(records), recipe, dict, stats);
  return { steps: stats, records: records.length, review: review.length };
}
