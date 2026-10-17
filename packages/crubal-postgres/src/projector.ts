// projector.ts: projections and the projection stream (spec 12.6, docs/design/store.md). A write marks the
// rows it makes stale inside its own transaction, a row per (view, record); publishing drains those marks
// outside any write transaction, rebuilds only the marked rows with the engine's Views, upserts the
// projection and appends one stream entry per row that changed or left, numbered per view and audience.

import { Access, type Permissions } from "@cruba/crubal";
import { serialize } from "@cruba/crubal";
import type { Dictionary } from "@cruba/crubal";
import type { State } from "@cruba/crubal";
import type { Json, JsonObject, Record } from "@cruba/crubal";
import { type StreamEntry, Views, type ViewSet } from "@cruba/crubal";
import type { Client } from "./db.ts";
import { Needs, settle, workingState, loadWhole } from "./working.ts";

/** What a store needs to project: the dictionary, the views, and the permissions for partitioned ones. */
export type Projecting = { dict: Dictionary; views: ViewSet; perms?: Permissions };

type Row = { [column: string]: unknown };

/**
 * Mark the rows an entry made stale (12.6): for every record it changed, in every view, the rows whose
 * read set the change touched, worked out on the state as it was before the entry.
 */
export async function markStale(client: Client, owner: string, p: Projecting, before: State, after: State, seq: number): Promise<void> {
  const changed: Record[] = [];
  const beforeRecords = new Map<string, Record>(Map.prototype.entries.call(before.records) as Iterable<[string, Record]>);
  for (const [id, r] of Map.prototype.entries.call(after.records) as Iterable<[string, Record]>) {
    if (serialize((beforeRecords.get(id) ?? null) as JsonObject) !== serialize(r as unknown as JsonObject)) changed.push(r);
  }
  if (!changed.length) return;
  const { out } = await settle(client, owner, before, (s) => {
    const views = new Views(p.dict, p.views, s.records);
    const marks: [string, string][] = [];
    for (const name of p.views.views.keys()) for (const r of changed) for (const id of views.staleAfter(name, r)) marks.push([name, id]);
    return marks;
  });
  for (const [view, record] of out) {
    await client.query("insert into stale (owner, view, record, since) values ($1, $2, $3, $4) on conflict (owner, view, record) do update set since = least(stale.since, excluded.since)", [owner, view, record, seq]);
  }
}

/**
 * Publish one view for one audience: rebuild its stale rows (every row the first time, or after a new
 * version), compare them with the projection as stored, append the stream entries, and clear the marks.
 * Returns the entries published.
 */
