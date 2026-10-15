// state.ts: an owner's state in the tables, read into the engine's State and written back as the diff of
// two states. The engine's applyEntry is the one meaning of a write; this file only persists its result,
// so the Postgres store can never apply an entry differently from the memory one.

import { serialize } from "../../crubal/src/canonical.ts";
import { emptyState, type State } from "../../crubal/src/log.ts";
import type { Json, JsonObject, Record } from "../../crubal/src/model.ts";
import type { Client } from "./db.ts";

const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Row = { [column: string]: unknown };

/** A record as the engine holds it, from its row. Absent members stay absent. */
export function recordOf(row: Row): Record {
  const doc = (row.doc ?? {}) as JsonObject;
  // The row's owner is the store's; the record's own owner (a hosted person's, another owner's) is in doc.
  const r: Record = { id: String(row.id), kind: String(row.kind), level: String(row.level), owner: String(doc.owner ?? row.owner), values: (doc.values ?? {}) as JsonObject };
  if (row.of) r.of = String(row.of);
  if (row.within) r.within = String(row.within);
  if (row.status) r.status = row.status as Record["status"];
  if (row.applied) r.applied = row.applied as Record["applied"];
  if (Array.isArray(row.wears) && row.wears.length) r.wears = row.wears.map(String);
  if (row.created) r.created = String(row.created);
  if (row.updated) r.updated = String(row.updated);
  const extra = r as unknown as JsonObject;
  for (const m of ["parts", "sources", "alternatives", "suggestions", "held"]) if (doc[m] !== undefined) extra[m] = doc[m] as Json;
  return r;
}

/** The members of a record that live in `doc`, not in a column. */
function docOf(r: Record): JsonObject {
  const x = r as unknown as JsonObject;
  const doc: JsonObject = { owner: r.owner, values: r.values };
  for (const m of ["parts", "sources", "alternatives", "suggestions", "held"]) if (x[m] !== undefined) doc[m] = x[m] as Json;
  return doc;
}

/** Every record up a record's `within` chain (14.2), nearest first. */
function ancestorsOf(records: Map<string, Record>, r: Record): string[] {
  const out: string[] = [];
  const seen = new Set<string>([r.id]);
  let cur = r.within;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = records.get(cur)?.within;
  }
  return out;
}

/** Read an owner's whole state. Order is the order the log made things, by `ord`. */
export async function loadState(client: Client, owner: string): Promise<State> {
  const state = emptyState();
  const q = async (sql: string) => (await client.query(sql, [owner])).rows as Row[];
  for (const row of await q("select * from records where owner = $1 order by ord")) state.records.set(String(row.id), recordOf(row));
  for (const row of await q("select edge, json from edges where owner = $1 order by ord")) state.edges.set(String(row.edge), row.json as JsonObject);
  for (const row of await q("select key, record from bindings where owner = $1 order by ord")) state.bindings.set(String(row.key), String(row.record));
  for (const row of await q("select issuer, json from instructions where owner = $1 order by issuer, n")) {
    const issuer = String(row.issuer);
    state.instructions.set(issuer, [...(state.instructions.get(issuer) ?? []), row.json as JsonObject]);
  }
  for (const row of await q("select json from observations where owner = $1 order by ord")) state.observations.push(row.json as JsonObject);
  for (const row of await q("select json from review where owner = $1 order by ord")) state.reviews.push(row.json as JsonObject);
  for (const row of await q("select run, json from runs where owner = $1 order by ord")) state.runs.set(String(row.run), row.json as JsonObject);
  for (const row of await q("select json from installed where owner = $1 order by ord")) state.installed.push(row.json as JsonObject);
  for (const row of await q("select json from reads where owner = $1 order by ord")) state.reads.push(row.json as JsonObject);
  for (const row of await q("select key, json from definitions where owner = $1 order by ord")) state.definitions.set(String(row.key), row.json as JsonObject);
  return state;
}

