// log.ts: the log as effects (spec 8.5) and rebuild (8.5.3). An entry says exactly what changed in the
// stored state: value writes with their source and where they landed, envelope writes, observations,
// bindings, review decisions, instructions, runs, installs and (under an emergency edge) reads. Rebuilding
// applies the entries in order to an empty store and needs no rules, so it gives back exactly the state the
// store had. Redacted entries are skipped, and only value, observation and read writes may be redacted.

import type { Edge } from "./access.ts";
import { serialize } from "./canonical.ts";
import type { Json, JsonObject, Record, Source, Status } from "./model.ts";
import { MemoryRecords, type RecordSet } from "./records.ts";
import { writeHash } from "./store.ts";
import { CrubalError } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Entry = JsonObject;

/** Everything a store holds that the log carries. */
export type State = {
  records: RecordSet;
  /** Every edge written, by id; the store's commit checks each (14.5, 14.12) before it lands here. */
  edges: Map<string, Edge>;
  /** `contract|ref` → record */
  bindings: Map<string, string>;
  /** issuer → its instructions, in order */
  instructions: Map<string, JsonObject[]>;
  observations: JsonObject[];
  reviews: JsonObject[];
  runs: Map<string, JsonObject>;
  installed: JsonObject[];
  reads: JsonObject[];
  /** The owner's working package (11.4): `<member>:<name>` → the definition as it now stands. */
  definitions: Map<string, JsonObject>;
};

export function emptyState(): State {
  return { records: new MemoryRecords(), edges: new Map(), bindings: new Map(), instructions: new Map(), observations: [], reviews: [], runs: new Map(), installed: [], reads: [], definitions: new Map() };
}

// A filter names its facet in a `facet` field, a view its `shape`, a contract its `kind`: the member kinds
// that carry another kind's word are read first, so `{filter, facet}` is a filter and never a facet.
const MEMBERS = ["filter", "view", "contract", "facet", "class", "rule", "kind", "shape", "display", "permissions", "ownership", "units", "utility"];

/** The key of a `define` write's member: which kind of member, and its name. */
function memberKey(def: JsonObject): string | null {
  for (const m of MEMBERS) if (typeof def[m] === "string") return `${m}:${def[m]}`;
  return null;
}

type Extra = Record & { alternatives?: { [a: string]: JsonObject[] }; suggestions?: { [a: string]: JsonObject[] }; held?: { [a: string]: JsonObject } };

/** The source a value write carries: the write's own, else the entry's default, with `via` the entry. */
function sourceOf(entry: Entry, write: JsonObject): Source {
  const base = isObj(entry.source) ? entry.source : {};
  const own = isObj(write.source) ? write.source : {};
  const merged = { ...base, ...own } as Partial<Source>;
  // A copied value keeps the source of where it came from (1.12, 1.7), so a write may name its own `via`.
  const s: Source = { origin: merged.origin ?? "reported", via: merged.via ?? String(entry.log) };
  if (merged.owner) s.owner = merged.owner;
  if (merged.adopted) s.adopted = true;
  // The terms a value was taken under (7.8) ride on the write and come back with it.
  if (typeof merged.until === "string") s.until = merged.until;
  if (merged.reshare === false) s.reshare = false;
  if (merged.revocable === true) s.revocable = true;
  return s;
}

/** Set or remove the value at a top-level key or `parts[row].key` address. */
function place(r: Extra, address: string, value: Json | undefined, source: Source | undefined) {
  const part = address.match(/^parts\[([^\]]+)\]\.(\w+)$/);
  if (part) {
    const parts = (r.parts ?? []).filter(isObj);
    let p = parts.find((x) => String(x.$row) === part[1]);
    if (!p) {
      p = { $row: part[1] as string, values: {} };
      parts.push(p);
    }
    const values = isObj(p.values) ? { ...p.values } : {};
    if (value === undefined) delete values[part[2] as string];
    else values[part[2] as string] = value;
    p.values = values;
    r.parts = parts;
  } else if (value === undefined) delete r.values[address];
  else r.values[address] = value;
  if (source) {
    r.sources = { ...(r.sources ?? {}) };
    if (value === undefined) delete r.sources[address];
    else r.sources[address] = source;
  }
}

