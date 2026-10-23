// projector.ts: projections and the projection stream (spec 12.6, docs/design/store.md). A write marks the
// rows it makes stale inside its own transaction, a row per (view, record); publishing drains those marks
// outside any write transaction, rebuilds only the marked rows with the engine's Views, upserts the
// projection and appends one stream entry per row that changed or left, numbered per view and audience.

import { Access, type Permissions } from "@cruba/crubal";
import { serialize } from "@cruba/crubal";
import type { Dictionary } from "@cruba/crubal";
import type { State } from "@cruba/crubal";
import type { Json, JsonObject, Record, View } from "@cruba/crubal";
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
  // What is marked and whether the view was ever published come first: a view with nothing stale costs
  // two small queries, never a read of every stored row (ME: fifteen views, thousands of rows each, on
  // every write). Stored rows are read in full only for a first or a reset publish; otherwise the marked ones.
  // Published before, and under which versions: the marker row, or (stores published before 0.1.16 kept
  // no marker) any stored row; an empty view published once is not published again whole.
  const marker = (await client.query("select version from published where owner = $1 and view = $2 and audience = $3", [owner, name, aud])).rows as Row[];
  const anyVersion = marker.length ? marker : ((await client.query("select distinct version from projections where owner = $1 and view = $2 and audience = $3", [owner, name, aud])).rows as Row[]);
  const published = anyVersion.length > 0;
  const reset = published && !anyVersion.some((r) => r.version === version);
  const marked = (await client.query("select record from stale where owner = $1 and view = $2 order by record", [owner, name])).rows as Row[];
  const full = !published || reset;
  const allMarked = full ? undefined : marked.map((r) => String(r.record));
  if (!full && !allMarked?.length) return [];
  // The marked rows are rebuilt in batches under a budget (brief 29, rule 2): a view with 347,000 rows marked
  // by an install was rebuilt in one working set and ran the function out of memory on every tick
  // (Media Encyclopedia, 2026-10-23). Each batch's marks go when its rows are written, so a run that stops at
  // the budget leaves the rest marked for the next; a full publish (first or reset) still goes in one.
  const BATCH = Math.max(1, Number(process.env.CRUBAL_PUBLISH_BATCH ?? "2000"));
  const BUDGET_MS = Number(process.env.CRUBAL_PUBLISH_BUDGET_MS ?? "45000");
  const started = Date.now();
  const all: StreamEntry[] = [];
  const batches: (string[] | undefined)[] = allMarked ? Array.from({ length: Math.ceil(allMarked.length / BATCH) }, (_, i) => allMarked.slice(i * BATCH, (i + 1) * BATCH)) : [undefined];
  for (const [i, only] of batches.entries()) {
    if (i > 0 && Date.now() - started > BUDGET_MS) break;
    all.push(...(await publishSet(client, owner, p, name, aud, version, projection, v, reset && i === 0, full, only)));
  }
  return all;
}

