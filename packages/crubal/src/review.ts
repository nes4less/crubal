// review.ts: review decisions as writes (spec 9.5, 10.4, 11.9, 14.7; docs/design/completion.md A). A
// decision is one entry: the `review` write that records it, and the writes it causes: a `define` of the
// facet, contract or units extension it changed, a value made current from a suggestion or a held bag, a
// suggestion denied. Nothing here replays or runs; a store does that after the entry lands.

import { contractJson } from "./bundle.ts";
import type { Dictionary, Facet } from "./defs.ts";
import { facetJson } from "./dictionary.ts";
import { split, type Store } from "./lifecycle.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import type { Contract } from "./store.ts";
import { CrubalError } from "./tree.ts";
import { extendUnits } from "./units.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Decision = JsonObject & { key: string; decision: string };

type Extra = Record & { alternatives?: { [a: string]: JsonObject[] }; suggestions?: { [a: string]: JsonObject[] }; held?: { [a: string]: JsonObject } };

export type Definitions = { dict: Dictionary; contracts: Map<string, Contract>; units?: JsonObject[] };

/** The units extension as text, for the units table (11.9). */
export function unitsExtensionText(measures: JsonObject[]): string {
  return measures
    .map((m) => {
      const lines = [`measure: ${m.measure}`];
      for (const k of ["dimension", "factor", "offset", "rounding", "uncefact"]) if (m[k] !== undefined) lines.push(`  ${k}: ${m[k]}`);
      if (Array.isArray(m.spellings) && m.spellings.length) lines.push(`  spellings: ${(m.spellings as string[]).join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Apply a decision to the draft and return the writes the entry carries beyond what the draft shows:
 * the review write and any define. Throws a CrubalError for a decision that can't be made.
 */
export function decide(d: Decision, store: Store, defs: Definitions): JsonObject[] {
  const review: JsonObject = { ...d };
  const key = d.key;
  if (key.startsWith("facet:")) {
    const f = defs.dict.facets.get(key.slice(6));
    if (!f) throw new CrubalError(`${key}: no such facet`);
    const next: Facet = { ...f, values: f.values ? f.values.map((v) => ({ ...v, aliases: [...v.aliases] })) : f.values, aliases: [...f.aliases] };
    if (d.decision === "add value") {
      if (!next.values) throw new CrubalError(`${key} isn't a choice`);
      if (next.values.some((v) => v.value === d.value)) throw new CrubalError(`${d.value} is already a value of ${f.key}`);
      next.values.push({ value: String(d.value), aliases: [] });
    } else if (d.decision === "add alias") {
      if (!next.values) throw new CrubalError(`${key} isn't a choice`);
      const v = next.values.find((x) => x.value === d.value);
      if (!v) throw new CrubalError(`${d.value} is not a value of ${f.key}`);
      v.aliases.push(String(d.alias));
    } else if (d.decision !== "reject") throw new CrubalError(`${key}: ${d.decision} isn't a decision`);
    if (d.decision === "reject") return [{ review }];
    defs.dict.facets.set(f.key, next);
    return [{ review }, { define: facetJson(next) }];
  }
  if (key.startsWith("contract:")) {
    const c = defs.contracts.get(key.slice(9));
    if (!c) throw new CrubalError(`${key}: no such contract`);
    const next: Contract = { ...c, reads: c.reads.map((m) => ({ ...m, values: [...m.values] })), ignore: [...c.ignore] };
    const field = String(d.field);
    if (d.decision === "map") {
      if (!defs.dict.facets.has(String(d.to)) && !String(d.to).includes(":")) throw new CrubalError(`${d.to} isn't a facet`);
      next.reads.push({ from: field, to: String(d.to), values: [], line: c.line, valueLines: [] });
    } else if (d.decision === "map value") {
      const m = next.reads.find((x) => x.from === field);
      if (!m) throw new CrubalError(`${c.name} doesn't read ${field}`);
      m.values.push([String(d.theirs), String(d.ours)]);
    } else if (d.decision === "ignore") next.ignore.push(field);
    else throw new CrubalError(`${key}: ${d.decision} isn't a decision`);
    defs.contracts.set(c.name, next);
    return [{ review }, { define: contractJson(next) }];
  }
  if (key.startsWith("unit:")) {
    const spelling = key.slice(5);
    const measures: JsonObject[] = [...(defs.units ?? [])];
    if (d.decision === "alias") {
      const have = measures.find((m) => m.measure === d.unit);
      if (have) have.spellings = [...((have.spellings as string[]) ?? []), spelling];
      else measures.push({ measure: String(d.unit), spellings: [spelling] });
    } else if (d.decision === "new unit") {
      const m: JsonObject = { measure: String(d.unit), dimension: String(d.dimension), factor: String(d.factor), spellings: [spelling] };
      if (d.offset !== undefined) m.offset = String(d.offset);
      measures.push(m);
    } else if (d.decision === "not a unit") return [{ review }];
    else throw new CrubalError(`${key}: ${d.decision} isn't a decision`);
    defs.units = measures;
    extendUnits(unitsExtensionText(measures));
    const writes: JsonObject[] = [{ review }, { define: { units: "extension", measures } }];
    // The facets that accept the unit from now on (4.2 `accepts`), each a define of its own.
    for (const key of Array.isArray(d.accepts) ? (d.accepts as string[]) : []) {
      const f = defs.dict.facets.get(key);
      if (!f) throw new CrubalError(`${key} isn't a facet`);
      if (!f.unit) throw new CrubalError(`${key} has no unit to accept ${d.unit} into`);
      const unit = String(d.unit);
      if (f.accepts.includes(unit)) continue;
      const next: Facet = { ...f, accepts: [...f.accepts, unit] };
      defs.dict.facets.set(key, next);
      writes.push({ define: facetJson(next) });
    }
    return writes;
  }
  if (key === "suggestion") {
    const r = store.records.get(String(d.record)) as Extra | undefined;
    if (!r) throw new CrubalError(`no record ${d.record}`);
    const address = String(d.address);
    const list = r.suggestions?.[address] ?? [];
    const pick = d.value === undefined ? list[0] : list.find((s) => JSON.stringify(s.value) === JSON.stringify(d.value));
    if (!pick) throw new CrubalError(`${r.id} has no suggestion at ${address}${d.value !== undefined ? ` with that value` : ""}`);
    const rest = list.filter((s) => s !== pick);
    const suggestions = { ...(r.suggestions ?? {}) };
    if (rest.length) suggestions[address] = rest;
    else delete suggestions[address];
    const next: Extra = { ...r, suggestions };
    if (!Object.keys(suggestions).length) delete next.suggestions;
    if (d.decision === "accept") {
      // The value with its original source (14.7).
      const source: Source = { origin: String(pick.origin ?? "reported"), via: String(pick.via ?? "") };
      if (typeof pick.owner === "string") source.owner = pick.owner;
      next.values = { ...r.values, [address]: pick.value as Json };
      next.sources = { ...(r.sources ?? {}), [address]: source };
    } else if (d.decision !== "deny") throw new CrubalError(`suggestion: ${d.decision} isn't a decision`);
    store.records.set(r.id, next);
    return [{ review: { ...review, value: pick.value as Json, ...(d.decision === "deny" ? { denied: true } : {}) } }];
  }
  if (key === "held") {
    const r = store.records.get(String(d.record)) as Extra | undefined;
    if (!r) throw new CrubalError(`no record ${d.record}`);
    const address = String(d.address);
    const h = r.held?.[address];
    if (!h) throw new CrubalError(`${r.id} holds nothing at ${address}`);
    const held = { ...(r.held ?? {}) };
    delete held[address];
    const next: Extra = { ...r, held };
    if (!Object.keys(held).length) delete next.held;
    if (d.decision === "value") {
      const value = d.value === undefined ? (h.value as Json) : (d.value as Json);
      next.values = { ...r.values, [address]: value };
      next.sources = { ...(r.sources ?? {}), [address]: (isObj(h.source) ? (h.source as unknown as Source) : { origin: "declared", via: "review" }) };
    } else if (d.decision !== "drop") throw new CrubalError(`held: ${d.decision} isn't a decision`);
    store.records.set(r.id, next);
    return [{ review }];
  }
  if (key.startsWith("split:")) {
    const record = key.slice(6);
    // The decision closes the item it answers: the same record, address and value (openItems).
    if (review.record === undefined) review.record = record;
    if (d.decision === "not a version") return [{ review }];
    if (d.decision !== "split") throw new CrubalError(`${key}: ${d.decision} isn't a decision`);
    const instances = Array.isArray(d.instances) ? (d.instances as string[]) : [];
    const values: JsonObject = typeof d.address === "string" && d.value !== undefined ? { [d.address]: d.value as Json } : {};
    split(store, record, String(d.into), { children: instances, values }, { origin: "observed", via: String(d.via ?? "review") });
    return [{ review }];
  }
  throw new CrubalError(`${key}: not a review item kind a decision applies to here`);
}

/** The review items still open: every item without a decision that no later decision names. */
export function openItems(items: JsonObject[]): JsonObject[] {
  const identity = (it: JsonObject) => JSON.stringify(["key", "record", "address", "run", "ref", "field", "value", "step"].map((k) => it[k] ?? null));
  const decided = new Set(items.filter((it) => it.decision !== undefined).map(identity));
  return items.filter((it) => it.decision === undefined && !decided.has(identity(it)));
}
