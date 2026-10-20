import type { Edge } from "@cruba/crubal";
// working.ts: the working set an operation runs over, loaded as it is needed. The engine is synchronous
// and pure, so an operation runs on a set that answers what it has and notes what it lacks; the store then
// loads what was lacking and runs the operation again on a fresh draft, until a run asks for nothing new.
// A run that reaches the end with every question answered saw the same records a whole-state load would
// have shown it, and touched only those.

import { serialize } from "@cruba/crubal";
import { emptyState, type State } from "@cruba/crubal";
import type { Json, JsonObject, Record } from "@cruba/crubal";
import { MemoryRecords } from "@cruba/crubal";
import type { Client } from "./db.ts";
import { recordOf } from "./state.ts";

/** What a run asked for and didn't have. A key names one load: an ID, or a question with its arguments. */
export class Needs {
  readonly pending = new Set<string>();
  /** Questions already answered: their rows are in the set, so a scan of it is the whole answer. */
  readonly answered = new Set<string>();
  /** IDs asked for that the store doesn't hold, so a miss isn't asked again. */
  readonly absent = new Set<string>();
  /** Every ID loaded, for the trace. */
  readonly loaded = new Set<string>();
  /** When set, `all()` throws this message instead of asking for the whole catalog (a store with `wholeState: refuse`). */
  refuseAll: string | undefined;

  want(key: string): void {
    if (!this.answered.has(key)) this.pending.add(key);
  }
}

/** A record set that notes what it lacks. Scans answer from what is loaded and note the question. */
export class WorkingRecords extends MemoryRecords {
  readonly needs: Needs;

  constructor(needs: Needs, entries?: Iterable<[string, Record]>) {
    super(entries);
    this.needs = needs;
  }

  override get(id: string): Record | undefined {
    const r = super.get(id);
    if (r === undefined && !this.needs.absent.has(id) && !this.needs.loaded.has(id)) this.needs.want(`record:${id}`);
    return r;
  }

  override has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  override all(): Record[] {
    if (this.needs.refuseAll) throw new Error(this.needs.refuseAll);
    this.needs.want("all");
    return super.all();
  }

  override atLevel(level: string): Record[] {
    this.needs.want(`level:${level}`);
    return super.atLevel(level);
  }

  override childrenOf(id: string, along: "of" | "within", level?: string): Record[] {
    this.needs.want(`children:${along}:${id}:${level ?? ""}`);
    return super.childrenOf(id, along, level);
  }

  override forTarget(name: string): Record[] {
    this.needs.want(`for:${name}`);
    return super.forTarget(name);
  }

  override byKey(key: string, value: Json, level?: string): Record[] {
    this.needs.want(`key:${level ?? ""}:${key}:${serialize(value)}`);
    return super.byKey(key, value, level);
  }
}

/** A map (bindings, runs) that notes a missed key, and notes that it was walked whole. */
export class WorkingMap<V> extends Map<string, V> {
  readonly needs: Needs;
  readonly table: string;

  constructor(needs: Needs, table: string, entries?: Iterable<[string, V]>) {
    super(entries);
    this.needs = needs;
    this.table = table;
  }

  override get(key: string): V | undefined {
    const v = super.get(key);
    if (v === undefined && !this.needs.absent.has(`${this.table}:${key}`)) this.needs.want(`${this.table}:${key}`);
    return v;
  }

  override has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  private whole(): void {
    this.needs.want(`${this.table}:*`);
  }

  override [Symbol.iterator](): MapIterator<[string, V]> {
    this.whole();
    return super[Symbol.iterator]();
  }

  override entries(): MapIterator<[string, V]> {
    this.whole();
    return super.entries();
  }

  override keys(): MapIterator<string> {
    this.whole();
    return super.keys();
  }

  override values(): MapIterator<V> {
    this.whole();
    return super.values();
  }

  override forEach(fn: (value: V, key: string, map: Map<string, V>) => void, thisArg?: unknown): void {
    this.whole();
    super.forEach(fn, thisArg);
  }
}

