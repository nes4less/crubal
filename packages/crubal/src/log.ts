// log.ts: the log as effects (spec 8.5) and rebuild (8.5.3). An entry says exactly what changed in the
// stored state: value writes with their source and where they landed, envelope writes, observations,
// bindings, review decisions, instructions, runs, installs and (under an emergency edge) reads. Rebuilding
// applies the entries in order to an empty store and needs no rules, so it gives back exactly the state the
// store had. Redacted entries are skipped, and only value, observation and read writes may be redacted.

import { serialize } from "./canonical.ts";
import type { Json, JsonObject, Record, Source, Status } from "./model.ts";
import { CrubalError } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Entry = JsonObject;

/** Everything a store holds that the log carries. */
export type State = {
  records: Map<string, Record>;
  edges: Map<string, JsonObject>;
  /** `contract|ref` → record */
  bindings: Map<string, string>;
  /** issuer → its instructions, in order */
  instructions: Map<string, JsonObject[]>;
  observations: JsonObject[];
  reviews: JsonObject[];
  runs: Map<string, JsonObject>;
  installed: JsonObject[];
  reads: JsonObject[];
};

export function emptyState(): State {
  return { records: new Map(), edges: new Map(), bindings: new Map(), instructions: new Map(), observations: [], reviews: [], runs: new Map(), installed: [], reads: [] };
}

type Extra = Record & { alternatives?: { [a: string]: JsonObject[] }; suggestions?: { [a: string]: JsonObject[] }; held?: { [a: string]: JsonObject } };

/** The source a value write carries: the write's own, else the entry's default, with `via` the entry. */
function sourceOf(entry: Entry, write: JsonObject): Source {
  const base = isObj(entry.source) ? entry.source : {};
  const own = isObj(write.source) ? write.source : {};
  const merged = { ...base, ...own } as { origin?: string; owner?: string; adopted?: boolean };
  const s: Source = { origin: merged.origin ?? "reported", via: String(entry.log) };
  if (merged.owner) s.owner = merged.owner;
  if (merged.adopted) s.adopted = true;
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
  return r as Extra;
}

/** Apply one entry's effects to the state. */
export function applyEntry(state: State, entry: Entry): void {
  if (typeof entry.redacted === "string") return;
  const writes = Array.isArray(entry.writes) ? entry.writes.filter(isObj) : [];
  for (const w of writes) {
    if (typeof w.envelope === "string") {
      applyEnvelope(state, entry, w);
      continue;
    }
    if (isObj(w.edge)) {
      state.edges.set(String(w.edge.edge), w.edge);
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
  if (as === "held") {
    // Held: the value leaves the current state and waits, with the rule that held it (6.7).
    const held = { ...(r.held ?? {}) };
    const value = w.value ?? r.values[address];
    if (value === undefined) throw new CrubalError(`entry ${entry.log}: nothing at ${address} to hold`);
    held[address] = { value, ...(typeof w.rule === "string" ? { rule: w.rule } : {}) };
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
    if (as === "alternative") r.alternatives = bag;
    else r.suggestions = bag;
    return;
  }
  throw new CrubalError(`entry ${entry.log}: a value lands as current, alternative, suggestion or held, not ${as}`);
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
  return out;
}

/**
 * Can this entry be redacted (8.5.2)? Only when it holds nothing but value, observation and read writes and
 * isn't witnessed. Returns the reason it can't, or null.
 */
export function redactable(entry: Entry): string | null {
  if (entry.witnessed === true) return "a witnessed entry is never redacted";
  const writes = Array.isArray(entry.writes) ? entry.writes.filter(isObj) : [];
  for (const w of writes) {
    const value = typeof w.record === "string" && typeof w.address === "string";
    if (!value && !isObj(w.observation) && typeof w.read !== "string") return `an entry that created a record, changed its envelope, or wrote an edge, binding, instruction, run or install is never redacted`;
  }
  return null;
}