export async function publish(client: Client, owner: string, p: Projecting, name: string, audience?: string): Promise<StreamEntry[]> {
  const v = p.views.views.get(name);
  if (!v) throw new Error(`no view ${name}`);
  const aud = audience ?? v.show;
  const version = v.version ?? "";
  const projection = version ? `${name} /${version}` : name;
  const stored = (await client.query("select record, row, buckets, sort, pin, seq from projections where owner = $1 and view = $2 and audience = $3 and version = $4 order by seq", [owner, name, aud, version])).rows as Row[];
  const anyVersion = (await client.query("select distinct version from projections where owner = $1 and view = $2 and audience = $3", [owner, name, aud])).rows as Row[];
  const published = anyVersion.length > 0;
  const reset = published && !anyVersion.some((r) => r.version === version);
  const last = new Map<string, string>(stored.map((r) => [String(r.record), serialize({ row: r.row as JsonObject, buckets: (r.buckets ?? {}) as JsonObject, order: { sort: (r.sort ?? []) as Json, ...(r.pin ? { pin: Number(r.pin) } : {}) } })]));
  const marked = (await client.query("select record from stale where owner = $1 and view = $2", [owner, name])).rows as Row[];
  const full = !published || reset;
  const only = full ? undefined : marked.map((r) => String(r.record));
  if (!full && !only?.length) return [];

  // The rows, on a working set that loads what the view reads.
  const needs = new Needs();
  const base = workingState(needs);
  await loadWhole(client, owner, base);
  const { out: now } = await settle(client, owner, base, (s) => {
    const views = new Views(p.dict, p.views, s.records);
    const access = p.perms ? new Access(p.dict, p.perms, s.records, [...s.edges.values()] as never[], owner) : undefined;
    if (access && p.views) access.shown = p.views.shown;
    const rows = new Map<string, { row: JsonObject; buckets: JsonObject; sort: string[]; pin?: number }>();
    for (let page = 1; ; page++) {
      const pr = views.project(name, { audience: aud, page, ...(access ? { access } : {}), ...(only ? { only } : {}) });
      for (const row of pr.rows) {
        const rec = s.records.get(String(row.record));
        rows.set(String(row.record), { row, buckets: rec ? views.bucketsFor(v, rec) : {}, ...(rec ? views.sortOf(v, rec) : { sort: [] }) });
      }
      if (page >= pr.pages) break;
    }
    return rows;
  });

  const head = (await client.query("select coalesce(max(seq), 0) as seq from projection_stream where owner = $1 and view = $2 and audience = $3 and version = $4", [owner, name, aud, version])).rows[0] as { seq: string | number };
  let seq = reset ? 0 : Number(head.seq);
  const entries: StreamEntry[] = [];
  const put = async (e: StreamEntry) => {
    entries.push(e);
    await client.query("insert into projection_stream (owner, view, version, audience, seq, json) values ($1, $2, $3, $4, $5, $6)", [owner, name, version, aud, e.seq, e]);
  };
  if (reset) await client.query("delete from projections where owner = $1 and view = $2 and audience = $3 and version <> $4", [owner, name, aud, version]);
  for (const [id, { row, buckets, sort, pin }] of now) {
    const s = serialize({ row, buckets, order: { sort, ...(pin ? { pin } : {}) } });
    if (last.get(id) === s) continue;
    const e: StreamEntry = { projection, audience: aud, seq: ++seq, record: id, row, ...(Object.keys(buckets).length ? { buckets } : {}), ...(sort.length ? { sort } : {}), ...(pin ? { pin } : {}) };
    if (reset && !entries.length) e.reset = true;
    await put(e);
    await client.query(
      "insert into projections (owner, view, version, audience, record, row, buckets, marks, ancestors, sort, pin, seq) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (owner, view, version, audience, record) do update set row = excluded.row, buckets = excluded.buckets, marks = excluded.marks, ancestors = excluded.ancestors, sort = excluded.sort, pin = excluded.pin, seq = excluded.seq",
      [owner, name, version, aud, id, row, buckets, row.marks ?? null, Array.isArray(row.ancestors) ? row.ancestors : [], JSON.stringify(sort), pin ?? null, seq],
    );
  }
  // Rows that left: every stored row the rebuild didn't give back, among the records rebuilt.
  const gone = full ? [...last.keys()].filter((id) => !now.has(id)) : (only ?? []).filter((id) => last.has(id) && !now.has(id));
  for (const id of gone) {
    const e: StreamEntry = { projection, audience: aud, seq: ++seq, record: id, removed: true };
    if (reset && !entries.length) e.reset = true;
    await put(e);
    await client.query("delete from projections where owner = $1 and view = $2 and version = $3 and audience = $4 and record = $5", [owner, name, version, aud, id]);
  }
  if (reset && !entries.length) {
    // A new version with nothing changed still starts its stream: the index must drop the old rows.
    await client.query("delete from projection_stream where owner = $1 and view = $2 and audience = $3 and version <> $4", [owner, name, aud, version]);
  }
  await client.query("delete from stale where owner = $1 and view = $2", [owner, name]);
  return entries;
}

/** The stream entries of a view for an audience after `seq`, for an index resuming from its cursor. */
export async function entriesSince(client: Client, owner: string, p: Projecting, name: string, seq: number, audience?: string): Promise<StreamEntry[]> {
  const v = p.views.views.get(name);
  if (!v) throw new Error(`no view ${name}`);
  const rows = (await client.query("select json from projection_stream where owner = $1 and view = $2 and audience = $3 and version = $4 and seq > $5 order by seq", [owner, name, audience ?? v.show, v.version ?? "", seq])).rows as Row[];
  return rows.map((r) => r.json as StreamEntry);
}