/** An empty working state for one run: records, bindings and runs load on demand; the rest is loaded whole. */
export function workingState(needs: Needs): State {
  const s = emptyState();
  s.records = new WorkingRecords(needs);
  s.bindings = new WorkingMap<string>(needs, "binding");
  s.runs = new WorkingMap<JsonObject>(needs, "run");
  return s;
}

/** Freeze a loaded record through and through: a run reads it in place and replaces it to change it. */
function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as { [k: string]: unknown })[k]);
  }
  return v;
}

/**
 * A copy of a working state to run an operation on, sharing the needs and the knowledge of what is loaded.
 * Loaded records are shared, not cloned: they are frozen at load, and an operation changes a record only
 * by setting a new one, so a copy costs the map, not the catalog (completion.md R).
 */
export function copyWorking(base: State): State {
  const needs = (base.records as WorkingRecords).needs;
  const s = workingState(needs);
  for (const [id, r] of Map.prototype.entries.call(base.records) as Iterable<[string, Record]>) Map.prototype.set.call(s.records, id, r);
  for (const [k, v] of (base.bindings as WorkingMap<string>).entries()) s.bindings.set(k, v);
  for (const [k, v] of (base.runs as WorkingMap<JsonObject>).entries()) s.runs.set(k, structuredClone(v));
  for (const [k, v] of base.edges) s.edges.set(k, structuredClone(v));
  for (const [k, v] of base.instructions) s.instructions.set(k, structuredClone(v));
  for (const [k, v] of base.definitions) s.definitions.set(k, structuredClone(v));
  for (const x of base.observations) s.observations.push(structuredClone(x));
  for (const x of base.reviews) s.reviews.push(structuredClone(x));
  for (const x of base.installed) s.installed.push(structuredClone(x));
  for (const x of base.reads) s.reads.push(structuredClone(x));
  return s;
}

type Row = { [column: string]: unknown };

/** Load the small, whole tables an operation always needs: edges, instructions and definitions. */
export async function loadWhole(client: Client, owner: string, into: State): Promise<void> {
  const q = async (sql: string) => (await client.query(sql, [owner])).rows as Row[];
  for (const row of await q("select edge, json from edges where owner = $1 order by ord")) into.edges.set(String(row.edge), row.json as unknown as Edge);
  for (const row of await q("select issuer, json from instructions where owner = $1 order by issuer, n")) {
    const issuer = String(row.issuer);
    into.instructions.set(issuer, [...(into.instructions.get(issuer) ?? []), row.json as JsonObject]);
  }
  for (const row of await q("select key, json from definitions where owner = $1 order by ord")) into.definitions.set(String(row.key), row.json as JsonObject);
}

