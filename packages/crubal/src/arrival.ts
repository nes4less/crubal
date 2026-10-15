// arrival.ts: finding the record a payload is for (spec 9.2a). A receive or take contract names the field
// that is the other side's own ID (`ref`); the store keeps a binding for every (contract, ref) it has
// decided. Resolution runs in order: bound, matched by a strong key, held with candidates, new. A review
// decision is a binding, so nothing is decided twice; a record is minted only when the arrival commits.

import { serialize } from "./canonical.ts";
import type { Dictionary } from "./defs.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import type { RecordSet } from "./records.ts";
import { type Contract, fieldPath, type IntakeRecord, land, receive } from "./store.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Arrival = {
  outcome: "bound" | "matched" | "held" | "new";
  record?: string;
  candidates?: string[];
  /** The candidates that are archived (9.2a). */
  archived?: string[];
  /** How it was found: `binding`, `identify:<key>`, `match:<keys>`. */
  by?: string;
  ref?: string;
};

export type ArrivalStore = { records: RecordSet; bindings: Map<string, string> };

/** The value at a payload field path, or undefined. */
function fieldValue(payload: Json, path: string): Json | undefined {
  let at: Json | undefined = payload;
  for (const name of fieldPath(path)) {
    if (!isObj(at)) return undefined;
    at = at[name];
  }
  return at;
}

/** Follow a merged record to its survivor (1.12). */
export function surviving(store: ArrivalStore, id: string): string {
  let cur = id;
  for (let i = 0; i < 100; i++) {
    const r = store.records.get(cur);
    if (!r || r.status?.reason !== "merged" || !r.status.into) return cur;
    cur = r.status.into;
  }
  return cur;
}

const same = (a: Json | undefined, b: Json | undefined) => a !== undefined && b !== undefined && serialize(a) === serialize(b);

/**
 * Resolve where a payload lands, fold it there (or hold it), and keep the binding. `mint` names a new
 * record. The caller supplies the level the payload arrives at and, when known, its parent.
 */
export function arrive(
  c: Contract,
  body: string,
  level: string,
  store: ArrivalStore,
  dict: Dictionary,
  opts: { mint: () => string; owner: string; of?: string; source?: Source; intakeId?: string },
): { arrival: Arrival; intake: IntakeRecord; record?: Record } {
  const intake = receive(c, body, "", dict, opts.intakeId);
  const payload = JSON.parse(body) as Json;
  const values: JsonObject = {};
  for (const o of intake.outcomes) if (o.to && o.value !== undefined && (o.outcome === "absorbed" || o.outcome === "new")) values[o.to] = o.value;
  const ref = c.ref ? fieldValue(payload, c.ref) : undefined;
  const refText = ref === undefined ? undefined : typeof ref === "string" ? ref : serialize(ref);
  const bindKey = refText === undefined ? undefined : `${c.name}|${refText}`;
  const source: Source = opts.source ?? { origin: c.origin, via: intake.intake };
  const atLevel = store.records.atLevel(level);
  const active = (r: Record) => !r.status || r.status.state === "active";
  const finish = (arrival: Arrival, record: Record | undefined) => {
    if (record) {
      const landed = land(record, { outcomes: intake.outcomes, contract: c.name }, source, dict.trust, dict.facetTrust);
      store.records.set(landed.id, landed);
      if (bindKey) store.bindings.set(bindKey, landed.id);
      return { arrival: { ...arrival, record: landed.id, ...(refText !== undefined ? { ref: refText } : {}) }, intake: { ...intake, for: landed.id }, record: landed };
    }
    return { arrival: { ...arrival, ...(refText !== undefined ? { ref: refText } : {}) }, intake };
  };

  // 1. Already bound: it goes to that record, whatever its status; a merged one resolves through `into`.
  if (bindKey && store.bindings.has(bindKey)) {
    const id = surviving(store, store.bindings.get(bindKey) as string);
    return finish({ outcome: "bound", by: "binding" }, store.records.get(id));
  }
  // 2. A strong key matches one record, active or archived; a merged one resolves through `into`.
  for (const key of dict.identify.get(level) ?? []) {
    if (values[key] === undefined) continue;
    const hits = [...new Set(atLevel.filter((r) => same(r.values[key], values[key])).map((r) => surviving(store, r.id)))];
    if (hits.length === 1) return finish({ outcome: "matched", by: `identify:${key}` }, store.records.get(hits[0] as string));
    if (hits.length > 1) return finish({ outcome: "held", candidates: hits.sort(), by: `identify:${key}` }, undefined);
  }
  // 3. Weak keys find candidates: held, nothing minted. An archived candidate is proposed too, flagged, so
  //    a discontinued thing coming back under a new reference isn't minted twice; review decides.
  const candidates = new Set<string>();
  const archived = new Set<string>();
  const hows: string[] = [];
  for (const group of dict.match.get(level) ?? []) {
    if (group.some((k) => values[k] === undefined)) continue;
    const hits = atLevel.filter((r) => r.status?.reason !== "merged" && group.every((k) => same(r.values[k], values[k])));
    if (hits.length) {
      for (const h of hits) {
        candidates.add(h.id);
        if (!active(h)) archived.add(h.id);
      }
      hows.push(group.join("+"));
    }
  }
  if (candidates.size) return finish({ outcome: "held", candidates: [...candidates].sort(), by: `match:${hows.join(";")}`, ...(archived.size ? { archived: [...archived].sort() } : {}) }, undefined);
  // 4. New: minted at commit, and bound.
  const id = opts.mint();
  const rec: Record = { id, kind: dict.levels.get(level) ?? level, level, owner: opts.owner, values: {} };
  if (opts.of) rec.of = opts.of;
  return finish({ outcome: "new" }, rec);
}

/** A review decision for a held arrival (9.2a): bind the reference to a record, or to a new one. */
export function decide(
  c: Contract,
  held: { intake: IntakeRecord; ref?: string },
  choice: { record: string } | { new: true },
  store: ArrivalStore,
  dict: Dictionary,
  opts: { mint: () => string; owner: string; level: string; of?: string; source?: Source },
): { arrival: Arrival; record: Record } {
  const source: Source = opts.source ?? { origin: c.origin, via: held.intake.intake };
  let target: Record;
  if ("record" in choice) {
    const r = store.records.get(surviving(store, choice.record));
    if (!r) throw new Error(`no record ${choice.record}`);
    target = r;
  } else {
    target = { id: opts.mint(), kind: dict.levels.get(opts.level) ?? opts.level, level: opts.level, owner: opts.owner, values: {} };
    if (opts.of) target.of = opts.of;
  }
  const landed = land(target, { outcomes: held.intake.outcomes, contract: c.name }, source, dict.trust, dict.facetTrust);
  store.records.set(landed.id, landed);
  if (held.ref !== undefined) store.bindings.set(`${c.name}|${held.ref}`, landed.id);
  return { arrival: { outcome: "record" in choice ? "bound" : "new", record: landed.id, by: "review", ...(held.ref !== undefined ? { ref: held.ref } : {}) }, record: landed };
}
