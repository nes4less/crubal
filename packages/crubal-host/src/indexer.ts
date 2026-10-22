// indexer.ts: the reference index (spec 12.6.1, docs/design/index-and-forms.md). It reads a view's
// projection stream from the store into its own tables, idempotently by (view, audience, seq), and serves
// pages, counts, partitions, role marks, search and indexability over the rows it holds. It is never the
// truth: a contract checks the store, and the index can be dropped and rebuilt from the stream.

import { facetOf, Access } from "@cruba/crubal";
import type { Json, JsonObject, Sums } from "@cruba/crubal";
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

export type Serve = {
  page?: number;
  picks?: { [filter: string]: string[] };
  q?: string;
  caller?: string;
  /** A further shape the view names (12.1): its output serves in place of the row. */
  shape?: string;
  /**
   * For a filter with no bucket list (12.3: a link into a vocabulary, buckets by the values records carry), the
   * bucket names a page wants counted; a tree has thousands, so an unlisted filter is counted only when asked.
   */
  only?: { [filter: string]: string[] };
};
export type Page = { view: string; version: string; audience: string; seq: number; page: number; pages: number; /** The rows the picks (and the search) select, across every page: the figure a report stamps. */ total: number; rows: JsonObject[]; counts: { [filter: string]: { [bucket: string]: number } }; sums?: Sums; nested?: Nested; indexable: boolean };

/** A row's slot as a number, in SQL: money by its amount, a quantity by its count, a number as it is, a numeric text read, else nothing. */
const numericSql = (slot: string) =>
  `coalesce((${slot} ->> '$money')::numeric, (${slot} ->> '$qty')::numeric, case when jsonb_typeof(${slot}) = 'number' then (${slot})::text::numeric when jsonb_typeof(${slot}) = 'string' and (${slot} #>> '{}') ~ '^-?[0-9]+(\\.[0-9]+)?$' then (${slot} #>> '{}')::numeric end, 0)`;