function need(state: State, id: string, what: string): Extra {
  const r = state.records.get(id);
  if (!r) throw new CrubalError(`${what} names ${id}, a record the log hasn't created`);
  // A record a working set shares between copies is frozen: the entry changes its own copy, set back.
  if (Object.isFrozen(r)) {
    const copy = structuredClone(r);
    state.records.set(id, copy);
    return copy as Extra;
  }
  return r as Extra;
}

/** Apply one entry's effects to the state. */
export function applyEntry(state: State, entry: Entry): void {
  if (typeof entry.redacted === "string") return;
  const writes = Array.isArray(entry.writes) ? entry.writes.filter(isObj) : [];
  for (const w of writes) {
    // A redacted write (8.5.2) is skipped: the state is rebuilt without what it held.
    if (typeof w.redacted === "string") continue;
    if (typeof w.envelope === "string") {
      if (typeof w.address === "string" && /^parts\[[^\]]+\]$/.test(w.address)) applyPartRow(state, entry, w);
      else applyEnvelope(state, entry, w);
      continue;
    }
    if (isObj(w.edge)) {
      state.edges.set(String(w.edge.edge), w.edge as unknown as Edge);
      continue;
    }
    if (typeof w.edge === "string" && w.removed === true) {
      state.edges.delete(w.edge);
      continue;
    }
    if (isObj(w.binding)) {
      const b = w.binding;
      const key = `${b.contract}|${b.ref}`;
      if (b.removed === true) state.bindings.delete(key);
      else state.bindings.set(key, String(b.record));
      continue;
    }
    if (isObj(w.instruction)) {
      const i = w.instruction;
      const issuer = String(i.issuer);
      state.instructions.set(issuer, [...(state.instructions.get(issuer) ?? []), i]);
      continue;
    }
    if (isObj(w.observation)) {
      state.observations.push(w.observation);
      continue;
    }
    if (isObj(w.review)) {
      state.reviews.push(w.review);
      continue;
    }
    if (typeof w.run === "string") {
      state.runs.set(w.run, { ...(state.runs.get(w.run) ?? {}), ...w });
      continue;
    }
    if (isObj(w.install)) {
      state.installed.push(w.install);
      continue;
    }
    if (isObj(w.define)) {
      // A member of the working package as it now stands, or retired (8.5, 11.4).
      const key = memberKey(w.define);
      if (!key) throw new CrubalError(`entry ${entry.log}: a define write names a ${MEMBERS.join(", ")}`);
      if (w.define.retired === true) state.definitions.delete(key);
      else state.definitions.set(key, w.define);
      continue;
    }
    if (typeof w.read === "string") {
      state.reads.push({ record: w.read, log: String(entry.log), by: (entry.by ?? "") as Json });
      continue;
    }
    if (typeof w.record === "string" && typeof w.address === "string") {
      applyValue(state, entry, w);
      continue;
    }
    throw new CrubalError(`entry ${entry.log} holds a write of no known kind: ${serialize(w)}`);
  }
}

function applyValue(state: State, entry: Entry, w: JsonObject) {
  const r = need(state, String(w.record), `entry ${entry.log}`);
  const address = String(w.address);
  const as = typeof w.as === "string" ? w.as : "current";
  const source = sourceOf(entry, w);
  const removed = w.removed === true;
  if (typeof entry.at === "string") r.updated = entry.at;
  if (as === "current") {
    place(r, address, removed ? undefined : (w.value as Json), source);
    // A value made current is no longer held there.
    if (r.held?.[address]) {
      const { [address]: _h, ...rest } = r.held;
      if (Object.keys(rest).length) r.held = rest;
      else delete r.held;
    }
    return;
  }
  if (as === "held" && removed) {
    // A hold let go by a decision (10.4): nothing comes back.
    const held = { ...(r.held ?? {}) };
    delete held[address];
    if (Object.keys(held).length) r.held = held;
    else delete r.held;
    return;
  }
  if (as === "held") {
    // Held: the value leaves the current state and waits, with the rule that held it (6.7).
    const held = { ...(r.held ?? {}) };
    const value = w.value ?? r.values[address];
    if (value === undefined) throw new CrubalError(`entry ${entry.log}: nothing at ${address} to hold`);
    const kept = isObj(w.source) ? w.source : undefined;
    held[address] = { value, ...(typeof w.rule === "string" ? { rule: w.rule } : {}), ...(typeof w.instruction === "string" ? { instruction: w.instruction } : {}), ...(kept ? { source: kept } : {}) };
    r.held = held;
    place(r, address, undefined, source);
    return;
  }
  const value = w.value;
  if (value === undefined && !removed) throw new CrubalError(`entry ${entry.log}: a value landing as ${as} needs its value`);
  if (as === "alternative" || as === "suggestion") {
    const bag = { ...(r[as === "alternative" ? "alternatives" : "suggestions"] ?? {}) };
    const item: JsonObject = { value: value as Json, origin: source.origin, via: source.via, ...(source.owner ? { owner: source.owner } : {}) };
    bag[address] = removed ? (bag[address] ?? []).filter((x) => serialize(x.value as Json) !== serialize(value as Json)) : [...(bag[address] ?? []), item];
    if (!bag[address]?.length) delete bag[address];
    if (as === "alternative") {
      if (Object.keys(bag).length) r.alternatives = bag;
      else delete r.alternatives;
    } else if (Object.keys(bag).length) r.suggestions = bag;
    else delete r.suggestions;
    return;
  }
  throw new CrubalError(`entry ${entry.log}: a value lands as current, alternative, suggestion or held, not ${as}`);
}

