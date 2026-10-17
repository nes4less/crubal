// bench.ts: the benchmark docs/design/completion.md R names. A store of 200 products with 500 units each
// (100,200 records), then the cost of: a commit attaching one unit, a receive on one product, a publish
// of one view after one write, an index page with two picks, and a search. Targets: a commit under 50 ms,
// a page under 100 ms. Run with CRUBAL_PG_URL set:  node bench/bench.ts [--products 200 --units 500]
import { publish } from "@cruba/crubal";
import type { JsonObject } from "@cruba/crubal";
import { PgBorder } from "@cruba/crubal-postgres";
import { connect, testSchema } from "@cruba/crubal-postgres";
import { PgStore } from "@cruba/crubal-postgres";
import { Host } from "../src/host.ts";
import { Index } from "../src/indexer.ts";

const arg = (name: string, d: number) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const PRODUCTS = arg("--products", 200);
const UNITS = arg("--units", 500);
const owner = "bench.example";
const PACKAGE = `package: shop /2026-10-01
  owner: bench.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
  vary:
    unit: condition, price
title$
format{DVD|Blu-ray|4K}
genres{Comedy|Drama|Action|Horror}*
condition{NM|VG|G|F} ranked
price#USD
runtime#min
class: Item
  for: item
  facets:
    !title
    format
    genres
    unit::condition
    unit::price

contract: catalog
  kind: receive
  origin: reported
  reads:
    Title -> title
    Runtime -> runtime

shape: card
  slots:
    !title -> heading
    "{format}" -> line
    least of unit::price -> price
    count of unit::condition -> available
filter: format
  facet: format
filter: condition
  facet: unit::condition
  buckets:
    "Like new": NM, VG
    Good: G
    Fair: F
filter: genres
  facet: genres
view: discs
  select:
    level: product
  order: title
  page: 24
  shape: card
  filters: format, condition, genres
  index: format, genres
`;

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  const out = await fn();
  console.log(`${label.padEnd(44)} ${(performance.now() - t).toFixed(1)} ms`);
  return out;
};

const pool = connect();
const drop = await testSchema(pool);
try {
  // The index's own tables come with the host's schema.
  await new Host(pool, { domain: "bench" }).migrate();
  const store = new PgStore(pool, owner, { allowUnsigned: true, fresh: "asked" });
  await store.install(publish(PACKAGE, { date: "2026-10-01" }).bundle, undefined, "2026-10-16T00:00:00Z");
  const formats = ["DVD", "Blu-ray", "4K"];
  const genres = ["Comedy", "Drama", "Action", "Horror"];
  const conditions = ["NM", "VG", "G", "F"];
  const t0 = performance.now();
  for (let p = 0; p < PRODUCTS; p++) {
    const pid = `P-${p + 1}`;
    await store.commit({ migration: "bench" }, (d) => {
      d.records.set(pid, { id: pid, kind: "item", level: "product", owner, values: { title: `Title ${String(p + 1).padStart(4, "0")} ${["Vacation", "Alone", "Hard", "Elf"][p % 4]}`, format: formats[p % 3] as string, genres: [genres[p % 4] as string, genres[(p + 1) % 4] as string] }, sources: { "*": { origin: "declared", via: "L-1" } } });
      for (let u = 0; u < UNITS; u++) {
        const uid = `U-${p + 1}-${u + 1}`;
        d.records.set(uid, { id: uid, kind: "item", level: "unit", of: pid, owner, values: { condition: conditions[u % 4] as string, price: { $money: (5 + (u % 40)).toFixed(2), currency: "USD" } }, sources: { "*": { origin: "observed", via: "L-1" } } });
      }
    }, `2026-10-16T00:${String(Math.floor(p / 60)).padStart(2, "0")}:${String(p % 60).padStart(2, "0")}Z`);
  }
  console.log(`loaded ${PRODUCTS} products × ${UNITS} units in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  await ms("first publish of the view (every row)", () => store.project("discs"));
  const index = new Index(pool);
  await ms("index applies the stream", () => index.apply(store, "discs"));

  await ms("commit: attach one unit", () => store.commit({ person: owner }, (d) => {
    d.records.set("U-NEW", { id: "U-NEW", kind: "item", level: "unit", of: "P-7", owner, values: { condition: "NM", price: { $money: "9.99", currency: "USD" } }, sources: { "*": { origin: "observed", via: "L-2" } } });
  }, "2026-10-16T01:00:00Z"));
  const border = await PgBorder.over(store);
  await ms("receive on one product (catalog)", () => border.receive("catalog", "P-7", '{"Title":"Title 0007 Hard","Runtime":"97min"}', undefined, "2026-10-16T01:00:01Z"));
  await ms("publish the view after one write (stale rows)", () => store.project("discs"));
  await ms("index applies the stream (delta)", () => index.apply(store, "discs"));
  const page = await ms("index page with two picks", () => index.serve(store, "discs", { picks: { format: ["DVD"], condition: ["Like new"] } }));
  console.log(`  rows ${page.rows.length}, pages ${page.pages}, counts ${JSON.stringify(page.counts.format)}`);
  const found = await ms("index search", () => index.serve(store, "discs", { q: "Hard" }));
  console.log(`  rows ${found.rows.length}`);
  await ms("record read by id (one product)", () => store.get("P-7"));
  await ms("record read through the whole state", async () => (await store.state()).records.get("P-7"));
} finally {
  await drop();
  await pool.end();
}
