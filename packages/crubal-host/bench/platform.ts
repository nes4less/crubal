// platform.ts: the platform benchmark (Cashierfu brief 0, audit G8). Ten owners on one host, a million
// records between them, one hosted person with edges in every owner; then the cost of: `whoami` (edges
// across owners), the cross-owner relation read over the index rows, and a per-owner index page. Rows are
// seeded straight into the store's and index's tables (this measures reads, not the write path; bench.ts
// measures that). Run with CRUBAL_PG_URL set:
//   node bench/platform.ts [--owners 10 --records 1000000 --edges 5]
import type { JsonObject } from "@cruba/crubal";
import { publish } from "@cruba/crubal";
import { connect, testSchema } from "@cruba/crubal-postgres";
import { PgStore } from "@cruba/crubal-postgres";
import { Host } from "../src/host.ts";
import { Index } from "../src/indexer.ts";

const arg = (name: string, d: number) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const OWNERS = arg("--owners", 10);
const RECORDS = arg("--records", 1_000_000);
const EDGES = arg("--edges", 5);
const perOwner = Math.floor(RECORDS / OWNERS);

const PACKAGE = (owner: string) => `package: shop /2026-10-01
  owner: ${owner}
  crubal: 2

kind: item
  levels: product, unit
  base: Item
kind: person
  levels: person
  base: Person
title$
format{DVD|Blu-ray|4K}
class: Item
  for: item
  facets:
    !title
    format
class: Person
  for: person

shape: card
  slots:
    !title -> heading
filter: format
  facet: format
view: discs
  select:
    level: product
  order: title
  page: 48
  shape: card
  filters: format
  index: format

permissions: shop
  menu:
    read: see title
  presets:
    helper: read    audience: staff
  relations: helper, follower only
`;

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<{ out: T; ms: number }> => {
  const t = performance.now();
  const out = await fn();
  const took = performance.now() - t;
  console.log(`${label.padEnd(56)} ${took.toFixed(1)} ms`);
  return { out, ms: took };
};