/** A part row's envelope (5.6): `wears` sets the row's classes, making the row when it is new; `row` removed drops it. */
function applyPartRow(state: State, entry: Entry, w: JsonObject) {
  const r = need(state, String(w.record), `entry ${entry.log}`);
  const row = String(w.address).slice("parts[".length, -1);
  const parts = (r.parts ?? []).filter(isObj) as JsonObject[];
  const member = String(w.envelope);
  if (typeof entry.at === "string") r.updated = entry.at;
  if (member === "row" && w.removed === true) {
    const left = parts.filter((p) => String(p.$row) !== row);
    if (left.length) r.parts = left;
    else delete r.parts;
    if (r.sources) for (const k of Object.keys(r.sources)) if (k.startsWith(`parts[${row}].`)) delete r.sources[k];
    return;
  }
  if (member !== "wears") throw new CrubalError(`entry ${entry.log}: no part envelope member ${member}`);
  // A row with no classes of its own (a unit's copy of a mirrored row, 1.6) carries no `wears` member at all.
  const wears = Array.isArray(w.value) ? w.value.map(String) : [];
  const have = parts.find((p) => String(p.$row) === row);
  if (have) {
    if (wears.length) have.wears = wears;
    else delete have.wears;
  } else parts.push({ $row: row, ...(wears.length ? { wears } : {}), values: {} });
  r.parts = parts;
}

function applyEnvelope(state: State, entry: Entry, w: JsonObject) {
  const id = String(w.record);
  const member = String(w.envelope);
  if (member === "created") {
    const v = isObj(w.value) ? w.value : {};
    const r: Record = { id, kind: String(v.kind), level: String(v.level), owner: String(v.owner ?? entry.owner ?? ""), values: {} };
    if (typeof v.of === "string") r.of = v.of;
    if (typeof v.within === "string") r.within = v.within;
    if (Array.isArray(v.wears)) r.wears = v.wears.map(String);
    if (typeof entry.at === "string") {
      r.created = entry.at;
      r.updated = entry.at;
    }
    state.records.set(id, r);
    return;
  }
  const r = need(state, id, `entry ${entry.log}`);
  if (typeof entry.at === "string") r.updated = entry.at;
  if (member === "of" || member === "within") {
    if (w.removed === true) delete r[member];
    else r[member] = String(w.value);
  } else if (member === "wears") r.wears = Array.isArray(w.value) ? w.value.map(String) : [];
  else if (member === "status") {
    const s = isObj(w.value) ? w.value : {};
    if (s.state === "archived") {
      const st: Status = { state: "archived" };
      if (typeof s.reason === "string") st.reason = s.reason;
      if (typeof s.into === "string") st.into = s.into;
      r.status = st;
    } else delete r.status;
  } else if (member === "applied") {
    const v = isObj(w.value) ? w.value : {};
    r.applied = { ...(r.applied ?? {}), ...Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Number(n)])) };
  } else throw new CrubalError(`entry ${entry.log}: no envelope member ${member}`);
}

