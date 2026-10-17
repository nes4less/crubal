// indexer.ts: the reference index (spec 12.6.1, docs/design/index-and-forms.md). It reads a view's
// projection stream from the store into its own tables, idempotently by (view, audience, seq), and serves
// pages, counts, partitions, role marks, search and indexability over the rows it holds. It is never the
// truth: a contract checks the store, and the index can be dropped and rebuilt from the stream.

import { Access } from "@cruba/crubal";
import type { Json, JsonObject } from "@cruba/crubal";
import { type Nested, partitionOf, type StreamEntry, type View } from "@cruba/crubal";
import type { Pool } from "@cruba/crubal-postgres";
import type { PgStore } from "@cruba/crubal-postgres";

type Row = { [column: string]: unknown };
const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The text an index searches: every string slot of the row, and every text inside its values. */
function textOf(row: JsonObject): string {
  const out: string[] = [];
  const walk = (v: Json) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (!["record", "marks", "ancestors"].includes(k)) walk(x);
  };
  walk(row);
  return out.join(" ");
}

export type Serve = { page?: number; picks?: { [filter: string]: string[] }; q?: string; caller?: string; /** A further shape the view names (12.1): its output serves in place of the row. */ shape?: string };
export type Page = { view: string; version: string; audience: string; seq: number; page: number; pages: number; rows: JsonObject[]; counts: { [filter: string]: { [bucket: string]: number } }; nested?: Nested; indexable: boolean };

export class Index {
  readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Pull a view's stream since the cursor into the rows, for the view's own audience. */
  async apply(store: PgStore, view: string): Promise<number> {
    const p = await store.definitions();
    const v = p.views.views.get(view);
    if (!v) throw new Error(`no view ${view}`);
    const version = v.version ?? "";
    const owner = store.owner;
    const cur = (await this.pool.query("select seq from index_cursors where owner = $1 and view = $2 and version = $3 and audience = $4", [owner, view, version, v.show])).rows[0] as Row | undefined;
    let seq = cur ? Number(cur.seq) : 0;
    const entries = await store.entriesSince(view, seq, v.show);
    return this.ingest(owner, view, version, v.show, entries, seq);
  }

  /** Apply stream entries to the rows, idempotently by seq (12.6.2): from a store's stream or pushed by a presenter. */
  async ingest(owner: string, view: string, version: string, audience: string, entries: StreamEntry[], from?: number): Promise<number> {
    const cur = (await this.pool.query("select seq from index_cursors where owner = $1 and view = $2 and version = $3 and audience = $4", [owner, view, version, audience])).rows[0] as Row | undefined;
    let seq = from ?? (cur ? Number(cur.seq) : 0);
    for (const e of entries) {
      if (e.seq <= seq) continue;
      if (e.reset) await this.pool.query("delete from index_rows where owner = $1 and view = $2 and audience = $3", [owner, view, audience]);
      if (e.removed) await this.pool.query("delete from index_rows where owner = $1 and view = $2 and version = $3 and audience = $4 and record = $5", [owner, view, version, audience, e.record]);
      else if (e.row) {
        await this.pool.query(
          `insert into index_rows (owner, view, version, audience, record, row, buckets, marks, ancestors, sort, pin, seq, search)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_tsvector('simple', $13))
           on conflict (owner, view, version, audience, record) do update set row = excluded.row, buckets = excluded.buckets, marks = excluded.marks,
             ancestors = excluded.ancestors, sort = excluded.sort, pin = excluded.pin, seq = excluded.seq, search = excluded.search`,
          [owner, view, version, audience, e.record, e.row, e.buckets ?? {}, e.row.marks ?? null, Array.isArray(e.row.ancestors) ? e.row.ancestors : [], JSON.stringify(e.sort ?? []), e.pin ?? null, e.seq, textOf(e.row)],
        );
      }
      seq = e.seq;
    }
    await this.pool.query("insert into index_cursors (owner, view, version, audience, seq) values ($1, $2, $3, $4, $5) on conflict (owner, view, version, audience) do update set seq = excluded.seq", [owner, view, version, audience, seq]);
    return seq;
  }

  /** The bucket names of a filter, in its order: declared buckets, else the facet's values. */
  private bucketNames(p: Awaited<ReturnType<PgStore["definitions"]>>, filter: string): string[] {
    const f = p.views.filters.get(filter);
    if (!f) return [];
    if (f.buckets) return f.buckets.map((b) => b.name);
    return (p.dict.facets.get(f.facet.replace(/^\w+::/, ""))?.values ?? []).map((v) => v.value);
  }