/** One set of a view's rows published: every row when `only` is undefined, else those records. */
async function publishSet(client: Client, owner: string, p: Projecting, name: string, aud: string, version: string, projection: string, v: View, reset: boolean, full: boolean, only: string[] | undefined): Promise<StreamEntry[]> {
  const stored = (
    full
      ? await client.query("select record, row, buckets, sort, pin, seq from projections where owner = $1 and view = $2 and audience = $3 and version = $4 order by seq", [owner, name, aud, version])
      : await client.query("select record, row, buckets, sort, pin, seq from projections where owner = $1 and view = $2 and audience = $3 and version = $4 and record = any($5) order by seq", [owner, name, aud, version, only])
  ).rows as Row[];
  // On a reset every row is announced again, whatever was stored: the index drops everything when the
  // reset arrives and keeps only what follows it.
  const last = new Map<string, string>(reset ? [] : stored.map((r) => [String(r.record), serialize({ row: r.row as JsonObject, buckets: (r.buckets ?? {}) as JsonObject, order: { sort: (r.sort ?? []) as Json, ...(r.pin ? { pin: Number(r.pin) } : {}) } })]));

  // The rows, on a working set that loads what the view reads.
  const needs = new Needs();
  const base = workingState(needs);
  await loadWhole(client, owner, base);
  const { out: now } = await settle(client, owner, base, (s) => {
    const views = new Views(p.dict, p.views, s.records);
    const access = p.perms ? new Access(p.dict, p.perms, s.records, [...s.edges.values()] as never[], owner) : undefined;
    if (access && p.views) access.views = p.views;
    const rows = new Map<string, { row: JsonObject; buckets: JsonObject; sort: string[]; pin?: number }>();
    // Every row in one pass: a page at a time selected and counted the whole view once per page.
    for (const row of views.project(name, { audience: aud, all: true, ...(access ? { access } : {}), ...(only ? { only } : {}) }).rows) {
      const rec = s.records.get(String(row.record));
      rows.set(String(row.record), { row, buckets: rec ? views.bucketsFor(v, rec) : {}, ...(rec ? views.sortOf(v, rec) : { sort: [] }) });
    }
    return rows;
  });

  const head = (await client.query("select coalesce(max(seq), 0) as seq from projection_stream where owner = $1 and view = $2 and audience = $3 and version = $4", [owner, name, aud, version])).rows[0] as { seq: string | number };
  // The stream continues from its head under this version: a fresh version starts at 1, and a version
  // come back to (a package reinstalled, a later one retired) continues past what it published before,
  // so an index resuming from its cursor for that version takes the reset and what follows.
  let seq = Number(head.seq);
  const entries: StreamEntry[] = [];
  const upserts: JsonObject[] = [];
  if (reset) await client.query("delete from projections where owner = $1 and view = $2 and audience = $3 and version <> $4", [owner, name, aud, version]);
  for (const [id, { row, buckets, sort, pin }] of now) {
    const s = serialize({ row, buckets, order: { sort, ...(pin ? { pin } : {}) } });
    if (last.get(id) === s) continue;
    const e: StreamEntry = { projection, audience: aud, seq: ++seq, record: id, row, ...(Object.keys(buckets).length ? { buckets } : {}), ...(sort.length ? { sort } : {}), ...(pin ? { pin } : {}) };
    if (reset && !entries.length) e.reset = true;
    entries.push(e);
    upserts.push({ id, row, buckets, sort, ...(pin ? { pin } : {}), seq });
  }
  // Rows that left: every stored row the rebuild didn't give back, among the records rebuilt.
  const gone = full ? [...last.keys()].filter((id) => !now.has(id)) : (only ?? []).filter((id) => last.has(id) && !now.has(id));
  for (const id of gone) {
    const e: StreamEntry = { projection, audience: aud, seq: ++seq, record: id, removed: true };
    if (reset && !entries.length) e.reset = true;
    entries.push(e);
  }
  // The stream and the rows written in batches, one statement per 500 entries rather than two per row
  // (ME: 9,437 units in one view; the round trips were a third of a full publish).
  for (const batch of chunks(entries, 500)) {
    await client.query("insert into projection_stream (owner, view, version, audience, seq, json) select $1, $2, $3, $4, (e ->> 'seq')::bigint, e from jsonb_array_elements($5::jsonb) as t(e)", [owner, name, version, aud, JSON.stringify(batch)]);
  }
  for (const batch of chunks(upserts, 500)) {
    await client.query(
      `insert into projections (owner, view, version, audience, record, row, buckets, marks, ancestors, sort, pin, seq)
       select $1, $2, $3, $4, e ->> 'id', e -> 'row', e -> 'buckets', e -> 'row' -> 'marks',
         coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(e -> 'row' -> 'ancestors') = 'array' then e -> 'row' -> 'ancestors' else '[]'::jsonb end)), '{}'),
         e -> 'sort', (e ->> 'pin')::integer, (e ->> 'seq')::bigint
       from jsonb_array_elements($5::jsonb) as t(e)
       on conflict (owner, view, version, audience, record) do update set row = excluded.row, buckets = excluded.buckets, marks = excluded.marks, ancestors = excluded.ancestors, sort = excluded.sort, pin = excluded.pin, seq = excluded.seq`,
      [owner, name, version, aud, JSON.stringify(batch)],
    );
  }
  if (gone.length) await client.query("delete from projections where owner = $1 and view = $2 and version = $3 and audience = $4 and record = any($5)", [owner, name, version, aud, gone]);
  if (reset && !entries.length) {
    // A new version with nothing changed still starts its stream: the index must drop the old rows.
    await client.query("delete from projection_stream where owner = $1 and view = $2 and audience = $3 and version <> $4", [owner, name, aud, version]);
  }
  await client.query("insert into published (owner, view, audience, version) values ($1, $2, $3, $4) on conflict (owner, view, audience) do update set version = excluded.version", [owner, name, aud, version]);
  if (only) await client.query("delete from stale where owner = $1 and view = $2 and record = any($3)", [owner, name, only]);
  else await client.query("delete from stale where owner = $1 and view = $2", [owner, name]);
  return entries;
}

/** The stream entries of a view for an audience after `seq`, for an index resuming from its cursor. */
export async function entriesSince(client: Client, owner: string, p: Projecting, name: string, seq: number, audience?: string, limit?: number): Promise<StreamEntry[]> {
  const v = p.views.views.get(name);
  if (!v) throw new Error(`no view ${name}`);
  const rows = (await client.query(`select json from projection_stream where owner = $1 and view = $2 and audience = $3 and version = $4 and seq > $5 order by seq${limit ? ` limit ${Math.max(1, Math.floor(limit))}` : ""}`, [owner, name, audience ?? v.show, v.version ?? "", seq])).rows as Row[];
  return rows.map((r) => r.json as StreamEntry);
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