/** Rebuild a store's state from its log alone (8.5.3). */
export function rebuild(entries: Entry[]): State {
  const state = emptyState();
  for (const e of entries) applyEntry(state, e);
  return state;
}

/** The state as JSON, for comparing and for a dump. */
export function stateJson(state: State): JsonObject {
  const out: JsonObject = { records: [...state.records.values()] as unknown as Json[] };
  if (state.edges.size) out.edges = [...state.edges.values()];
  if (state.bindings.size) out.bindings = Object.fromEntries(state.bindings);
  if (state.instructions.size) out.instructions = Object.fromEntries([...state.instructions].map(([k, v]) => [k, v as Json[]]));
  if (state.observations.length) out.observations = state.observations;
  if (state.reviews.length) out.reviews = state.reviews;
  if (state.runs.size) out.runs = [...state.runs.values()];
  if (state.installed.length) out.installed = state.installed;
  if (state.reads.length) out.reads = state.reads;
  if (state.definitions.size) out.definitions = [...state.definitions.values()];
  return out;
}

// ─── The journal: entries are the only way state changes ─────────────────────

/** What an operation works on: a scratch copy of the state. Nothing in it is the truth until it is logged. */
export type Draft = {
  records: RecordSet;
  bindings: Map<string, string>;
  instructions: Map<string, JsonObject[]>;
  edges: Map<string, Edge>;
  review: JsonObject[];
};

/** One write of an entry (8.5): a value at an address, an envelope field, a held value, an edge, a define, a review. */
export type Write = JsonObject & {
  record?: string;
  address?: string;
  value?: Json;
  removed?: true;
  envelope?: string;
  as?: "held";
  source?: JsonObject;
  edge?: Edge;
};

function sourceAt(r: Record, key: string): Source | undefined {
  return r.sources?.[key] ?? r.sources?.["*"];
}

const sameJson = (a: Json | undefined, b: Json | undefined) => serialize((a ?? "∅") as Json) === serialize((b ?? "∅") as Json);

