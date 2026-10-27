// migrate.ts: migration recipes (spec chapter 10). A recipe names the version it leaves and the version it
// reaches, then steps grouped by facet, run in the order written. Restamping applies it to every record;
// steps that need a person send items to the review queue and hold the value. Nothing is dropped.

import { serialize } from "./canonical.ts";
import { evaluate, parseCondition } from "./conditions.ts";
import { checkScalar } from "./dictionary.ts";
import { readUnder } from "./read-text.ts";
import type { Dictionary } from "./defs.ts";
import { splitTop } from "./lex.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
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
  | { verb: "retype"; facet: string; from: string; to: string; line: number; text: string }
  /** `fill: value` with `for: level::` and `when:` beneath: records lacking the key get the value (10.3). */
  | { verb: "fill"; facet: string; value: string; level?: string; when?: string; line: number; text: string }
  /** `parts: -> slot` under a compound, with `when:` and `child -> facet` lines beneath: the compound's rows become parts of the slot (10.3, 5.6). */
  | { verb: "parts"; facet: string; to: string; when?: string; map: [string, string][]; line: number; text: string };

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
          case "fill": {
            let level: string | undefined;
            let when: string | undefined;
            for (const b of s.children) {
              if (b.key === "for") level = b.value.trim().replace(/::$/, "");
              else if (b.key === "when") when = b.value.trim();
              else throw new CrubalError(`a fill takes "for:" and "when:" beneath it, not ${b.key}`, b.line);
            }
            recipe.steps.push({ verb: "fill", value: unq(s.value), ...(level ? { level } : {}), ...(when ? { when } : {}), ...base });
            break;
          }
          case "parts": {
            // The rows of the compound become parts of the slot named (5.6): `when:` picks the rows, and each
            // `child -> facet` line says which child becomes which facet of the part; a row's other children stay
            // in the compound, which is left as it was.
            const [, to] = arrow(s.value, s.line);
            if (!to) throw new CrubalError(`parts names the slot the rows become: "parts: -> disc"`, s.line);
            let when: string | undefined;
            const map: [string, string][] = [];
            for (const b of s.children) {
              if (b.key === "when") when = b.value.trim();
              else if (b.kind === "line" && b.text.includes(" -> ")) map.push(arrow(b.text, b.line));
              else throw new CrubalError(`parts takes "when:" and "child -> facet" lines beneath it, not ${b.text}`, b.line);
            }
            recipe.steps.push({ verb: "parts", to, ...(when ? { when } : {}), map, ...base });
            break;
          }
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
    if (s.verb === "parts") {
      // The compound and the part's facets may be an extended package's (11.4: a recipe over the baseline's
      // manifest in a kind's package): the publish check sees only the package's own definitions, so a facet it
      // does not hold is left to the install, which reads the recipe under the merged dictionary.
      if (f && f.type !== "compound") throw new CrubalError(`${s.facet} is not a compound of ${r.to}`, s.line);
      const slot = [...dict.classes.values()].flatMap((c) => c.parts).find((p) => p.slot === s.to);
      if (!slot) throw new CrubalError(`no class of ${r.to} declares a part slot ${s.to}`, s.line);
      for (const [, to] of s.map) {
        const t = dict.facets.get(to);
        if (t && t.type === "compound") throw new CrubalError(`${to} is a compound; a part's child takes a plain facet`, s.line);
      }
      if (s.when) parseCondition(s.when, s.line);
    }
    if (s.verb === "fill") {
      if (!f) throw new CrubalError(`${s.facet} is not a facet of ${r.to}`, s.line);
      const v = readUnder(f, s.value, dict, s.line);
      if (v === undefined || checkScalar(f, v).outcome !== "absorbed") throw new CrubalError(`${s.value} is not a value ${s.facet} takes`, s.line);
      if (s.level && !dict.levels.has(s.level)) throw new CrubalError(`${s.level} is not a level of ${r.to}`, s.line);
      if (s.when) parseCondition(s.when, s.line);
    }
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
    let parts: Json[] | undefined = rec.parts ? [...rec.parts] : undefined;
    // A moved value keeps its source under its new address (10.4): the record's own, else its default.
    const sources: { [address: string]: Source } = { ...(rec.sources ?? {}) };
    recipe.steps.forEach((s, si) => {
      const v = values[s.facet];
      if (v === undefined && s.verb !== "review" && s.verb !== "fill") return;
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
          {
            const src = sources[s.facet] ?? sources["*"];
            if (src) sources[s.to] = src;
            delete sources[s.facet];
          }
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
        case "parts": {
          // The compound's rows become parts of the slot (5.6): the row's key is its `$row` when it has one, else
          // the slot's name numbered; a row whose key the record already holds as a part is left alone; the class
          // the parts wear is the slot's, from the class the record wears that declares it (any class, standing
          // alone). The compound stays as it was.
          const rows = (Array.isArray(v) ? v : [v]).filter(isObj);
          // Only a record wearing a class that declares the slot takes parts in it (5.6): a release that wears
          // no DVD class keeps its rows until it does.
          const declaring = [...dict.classes.values()].filter((c) => c.parts.some((p) => p.slot === s.to));
          const cls = declaring.find((c) => (rec.wears ?? []).includes(c.name));
          const slot = cls?.parts.find((p) => p.slot === s.to);
          if (!slot) break;
          const have = (parts ?? []).filter(isObj);
          const keys = new Set(have.map((p) => String(p.$row)));
          let n = 0;
          const next = () => {
            for (;;) {
              n += 1;
              const k = `${s.to}${n}`;
              if (!keys.has(k)) return k;
            }
          };
          // A row without a key of its own binds to a part the slot already holds with the same values, each
          // existing part taken once: the step run again (a later version repeating it) makes nothing twice.
          // Before, every rerun minted a fresh key past the ones held (2026-10-27, Media Encyclopedia).
          const unmatched = have.filter(
            (p) => Array.isArray(p.wears) && p.wears.includes(slot.wears),
          );
          const made: Json[] = [];
          for (const row of rows) {
            if (s.when && evaluate(parseCondition(s.when, s.line), row) !== true) continue;
            const pv: JsonObject = {};
            for (const [from, to] of s.map) {
              const x = row[from];
              if (x === undefined || x === null || x === "") continue;
              if (to === "crubal:count") {
                pv[to] = x;
                continue;
              }
              const f = dict.facets.get(to);
              // A text facet takes the words as they are: a part named with brackets is a name, not a detail.
              let read: Json | undefined = x as Json;
              if (f && typeof x === "string" && f.type !== "text") {
                try {
                  read = readUnder(f, x, dict);
                } catch {
                  read = x;
                }
              }
              if (read !== undefined) pv[to] = read;
            }
            if (typeof row.$row === "string" && row.$row) {
              if (keys.has(row.$row)) continue;
              keys.add(row.$row);
              made.push({ $row: row.$row, wears: [slot.wears], values: pv });
              continue;
            }
            const same = unmatched.findIndex((p) => isObj(p.values) && serialize(p.values as Json) === serialize(pv));
            if (same >= 0) {
              unmatched.splice(same, 1);
              continue;
            }
            const key = next();
            keys.add(key);
            made.push({ $row: key, wears: [slot.wears], values: pv });
          }
          if (made.length) parts = [...(parts ?? []), ...made];
          if (stats) (stats[si] as StepStats).changed += made.length;
          break;
        }
        case "fill": {
          // A backfill (10.3): a record lacking the key, at the level named, where the condition holds, gets the
          // value read under the facet; a record that has one is left alone.
          if (v !== undefined) break;
          if (s.level && rec.level !== s.level) break;
          if (s.when && evaluate(parseCondition(s.when, s.line), values) !== true) break;
          const f = dict.facets.get(s.facet);
          const filled = f ? readUnder(f, s.value, dict) : undefined;
          if (filled !== undefined) values[s.facet] = filled as Json;
          break;
        }
      }
      if (stats) {
        const st = stats[si] as StepStats;
        if (s.verb !== "parts" && serialize((values[s.facet] ?? null) as Json) !== before) st.changed += 1;
        st.review += review.length - reviewsBefore;
      }
    });
    return { ...rec, values, ...(parts?.length ? { parts } : {}), ...(Object.keys(sources).length ? { sources } : {}) };
  });
  return { records: out, review };
}

/** What a restamp would do, without doing it (10.4): per step, how many values change and how many go to review. */
export function dryRun(records: Record[], recipe: Recipe, dict: Dictionary): { steps: StepStats[]; records: number; review: number } {
  const stats: StepStats[] = [];
  const { review } = restamp(structuredClone(records), recipe, dict, stats);
  return { steps: stats, records: records.length, review: review.length };
}