/** Answer every pending need from the tables, into the base working state. */
export async function loadNeeds(client: Client, owner: string, needs: Needs, into: State): Promise<void> {
  const records = into.records as WorkingRecords;
  const put = (rows: Row[]) => {
    for (const row of rows) {
      const r = recordOf(row);
      if (!needs.loaded.has(r.id)) {
        // `set` on the base, not through the noting `get`; frozen, because every copy shares it.
        MemoryRecords.prototype.set.call(records, r.id, deepFreeze(r));
        needs.loaded.add(r.id);
      }
    }
  };
  const sel = "select * from records where owner = $1";
  // Records asked for one by one, and children asked for parent by parent, are fetched in one query per
  // kind: a view's shape reading each row's parent asked 11,299 single-row questions on ME's offers.
  const byId: string[] = [];
  const children = new Map<string, { along: string; level: string; ids: string[] }>();
  for (const key of [...needs.pending]) {
    if (needs.answered.has(key)) {
      needs.pending.delete(key);
      continue;
    }
    const [kind, ...rest] = key.split(":");
    if (kind === "record") {
      byId.push(rest.join(":"));
      needs.pending.delete(key);
      needs.answered.add(key);
    } else if (kind === "children") {
      const [along, id, level] = rest as [string, string, string];
      const g = children.get(`${along}|${level}`) ?? { along, level, ids: [] };
      g.ids.push(id);
      children.set(`${along}|${level}`, g);
      needs.pending.delete(key);
      needs.answered.add(key);
    }
  }
  if (byId.length) {
    const rows = (await client.query(`${sel} and id = any($2) order by ord`, [owner, byId])).rows as Row[];
    const found = new Set(rows.map((r) => String(r.id)));
    put(rows);
    for (const id of byId) if (!found.has(id)) needs.absent.add(id);
  }
  for (const { along, level, ids } of children.values()) {
    const col = along === "of" ? '"of"' : "within";
    put((await client.query(`${sel} and ${col} = any($2)${level ? " and level = $3" : ""} order by ord`, level ? [owner, ids, level] : [owner, ids])).rows as Row[]);
  }
  for (const key of [...needs.pending]) {
    needs.pending.delete(key);
    if (needs.answered.has(key)) continue;
    const [kind, ...rest] = key.split(":");
    const arg = rest.join(":");
    if (kind === "all") {
      put((await client.query(`${sel} order by ord`, [owner])).rows as Row[]);
    } else if (kind === "level") {
      put((await client.query(`${sel} and level = $2 order by ord`, [owner, arg])).rows as Row[]);
    } else if (kind === "for") {
      put((await client.query(`${sel} and ($2 = any(wears) or level = $2 or kind = $2) order by ord`, [owner, arg])).rows as Row[]);
    } else if (kind === "key") {
      const [level, facet, ...valueParts] = rest as [string, string, ...string[]];
      const value = valueParts.join(":");
      put((await client.query(`${sel}${level ? " and level = $4" : ""} and doc -> 'values' -> $2 = $3::jsonb order by ord`, level ? [owner, facet, value, level] : [owner, facet, value])).rows as Row[]);
    } else if (kind === "binding") {
      const map = into.bindings as WorkingMap<string>;
      if (arg === "*") {
        for (const row of (await client.query("select key, record from bindings where owner = $1 order by ord", [owner])).rows as Row[]) Map.prototype.set.call(map, String(row.key), String(row.record));
      } else {
        const { rows } = await client.query("select record from bindings where owner = $1 and key = $2", [owner, arg]);
        if (rows.length) Map.prototype.set.call(map, arg, String((rows[0] as Row).record));
        else needs.absent.add(key);
      }
    } else if (kind === "run") {
      const map = into.runs as WorkingMap<JsonObject>;
      if (arg === "*") {
        for (const row of (await client.query("select run, json from runs where owner = $1 order by ord", [owner])).rows as Row[]) Map.prototype.set.call(map, String(row.run), row.json as JsonObject);
      } else {
        const { rows } = await client.query("select json from runs where owner = $1 and run = $2", [owner, arg]);
        if (rows.length) Map.prototype.set.call(map, arg, (rows[0] as Row).json as JsonObject);
        else needs.absent.add(key);
      }
    }
    needs.answered.add(key);
  }
}

/**
 * Run an operation to a fixpoint: on a fresh copy of the base each time, loading what the last run lacked,
 * until a run lacks nothing. Returns the copy the final run worked on. `run` MUST be a pure function of
 * the state it is given; it is called again whenever the set grew.
 */
export async function settle<T>(client: Client, owner: string, base: State, run: (s: State) => T, most = 25): Promise<{ state: State; out: T }> {
  const needs = (base.records as WorkingRecords).needs;
  for (let i = 0; i < most; i++) {
    const state = copyWorking(base);
    let out: T;
    try {
      out = run(state);
    } catch (e) {
      // A run that failed because something wasn't loaded yet is run again once it is.
      if (!needs.pending.size) throw e;
      await loadNeeds(client, owner, needs, base);
      continue;
    }
    if (!needs.pending.size) return { state, out };
    await loadNeeds(client, owner, needs, base);
  }
  throw new Error(`the operation kept asking for more after ${most} loads`);
}