/** The writes that take `before` to `after`: exactly the effects, nothing computed (8.5). */
export function diffWrites(before: State, after: Draft): JsonObject[] {
  const writes: JsonObject[] = [];
  for (const [id, r] of after.records) {
    const was = before.records.get(id) as Extra | undefined;
    const now = r as Extra;
    if (!was) {
      const v: JsonObject = { kind: now.kind, level: now.level, owner: now.owner };
      if (now.of) v.of = now.of;
      if (now.within) v.within = now.within;
      if (now.wears) v.wears = now.wears;
      writes.push({ record: id, envelope: "created", value: v });
    } else {
      for (const m of ["of", "within"] as const) {
        if (was[m] === now[m]) continue;
        writes.push(now[m] ? { record: id, envelope: m, value: now[m] as string } : { record: id, envelope: m, removed: true });
      }
      if (!sameJson(was.wears ?? [], now.wears ?? [])) writes.push({ record: id, envelope: "wears", value: now.wears ?? [] });
    }
    if (!sameJson((was?.status ?? {}) as unknown as Json, (now.status ?? {}) as unknown as Json)) writes.push({ record: id, envelope: "status", value: (now.status ?? { state: "active" }) as unknown as JsonObject });
    if (!sameJson(was?.applied ?? {}, now.applied ?? {})) writes.push({ record: id, envelope: "applied", value: now.applied ?? {} });
    const heldWas = was?.held ?? {};
    const heldNow = now.held ?? {};
    const newlyHeld = new Set(Object.keys(heldNow).filter((k) => !sameJson(heldWas[k], heldNow[k])));
    for (const k of newlyHeld) {
      const h = heldNow[k] as JsonObject;
      // The value's source rides with the hold, so a release gives it back as it was (6.7).
      const src = isObj(h.source) ? h.source : undefined;
      writes.push({ record: id, address: k, as: "held", value: h.value as Json, ...(typeof h.rule === "string" ? { rule: h.rule } : {}), ...(typeof h.instruction === "string" ? { instruction: h.instruction } : {}), ...(src ? { source: src } : {}) });
    }
    for (const k of Object.keys(heldWas)) if (heldNow[k] === undefined && now.values[k] === undefined) writes.push({ record: id, address: k, as: "held", removed: true });
    for (const [k, v] of Object.entries(now.values)) {
      const s = sourceAt(now, k);
      if (was && sameJson(was.values[k], v) && sameJson((sourceAt(was, k) ?? "") as Json, (s ?? "") as Json)) continue;
      writes.push({ record: id, address: k, value: v, ...(s ? { source: s as unknown as JsonObject } : {}) });
    }
    for (const k of Object.keys(was?.values ?? {})) if (now.values[k] === undefined && !newlyHeld.has(k)) writes.push({ record: id, address: k, removed: true });
    // Parts (5.6): a row's classes as an envelope write at `parts[row]`, its values as value writes at
    // `parts[row].key` with their sources, a row gone as a removed row. Without these a draft that landed a
    // part failed the log's own check, "the log doesn't describe the change" (2026-10-27).
    const partsWas = new Map(((was?.parts ?? []).filter(isObj) as JsonObject[]).map((p) => [String(p.$row), p]));
    const partsNow = new Map(((now.parts ?? []).filter(isObj) as JsonObject[]).map((p) => [String(p.$row), p]));
    for (const [row, p] of partsNow) {
      const q = partsWas.get(row);
      const at = `parts[${row}]`;
      const wearsNow = Array.isArray(p.wears) ? p.wears : [];
      if (!q || !sameJson(Array.isArray(q.wears) ? q.wears : [], wearsNow)) writes.push({ record: id, address: at, envelope: "wears", value: wearsNow });
      const vNow = isObj(p.values) ? p.values : {};
      const vWas = q && isObj(q.values) ? q.values : {};
      for (const [k, v] of Object.entries(vNow)) {
        const s = sourceAt(now, `${at}.${k}`);
        if (q && sameJson(vWas[k], v) && sameJson((sourceAt(was as Record, `${at}.${k}`) ?? "") as Json, (s ?? "") as Json)) continue;
        writes.push({ record: id, address: `${at}.${k}`, value: v, ...(s ? { source: s as unknown as JsonObject } : {}) });
      }
      for (const k of Object.keys(vWas)) if (vNow[k] === undefined) writes.push({ record: id, address: `${at}.${k}`, removed: true });
    }
    for (const row of partsWas.keys()) if (!partsNow.has(row)) writes.push({ record: id, address: `parts[${row}]`, envelope: "row", removed: true });
    for (const bag of ["alternatives", "suggestions"] as const) {
      const bw = was?.[bag] ?? {};
      // Items gone from the bag: accepted or denied (14.7), kept in the history as removed.
      for (const [addr, olds] of Object.entries(bw)) {
        const keep = (now[bag]?.[addr] ?? []).map((x) => serialize(x));
        for (const it of olds) if (!keep.includes(serialize(it))) writes.push({ record: id, address: addr, as: bag === "alternatives" ? "alternative" : "suggestion", value: it.value as Json, removed: true });
      }
      for (const [addr, items] of Object.entries(now[bag] ?? {})) {
        const old = (bw[addr] ?? []).map((x) => serialize(x));
        for (const it of items) {
          if (old.includes(serialize(it))) continue;
          const src: JsonObject = { origin: it.origin as Json, via: it.via as Json, ...(it.owner ? { owner: it.owner as Json } : {}) };
          writes.push({ record: id, address: addr, as: bag === "alternatives" ? "alternative" : "suggestion", value: it.value as Json, source: src });
        }
      }
    }
  }
  for (const [key, record] of after.bindings) {
    if (before.bindings.get(key) === record) continue;
    const at = key.indexOf("|");
    writes.push({ binding: { contract: key.slice(0, at), ref: key.slice(at + 1), record } });
  }
  for (const [issuer, list] of after.instructions) {
    const have = before.instructions.get(issuer)?.length ?? 0;
    for (const i of list.slice(have)) writes.push({ instruction: { issuer, ...i } });
  }
  for (const [id, e] of after.edges) if (!sameJson(before.edges.get(id), e)) writes.push({ edge: e });
  for (const id of before.edges.keys()) if (!after.edges.has(id)) writes.push({ edge: id, removed: true });
  for (const item of after.review.slice(before.reviews.length)) writes.push({ review: item });
  return writes;
}