/** Write what changed between two states of one owner: upserts, deletes, and appends to the lists. */
export async function persist(client: Client, owner: string, before: State, after: State): Promise<void> {
  const changed = (a: unknown, b: unknown) => serialize((a ?? null) as Json) !== serialize((b ?? null) as Json);
  const beforeRecords = new Map<string, Record>(Map.prototype.entries.call(before.records) as Iterable<[string, Record]>);
  for (const [id, r] of Map.prototype.entries.call(after.records) as Iterable<[string, Record]>) {
    const was = beforeRecords.get(id);
    const ancestors = ancestorsOf(after.records, r);
    const wasAncestors = was ? ancestorsOf(beforeRecords, was) : undefined;
    if (was && !changed(was, r) && !changed(wasAncestors, ancestors)) continue;
    await client.query(
      `insert into records (owner, id, kind, level, "of", within, ancestors, status, applied, wears, created, updated, doc)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (owner, id) do update set kind = excluded.kind, level = excluded.level, "of" = excluded."of", within = excluded.within,
         ancestors = excluded.ancestors, status = excluded.status, applied = excluded.applied, wears = excluded.wears,
         created = excluded.created, updated = excluded.updated, doc = excluded.doc`,
      [owner, id, r.kind, r.level, r.of ?? null, r.within ?? null, ancestors, r.status ?? null, r.applied ?? null, r.wears ?? [], r.created ?? null, r.updated ?? null, docOf(r)],
    );
  }
  // Plain copies: a working map notes every walk and miss, and persisting is neither.
  const plain = <V>(m: Map<string, V>) => new Map<string, V>(Map.prototype.entries.call(m) as Iterable<[string, V]>);
  const upsertMap = async (table: string, keyCol: string, valCol: string, wasMap: Map<string, unknown>, nowMap: Map<string, unknown>, asJson = true) => {
    const was = plain(wasMap);
    const now = plain(nowMap);
    for (const [k, v] of now) {
      if (was.has(k) && !changed(was.get(k), v)) continue;
      await client.query(`insert into ${table} (owner, ${keyCol}, ${valCol}) values ($1, $2, $3) on conflict (owner, ${keyCol}) do update set ${valCol} = excluded.${valCol}`, [owner, k, asJson ? v : String(v)]);
    }
    for (const k of was.keys()) if (!now.has(k)) await client.query(`delete from ${table} where owner = $1 and ${keyCol} = $2`, [owner, k]);
  };
  await upsertMap("edges", "edge", "json", before.edges, after.edges);
  await upsertMap("bindings", "key", "record", before.bindings, after.bindings, false);
  await upsertMap("runs", "run", "json", before.runs, after.runs);
  await upsertMap("definitions", "key", "json", before.definitions, after.definitions);
  for (const [issuer, list] of after.instructions) {
    const have = before.instructions.get(issuer)?.length ?? 0;
    for (let i = have; i < list.length; i++) {
      const ins = list[i] as JsonObject;
      await client.query("insert into instructions (owner, issuer, n, json) values ($1, $2, $3, $4) on conflict do nothing", [owner, issuer, Number(ins.n ?? i + 1), ins]);
    }
  }
  const appendList = async (table: string, was: JsonObject[], now: JsonObject[]) => {
    for (const item of now.slice(was.length)) await client.query(`insert into ${table} (owner, json) values ($1, $2)`, [owner, item]);
  };
  await appendList("observations", before.observations, after.observations);
  await appendList("review", before.reviews, after.reviews);
  await appendList("installed", before.installed, after.installed);
  await appendList("reads", before.reads, after.reads);
}

/** Forget an owner's state tables (not its log), before a rebuild. */
export async function wipeState(client: Client, owner: string): Promise<void> {
  for (const t of ["records", "edges", "bindings", "instructions", "review", "runs", "observations", "installed", "reads", "definitions", "projections", "projection_stream", "stale"]) {
    await client.query(`delete from ${t} where owner = $1`, [owner]);
  }
}

export { isObj };