const pool = connect();
const drop = await testSchema(pool);
const results: JsonObject = { owners: OWNERS, records: RECORDS, edgesPerOwner: EDGES };
try {
  const host = new Host(pool, { domain: "bench", allowUnsigned: true });
  await host.migrate();
  const person: { owner: string; caller: string; via: "identity" } = { owner: "o1.example", caller: "P-1", via: "identity" };
  const t0 = performance.now();
  for (let o = 1; o <= OWNERS; o++) {
    const owner = `o${o}.example`;
    await host.createOwner(owner);
    const store = new PgStore(pool, owner, { allowUnsigned: true, fresh: "asked" });
    await store.install(publish(PACKAGE(owner), { date: "2026-10-01" }).bundle, undefined, "2026-10-16T00:00:00Z");
    // Records and index rows, seeded in bulk: half products (each an index row of the view), half units.
    const products = Math.floor(perOwner / 2);
    const formats = ["DVD", "Blu-ray", "4K"];
    const batch = 5000;
    for (let start = 0; start < products; start += batch) {
      const n = Math.min(batch, products - start);
      const ids: string[] = [];
      const docs: string[] = [];
      const rows: string[] = [];
      const buckets: string[] = [];
      const sorts: string[] = [];
      const seqs: number[] = [];
      for (let i = 0; i < n; i++) {
        const k = start + i + 1;
        const id = `P-${k}`;
        const title = `Title ${String(k).padStart(7, "0")}`;
        ids.push(id);
        docs.push(JSON.stringify({ id, kind: "item", level: "product", owner, values: { title, format: formats[k % 3] } }));
        rows.push(JSON.stringify({ record: id, heading: title }));
        buckets.push(JSON.stringify({ format: [formats[k % 3]] }));
        sorts.push(JSON.stringify([title]));
        seqs.push(k);
      }
      await pool.query(
        `insert into records (owner, id, kind, level, doc) select $1, u.id, 'item', 'product', u.doc::jsonb from unnest($2::text[], $3::text[]) as u(id, doc) on conflict do nothing`,
        [owner, ids, docs],
      );
      await pool.query(
        `insert into records (owner, id, kind, level, "of", doc) select $1, 'U-' || u.id, 'item', 'unit', u.id, jsonb_build_object('id', 'U-' || u.id, 'kind', 'item', 'level', 'unit', 'of', u.id, 'owner', $1::text, 'values', '{}'::jsonb) from unnest($2::text[]) as u(id) on conflict do nothing`,
        [owner, ids],
      );
      await pool.query(
        `insert into index_rows (owner, view, version, audience, record, row, buckets, ancestors, sort, seq, search)
         select $1, 'discs', '2026-10-01', 'public', u.id, u.row::jsonb, u.buckets::jsonb, '{}', u.sort::jsonb, u.seq, to_tsvector('simple', u.row)
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[]) as u(id, row, buckets, sort, seq) on conflict do nothing`,
        [owner, ids, rows, buckets, sorts, seqs],
      );
    }
    await pool.query("insert into index_cursors (owner, view, version, audience, seq) values ($1, 'discs', '2026-10-01', 'public', $2) on conflict do nothing", [owner, products]);
    // The person's edges in this owner: helper on a few products, by the owner.
    const who = owner === person.owner ? person.caller : `person:${person.owner}:${person.caller}`;
    for (let e = 1; e <= EDGES; e++) {
      const edge = { edge: `E-${e}`, who, relation: e % 2 ? "helper" : "follower", mode: e % 2 ? "control" : "none", on: `P-${e * 7}`, grants: e % 2 ? ["helper"] : [], by: "owner" };
      await pool.query("insert into edges (owner, edge, json) values ($1, $2, $3) on conflict do nothing", [owner, edge.edge, JSON.stringify(edge)]);
    }
  }
  await pool.query("analyze records; analyze index_rows; analyze edges");
  const loaded = (performance.now() - t0) / 1000;
  console.log(`seeded ${OWNERS} owners × ${perOwner} records (${(await pool.query("select count(*) as n from records")).rows[0].n} rows) in ${loaded.toFixed(1)} s`);
  results.seededIn_s = Number(loaded.toFixed(1));

  const w = await ms("whoami: the person's edges across every owner", () => host.whoami(person));
  console.log(`  owners ${Object.keys(w.out.owners as JsonObject).length}`);
  results.whoami_ms = Number(w.ms.toFixed(1));
  const w2 = await ms("whoami again (warm)", () => host.whoami(person));
  results.whoamiWarm_ms = Number(w2.ms.toFixed(1));
  const r = await ms("cross-owner relation read (rows the person helps on)", () => host.rowsFor(person, "helper", { limit: 100 }));
  console.log(`  rows ${r.out.length}`);
  results.rowsFor_ms = Number(r.ms.toFixed(1));
  const r2 = await ms("cross-owner relation read (follower)", () => host.rowsFor(person, "follower", { limit: 100 }));
  results.rowsForFollower_ms = Number(r2.ms.toFixed(1));
  const index = new Index(pool);
  const store = new PgStore(pool, "o3.example", { allowUnsigned: true, fresh: "asked" });
  const p = await ms("per-owner index page (first page, no picks)", () => index.serve(store, "discs"));
  console.log(`  rows ${p.out.rows.length}, pages ${p.out.pages}`);
  results.page_ms = Number(p.ms.toFixed(1));
  const p2 = await ms("per-owner index page with one pick", () => index.serve(store, "discs", { picks: { format: ["DVD"] } }));
  results.pagePick_ms = Number(p2.ms.toFixed(1));
  const s = await ms("per-owner search", () => index.serve(store, "discs", { q: "0004242" }));
  console.log(`  rows ${s.out.rows.length}`);
  results.search_ms = Number(s.ms.toFixed(1));
  const g = await ms("record read by id", () => store.get("P-4242"));
  results.get_ms = Number(g.ms.toFixed(1));
  console.log(JSON.stringify(results));
} finally {
  await drop();
  await pool.end();
}