  /** Serve a page of a view (12.2, 12.3, 12.5) to a caller, from the rows the index holds. */
  async serve(store: PgStore, view: string, o: Serve = {}): Promise<Page> {
    const p = await store.definitions();
    const v: View | undefined = p.views.views.get(view);
    if (!v) throw new Error(`no view ${view}`);
    const version = v.version ?? "";
    const owner = store.owner;
    // The caller's audience decides whether this view is theirs to read (14.4): never a higher one.
    // Access only when the package declares permissions or relations: loading the state costs with the catalog.
    const needsAccess = p.perms.menu.size || p.perms.relations.size;
    const state = needsAccess ? await store.state() : undefined;
    const access = state ? new Access(p.dict, p.perms, state.records, [...state.edges.values()] as never[], owner) : undefined;
    if (access) access.shown = p.views.shown;
    const rank = (a: string) => ["public", "member", "staff", "owner"].indexOf(a);
    const audience = o.caller ? (access ? access.audienceOf(o.caller) : "member") : "public";
    if (o.caller === owner) {
      // the owner reads everything
    } else if (rank(audience) < rank(v.show)) throw Object.assign(new Error(`${view} is for ${v.show}`), { status: 403 });
    const cur = (await this.pool.query("select seq from index_cursors where owner = $1 and view = $2 and version = $3 and audience = $4", [owner, view, version, v.show])).rows[0] as Row | undefined;
    const where = ["owner = $1", "view = $2", "version = $3", "audience = $4"];
    const params: unknown[] = [owner, view, version, v.show];
    if (o.q) {
      params.push(o.q);
      where.push(`search @@ plainto_tsquery('simple', $${params.length})`);
    }
    let rows = (await this.pool.query(`select record, row, buckets, marks, ancestors, sort, pin from index_rows where ${where.join(" and ")}`, params)).rows as Row[];
    // Partition (12.6): a row is served when one of the caller's edges stands in the relation to it or an ancestor.
    const partition = partitionOf(v);
    if (partition !== "none" && o.caller !== owner) {
      if (!access || !o.caller) rows = [];
      else rows = rows.filter((r) => (access as Access).standsIn(o.caller as string, String(r.record), partition));
    }
    // Role marks: a slot marked with a role the caller doesn't hold is dropped.
    const roles = new Set<string>();
    if (access && o.caller && o.caller !== owner) for (const r of rows) for (const e of access.effective(o.caller, String(r.record)).edges) for (const g of e.grants) if (p.perms.presets.has(g)) roles.add(g);
    const picks = o.picks ?? {};
    const inPick = (r: Row, filter: string) => {
      const chosen = picks[filter] ?? [];
      if (!chosen.length) return true;
      const have = ((r.buckets as JsonObject)?.[filter] as string[] | undefined) ?? [];
      return chosen.some((c) => have.includes(c));
    };
    const passes = (r: Row, except?: string) => Object.keys(picks).every((f) => f === except || inPick(r, f));
    const counts: Page["counts"] = {};
    const nested: Nested = {};
    const bucketsOf = (r: Row, f: string) => ((r.buckets as JsonObject)?.[f] as string[] | undefined) ?? [];
    for (const f of v.filters) {
      const pool = rows.filter((r) => passes(r, f));
      counts[f] = Object.fromEntries(this.bucketNames(p, f).map((b) => [b, pool.filter((r) => bucketsOf(r, f).includes(b)).length]));
      // Dependent facets (12.3): their values counted inside each of this filter's buckets.
      const deps = p.views.filters.get(f)?.dependent ?? [];
      if (!deps.length) continue;
      nested[f] = Object.fromEntries(this.bucketNames(p, f).map((b) => {
        const inB = pool.filter((r) => bucketsOf(r, f).includes(b));
        return [b, Object.fromEntries(deps.map((d) => { const tally: { [value: string]: number } = {}; for (const r of inB) for (const val of bucketsOf(r, d)) tally[val] = (tally[val] ?? 0) + 1; return [d, tally]; }))];
      }));
    }
    const chosen = rows.filter((r) => passes(r));
    // The view's order, from what the store put on the row (12.7 sort and pin), then by record.
    const cmp = (a: Row, b: Row) => {
      const pa = a.pin ? Number(a.pin) : 0;
      const pb = b.pin ? Number(b.pin) : 0;
      if (pa || pb) return pa && pb ? pa - pb : pa ? -1 : 1;
      const sa = (a.sort as string[]) ?? [];
      const sb = (b.sort as string[]) ?? [];
      for (let i = 0; i < v.order.length; i++) {
        const x = sa[i] ?? "";
        const y = sb[i] ?? "";
        if (x !== y) return (x < y ? -1 : 1) * (v.order[i]?.dir === "after" ? -1 : 1);
      }
      return String(a.record) < String(b.record) ? -1 : String(a.record) > String(b.record) ? 1 : 0;
    };
    chosen.sort(cmp);
    const pages = Math.max(1, Math.ceil(chosen.length / v.page));
    const page = Math.max(1, o.page ?? 1);
    const onPage = chosen.slice((page - 1) * v.page, page * v.page);
    const pickList = Object.entries(picks).filter(([, c]) => c.length);
    const indexable = !o.q && page === 1 && (pickList.length === 0 || (pickList.length === 1 && v.index.includes(pickList[0]?.[0] as string) && pickList[0]?.[1].length === 1));
    if (o.shape && !v.shapes.includes(o.shape)) throw Object.assign(new Error(`${view} has no shape ${o.shape}`), { status: 404 });
    const out = onPage.map((r): JsonObject => {
      const stored = r.row as JsonObject;
      // A further shape (12.1) serves what the store put under shapes; the first shape is the row itself.
      if (o.shape && o.shape !== v.shapes[0]) return { record: stored.record as Json, ...(isObj(stored.shapes) && stored.shapes[o.shape] !== undefined ? { [o.shape === "crubal:jsonld" ? "jsonld" : o.shape === "crubal:portable" ? "values" : "row"]: stored.shapes[o.shape] as Json } : {}) };
      const row = { ...stored };
      delete row.shapes;
      const marks = isObj(row.marks) ? row.marks : undefined;
      if (marks) {
        for (const [slot, need] of Object.entries(marks)) {
          const needed = Array.isArray(need) ? (need as string[]) : [String(need)];
          if (o.caller !== owner && !needed.some((n) => roles.has(n))) delete row[slot];
        }
        delete row.marks;
      }
      delete row.ancestors;
      return row;
    });
    return { view, version, audience: v.show, seq: cur ? Number(cur.seq) : 0, page, pages, rows: out, counts, ...(Object.keys(nested).length ? { nested } : {}), indexable };
  }
}