/** A record with its sources spelled per key and its times dropped, so a draft and a rebuilt state compare. */
function normal(r: Record): Json {
  const x = r as Extra;
  const sources: JsonObject = {};
  for (const k of Object.keys(r.values)) {
    const s = sourceAt(r, k);
    if (s) sources[k] = s as unknown as JsonObject;
  }
  const { created: _c, updated: _u, sources: _s, ...rest } = x;
  return { ...(rest as unknown as JsonObject), sources };
}

/** Where a draft and a state disagree, or null. */
export function differs(state: State, draft: Draft): string | null {
  for (const [id, r] of draft.records) {
    const s = state.records.get(id);
    if (!s) return `${id} is in the draft but not the state`;
    if (serialize(normal(s)) !== serialize(normal(r))) return `${id}: draft ${serialize(normal(r))} state ${serialize(normal(s))}`;
  }
  for (const id of state.records.keys()) if (!draft.records.has(id)) return `${id} is in the state but not the draft`;
  for (const [k, v] of draft.bindings) if (state.bindings.get(k) !== v) return `binding ${k}`;
  for (const [k, v] of draft.instructions) if ((state.instructions.get(k)?.length ?? 0) !== v.length) return `instructions of ${k}`;
  return null;
}

/**
 * The journal (8.5): operations work on a draft, every change becomes an entry, and the state is only ever
 * what applying the entries gives. A commit whose entries don't describe the whole change is refused, so
 * the log can never fall behind the state.
 */
export class Journal {
  readonly state: State = emptyState();
  readonly entries: Entry[] = [];
  readonly draft: Draft;
  readonly owner: string;
  private n = 0;

  constructor(owner: string, records: Record[] = [], at?: string) {
    this.owner = owner;
    this.draft = { records: new MemoryRecords(), bindings: new Map(), instructions: new Map(), edges: new Map(), review: [] };
    for (const r of records) this.draft.records.set(r.id, structuredClone(r));
    if (records.length) this.commit({ migration: "backfill" }, () => {}, at);
  }

  /**
   * Run an operation on the draft, log what it changed, and apply the entry to the state. `extra` carries
   * writes the diff can't see (a run's state, a read under an emergency edge, a define).
   */
  commit(by: JsonObject, mutate: (draft: Draft) => void, at?: string, extra: JsonObject[] = []): Entry | null {
    mutate(this.draft);
    const writes = [...diffWrites(this.state, this.draft), ...extra];
    if (!writes.length) return null;
    this.n += 1;
    const entry: Entry = { log: `J-${this.n}`, owner: this.owner, at: at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by, writes };
    applyEntry(this.state, entry);
    this.entries.push(entry);
    const problem = differs(this.state, this.draft);
    if (problem) throw new CrubalError(`the log doesn't describe the change: ${problem}`);
    return entry;
  }
}

/**
 * Can this whole entry be redacted (8.5.2)? Only when it holds nothing but value, observation and read
 * writes and isn't witnessed; otherwise it is redacted write by write. Returns the reason it can't, or null.
 */
export function redactable(entry: Entry): string | null {
  if (entry.witnessed === true) return "a witnessed entry is never redacted";
  const writes = Array.isArray(entry.writes) ? entry.writes.filter(isObj) : [];
  for (const w of writes) if (redactableWrite(entry, w)) return "an entry holding a write that is never redacted is redacted write by write, never whole";
  return null;
}

/** Can this write be redacted (8.5.2)? Null when it can, else why not. */
export function redactableWrite(entry: Entry, w: JsonObject): string | null {
  if (entry.witnessed === true) return "a witnessed entry is never redacted";
  if (typeof w.redacted === "string") return null;
  const value = typeof w.record === "string" && typeof w.address === "string";
  if (value || isObj(w.observation) || typeof w.read === "string") return null;
  return "a write that created a record, changed its envelope or a definition, or wrote an edge, binding, review, instruction, run or install is never redacted";
}

/** Redact one write of an entry (8.5.2): it becomes its own hash, and the entry's hash stays where it was. */
export function redactWrite(entry: Entry, index: number): Entry {
  const writes = Array.isArray(entry.writes) ? [...entry.writes] : [];
  const w = writes[index];
  if (!isObj(w)) throw new Error(`no write ${index}`);
  const why = redactableWrite(entry, w);
  if (why) throw new Error(why);
  writes[index] = { redacted: `sha256:${writeHash(w)}` };
  return { ...entry, writes };
}