/** The same reading in memory, for the partitioned path. */
function numberIn(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { [k: string]: unknown };
    if (typeof o.$money === "string") return Number(o.$money) || 0;
    if (o.$qty !== undefined) return Number(o.$qty) || 0;
  }
  return 0;
}

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
    // A cursor past the stream's head means the stream was started over behind the index (a store
    // rebuilt before 0.1.16 wiped its streams): the index takes the stream from its start again.
    if (seq > 0 && seq > (await store.streamHead(view, v.show))) seq = 0;
    // The stream a page at a time: a first publish of a large view is more entries than memory should hold at once.
    const page = 5000;
    for (;;) {
      const entries = await store.entriesSince(view, seq, v.show, page);
      if (!entries.length) break;
      seq = await this.ingest(owner, view, version, v.show, entries, seq);
      if (entries.length < page) break;
    }
    return seq;
  }

  /** Apply stream entries to the rows, idempotently by seq (12.6.2): from a store's stream or pushed by a presenter. */
  async ingest(owner: string, view: string, version: string, audience: string, entries: StreamEntry[], from?: number): Promise<number> {
    const cur = (await this.pool.query("select seq from index_cursors where owner = $1 and view = $2 and version = $3 and audience = $4", [owner, view, version, audience])).rows[0] as Row | undefined;
    let seq = from ?? (cur ? Number(cur.seq) : 0);
    // Rows land in batches of 500, one statement each, in stream order: a reset or a removal flushes what
    // is pending first (ME: 9,437 rows in one view's first publish).
    // Within a batch a record appears once, as its latest entry (one statement may not touch a row twice).
    let pending: JsonObject[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const latest = new Map<string, JsonObject>();
      for (const e of pending) latest.set(String(e.record), e);
      pending = [...latest.values()];
      await this.pool.query(
        `insert into index_rows (owner, view, version, audience, record, row, buckets, marks, ancestors, sort, pin, seq, search)
         select $1, $2, $3, $4, e ->> 'record', e -> 'row', coalesce(e -> 'buckets', '{}'::jsonb), e -> 'row' -> 'marks',
           coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(e -> 'row' -> 'ancestors') = 'array' then e -> 'row' -> 'ancestors' else '[]'::jsonb end)), '{}'),
           coalesce(e -> 'sort', '[]'::jsonb), (e ->> 'pin')::integer, (e ->> 'seq')::bigint, to_tsvector('simple', e ->> 'search')
         from jsonb_array_elements($5::jsonb) as t(e)
         on conflict (owner, view, version, audience, record) do update set row = excluded.row, buckets = excluded.buckets, marks = excluded.marks,
           ancestors = excluded.ancestors, sort = excluded.sort, pin = excluded.pin, seq = excluded.seq, search = excluded.search`,
        [owner, view, version, audience, JSON.stringify(pending)],
      );
      pending = [];
    };
    for (const e of entries) {
      if (e.seq <= seq) continue;
      if (e.reset) {
        await flush();
        await this.pool.query("delete from index_rows where owner = $1 and view = $2 and audience = $3", [owner, view, audience]);
      }
      if (e.removed) {
        await flush();
        await this.pool.query("delete from index_rows where owner = $1 and view = $2 and version = $3 and audience = $4 and record = $5", [owner, view, version, audience, e.record]);
      } else if (e.row) {
        pending.push({ record: e.record, row: e.row, buckets: e.buckets ?? {}, sort: e.sort ?? [], ...(e.pin ? { pin: e.pin } : {}), seq: e.seq, search: textOf(e.row) });
        if (pending.length >= 500) await flush();
      }
      seq = e.seq;
    }
    await flush();
    await this.pool.query("insert into index_cursors (owner, view, version, audience, seq) values ($1, $2, $3, $4, $5) on conflict (owner, view, version, audience) do update set seq = excluded.seq", [owner, view, version, audience, seq]);
    return seq;
  }

  /** The bucket names of a filter, in its order: declared buckets, else the facet's values. */
  private bucketNames(p: Awaited<ReturnType<PgStore["definitions"]>>, filter: string): string[] {
    const f = p.views.filters.get(filter);
    if (!f) return [];
    if (f.buckets) return f.buckets.map((b) => b.name);
    // The facet an address finally reads: through a level prefix, a link step (works[*].genre) or a compound's child.
    return (facetOf(f.facet, p.dict)?.values ?? []).map((v) => v.value);
  }

  /** Does the filter bucket by the values records carry, with no list known in advance (12.3)? */
  private unlisted(p: Awaited<ReturnType<PgStore["definitions"]>>, filter: string): boolean {
    const f = p.views.filters.get(filter);
    return !!f && !f.buckets && !facetOf(f.facet, p.dict)?.values?.length;
  }

  /** The slot of the view's first shape that carries a facet (`price -> price`, `unit::price -> price`), for a sum over the rows. */
  private slotOf(p: Awaited<ReturnType<PgStore["definitions"]>>, v: View, facet: string): string | undefined {
    const shape = p.views.shapes.get(v.shapes[0] ?? "");
    const bare = facet.replace(/^\w+::/, "");
    return shape?.slots.find((sl) => sl.from.replace(/^!/, "").replace(/^\w+::/, "") === bare)?.to;
  }

  /** The names a filter's counts list: its buckets, or for an unlisted filter the ones the page asked for. */
  private namesFor(p: Awaited<ReturnType<PgStore["definitions"]>>, filter: string, o: Serve): string[] | undefined {
    if (!this.unlisted(p, filter)) return this.bucketNames(p, filter);
    const asked = o.only?.[filter];
    return asked?.length ? asked : undefined;
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
    // Access runs on a working set that loads the caller's records as it asks for them, never the catalog.
    const needsAccess = !!(p.perms.menu.size || p.perms.relations.size);
    const withAccess = <T>(fn: (access: Access) => T): Promise<T> => store.read((s) => { const a = new Access(p.dict, p.perms, s.records, [...s.edges.values()] as never[], owner); a.views = p.views; return fn(a); });
    const rank = (a: string) => ["public", "member", "staff", "owner"].indexOf(a);
    const audience = o.caller ? (needsAccess ? await withAccess((a) => a.audienceOf(o.caller as string)) : "member") : "public";
    if (o.caller === owner) {
      // the owner reads everything
    } else if (rank(audience) < rank(v.show)) throw Object.assign(new Error(`${view} is for ${v.show}`), { status: 403 });
    const cur = (await this.pool.query("select seq from index_cursors where owner = $1 and view = $2 and version = $3 and audience = $4", [owner, view, version, v.show])).rows[0] as Row | undefined;
    const seq = cur ? Number(cur.seq) : 0;
    const picks = o.picks ?? {};
    const pickList = Object.entries(picks).filter(([, c]) => c.length);
    const page = Math.max(1, o.page ?? 1);
    // The rows are selected, counted, ordered and paged by the database (brief 18 step 1): nothing here is
    // proportional to the view. Picks are containments on the buckets document (the GIN answers), the
    // search is the vector, the order is the stored sort and pin, the page a limit and an offset. The counts
    // and the total are cached per index cursor: they change only when the index does.
    const where = ["owner = $1", "view = $2", "version = $3", "audience = $4"];
    const params: unknown[] = [owner, view, version, v.show];
    if (o.q) {
      params.push(o.q);
      where.push(`search @@ plainto_tsquery('simple', $${params.length})`);
    }
    // Partition (12.6): a caller who isn't the owner is served the rows their edges stand in the relation to,
    // or an ancestor; the candidates are bounded by the caller's own edges, never the view.
    const partition = partitionOf(v);
    const roles = new Set<string>();
    let standsOn: string[] | undefined;
    if (partition !== "none" && o.caller !== owner) {
      if (!needsAccess || !o.caller) standsOn = [];
      else {
        const caller = o.caller;
        standsOn = await store.read((st) => [...new Set([...st.edges.values()].filter((e) => e.who === caller).map((e) => String(e.on)))]);
      }
    }
    if (standsOn) {
      if (!standsOn.length) return { view, version, audience: v.show, seq, page, pages: 1, total: 0, rows: [], counts: Object.fromEntries(v.filters.map((f) => [f, Object.fromEntries(this.bucketNames(p, f).map((b) => [b, 0]))])), indexable: false };
      params.push(standsOn);
      where.push(`(record = any($${params.length}) or ancestors && $${params.length}::text[])`);
    }
    // The stored order's first three keys always, so the order matches the index on them (index_rows_order).
    const order = `pin asc nulls last, ${[0, 1, 2].map((i) => `(sort ->> ${i}) ${v.order[i]?.dir === "after" ? "desc" : "asc"}`).concat("record asc").join(", ")}`;
    const baseWhere = where.join(" and ");
    // Each query gets its own parameters: the base, the picks it applies (all but `except`), then any extra.
    const build = (except?: string, extra: unknown[] = []): { sql: string; ps: unknown[] } => {
      const ps = [...params];
      const clauses = [baseWhere];
      for (const [f, chosen] of pickList) {
        if (f === except) continue;
        clauses.push(`(${chosen.map((c) => { ps.push(JSON.stringify({ [f]: [c] })); return `buckets @> $${ps.length}::jsonb`; }).join(" or ")})`);
      }
      for (const x of extra) ps.push(x);
      return { sql: clauses.join(" and "), ps };
    };
    // The caller's partition is checked row by row within the bounded candidates (14.10), so those are
    // fetched whole and paged here; everyone else's page is the database's.
    let onPage: Row[];
    let total: number;
    const counts: Page["counts"] = {};
    const sums: Sums = {};
    const nested: Nested = {};
    const key = `${owner}|${view}|${version}|${v.show}|${seq}|${JSON.stringify(pickList)}|${o.q ?? ""}|${standsOn ? standsOn.join(",") : ""}|${JSON.stringify(o.only ?? {})}`;
    if (standsOn && o.caller) {
      const caller = o.caller;
      const all = (await this.pool.query(`select record, row, buckets, marks, ancestors, sort, pin from index_rows where ${baseWhere} order by ${order}`, params)).rows as Row[];
      const served = await withAccess((a) => {
        const kept = all.filter((r) => a.standsIn(caller, String(r.record), partition));
        for (const r of kept) for (const e of a.effective(caller, String(r.record)).edges) for (const g of e.grants) if (p.perms.presets.has(g)) roles.add(g);
        return kept;
      });
      const inPick = (r: Row, f: string, chosen: string[]) => chosen.some((c) => (((r.buckets as JsonObject)?.[f] as string[] | undefined) ?? []).includes(c));
      const passes = (r: Row, except?: string) => pickList.every(([f, chosen]) => f === except || inPick(r, f, chosen));
      for (const f of v.filters) {
        const names = this.namesFor(p, f, o);
        if (!names) continue;
        const pool = served.filter((r) => passes(r, f));
        counts[f] = Object.fromEntries(names.map((b) => [b, pool.filter((r) => inPick(r, f, [b])).length]));
        const summed = p.views.filters.get(f)?.sums ?? [];
        if (summed.length)
          sums[f] = Object.fromEntries(
            names.map((b) => [b, Object.fromEntries(summed.map((facet) => [facet, pool.filter((r) => inPick(r, f, [b])).reduce((t, r) => t + numberIn((r.row as JsonObject)?.[this.slotOf(p, v, facet) ?? ""]), 0)]))]),
          );
      }
      const chosen = served.filter((r) => passes(r));
      total = chosen.length;
      onPage = chosen.slice((page - 1) * v.page, page * v.page);
    } else {
      const cached = this.cache.get(key) as { total: number; counts: Page["counts"]; sums: Sums; nested: Nested } | undefined;
      if (cached) {
        total = cached.total;
        Object.assign(counts, cached.counts);
        Object.assign(sums, cached.sums ?? {});
        Object.assign(nested, cached.nested);
      } else {
        const all = build();
        total = Number((await this.pool.query(`select count(*) as n from index_rows where ${all.sql}`, all.ps)).rows[0]?.n ?? 0);
        // The listed filters the picks don't name share one condition (every pick), so they are tallied in one
        // pass over the buckets document: one scan for all of them, not one each (a catalog of 300,000 rows
        // with twenty filters took a scan per filter, seconds a page). A picked filter is tallied over the rows
        // the other picks select, so it keeps a pass of its own; an unlisted one counts only the names asked.
        const picked = new Set(pickList.map(([f]) => f));
        const shared = v.filters.filter((f) => this.namesFor(p, f, o) && !this.unlisted(p, f) && !picked.has(f));
        if (shared.length) {
          const q = build(undefined, [shared]);
          const tally = (await this.pool.query(`select e.key as filter, b.value as bucket, count(*) as n from index_rows, jsonb_each(buckets) e, jsonb_array_elements_text(e.value) b where ${q.sql} and e.key = any($${q.ps.length}) group by e.key, b.value`, q.ps)).rows as { filter: string; bucket: string; n: string }[];
          const by = new Map<string, Map<string, number>>();
          for (const t of tally) (by.get(t.filter) ?? by.set(t.filter, new Map()).get(t.filter))?.set(t.bucket, Number(t.n));
          for (const f of shared) counts[f] = Object.fromEntries(this.bucketNames(p, f).map((b) => [b, by.get(f)?.get(b) ?? 0]));
        }
        for (const f of v.filters) {
          const names = this.namesFor(p, f, o);
          if (!names) continue;
          const but = build(f);
          // An unlisted filter counts only the names asked for, inside the query, not after it.
          const asked = this.unlisted(p, f) ? ` and b.value = any($${but.ps.push(names)})` : "";
          if (!counts[f]) {
            const tally = (await this.pool.query(`select b.value as bucket, count(*) as n from index_rows, jsonb_array_elements_text(buckets -> '${f.replace(/'/g, "''")}') b where ${but.sql}${asked} group by b.value`, but.ps)).rows as { bucket: string; n: string }[];
            const by = new Map(tally.map((t) => [t.bucket, Number(t.n)]));
            counts[f] = Object.fromEntries(names.map((b) => [b, by.get(b) ?? 0]));
          }
          // The sums a filter names (12.3): the facet's slot on the row totalled per bucket, money by its amount.
          const summed = (p.views.filters.get(f)?.sums ?? []).map((facet) => ({ facet, slot: this.slotOf(p, v, facet) })).filter((x): x is { facet: string; slot: string } => !!x.slot);
          if (summed.length) {
            const cols = summed.map((x, i) => `sum(${numericSql(`row -> '${x.slot.replace(/'/g, "''")}'`)}) as s${i}`).join(", ");
            const totals = (await this.pool.query(`select b.value as bucket, ${cols} from index_rows, jsonb_array_elements_text(buckets -> '${f.replace(/'/g, "''")}') b where ${but.sql}${asked} group by b.value`, but.ps)).rows as { [k: string]: string }[];
            const per = new Map(totals.map((t) => [t.bucket, t]));
            sums[f] = Object.fromEntries(names.map((b) => [b, Object.fromEntries(summed.map((x, i) => [x.facet, Number(per.get(b)?.[`s${i}`] ?? 0)]))]));
          }
          // Dependent facets (12.3): their values counted inside each of this filter's buckets.
          const deps = p.views.filters.get(f)?.dependent ?? [];
          if (!deps.length) continue;
          const inner: Nested[string] = {};
          for (const d of deps) {
            const rows = (await this.pool.query(`select b.value as bucket, d.value as val, count(*) as n from index_rows, jsonb_array_elements_text(buckets -> '${f.replace(/'/g, "''")}') b, jsonb_array_elements_text(buckets -> '${d.replace(/'/g, "''")}') d where ${but.sql} group by b.value, d.value`, but.ps)).rows as { bucket: string; val: string; n: string }[];
            for (const r of rows) {
              const slot = (inner[r.bucket] ??= {});
              (slot[d] ??= {})[r.val] = Number(r.n);
            }
          }
          nested[f] = inner;
        }
        this.remember(key, { total, counts: structuredClone(counts), sums: structuredClone(sums), nested: structuredClone(nested) });
      }
      const paged = build(undefined, [v.page, (page - 1) * v.page]);
      onPage = (await this.pool.query(`select record, row, buckets, marks, ancestors, sort, pin from index_rows where ${paged.sql} order by ${order} limit $${paged.ps.length - 1} offset $${paged.ps.length}`, paged.ps)).rows as Row[];
    }
    const pages = Math.max(1, Math.ceil(total / v.page));
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
    return { view, version, audience: v.show, seq, page, pages, total, rows: out, counts, ...(Object.keys(sums).length ? { sums } : {}), ...(Object.keys(nested).length ? { nested } : {}), indexable };
  }

  /** Counts and totals per index cursor, picks and search: a few hundred recent answers, the oldest going first. */
  private readonly cache = new Map<string, unknown>();
  private remember(key: string, value: unknown): void {
    this.cache.set(key, value);
    while (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value as string);
  }
}
