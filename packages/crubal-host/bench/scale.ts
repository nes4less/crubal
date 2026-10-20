// scale.ts: brief 18 step 1's probe. A host of many owners and one large owner, loaded through the store's
// bulk path, then the costs that must not grow with the catalog or the number of owners: a commit, a page,
// a search, an incremental publish, the first publish of the largest view, a loop pass across every owner,
// and the process's memory across requests to many owners. Run with CRUBAL_PG_URL set:
//   node bench/scale.ts [--owners 1000 --each 1000 --big 1000000 --schema scale_probe --keep]
// The schema is dropped at the end unless --keep; a kept schema is reused by the next run (loads skipped).
import { publish } from "@cruba/crubal";
import type { JsonObject, Record } from "@cruba/crubal";
import { connect, PgStore, testSchema } from "@cruba/crubal-postgres";
import { Host } from "../src/host.ts";
import { Index } from "../src/indexer.ts";

const arg = (name: string, d: number) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const flag = (name: string) => process.argv.includes(name);
const OWNERS = arg("--owners", 1000);
const EACH = arg("--each", 1000);
const BIG = arg("--big", 1_000_000);
const SCHEMA = (() => { const i = process.argv.indexOf("--schema"); return i >= 0 ? process.argv[i + 1] : "scale_probe"; })();
const PACKAGE = `package: shop /2026-10-01
  owner: scale.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
  vary:
    unit: condition, price
title$
format{DVD|Blu-ray|4K}
condition{NM|VG|G|F} ranked
price#USD
class: Item
  for: item
  facets:
    !title
    format
    unit::condition
    unit::price

shape: card
  slots:
    !title -> heading
    "{format}" -> line
    least of unit::price -> price
filter: format
  facet: format
view: catalog
  select:
    level: product
  order: title
  shape: card
  filters: format
  fresh: write
  page: 48
view: units
  select:
    level: unit
  shape: card
  fresh: write
  page: 48
`;

const ms = (t: bigint) => Number((process.hrtime.bigint() - t) / 1000n) / 1000;
const mem = () => Math.round(process.memoryUsage().rss / 1048576);
const bundle = publish(PACKAGE, { date: "2026-10-01" }).bundle;

const base = connect(process.env.CRUBAL_PG_URL);
await base.query(`create schema if not exists ${SCHEMA}`);
await base.end();
const pool = connect(process.env.CRUBAL_PG_URL, SCHEMA);
const host = new Host(pool, { domain: "scale.localhost", hostKey: "hk", allowUnsigned: true, fresh: "write" });
await host.migrate();
const index = new Index(pool);

function catalog(owner: string, n: number, from = 1): Record[] {
  const out: Record[] = [];
  const products = Math.max(1, Math.floor(n / 2));
  for (let i = from; i < from + products; i++) {
    out.push({ id: `P-${i}`, kind: "item", level: "product", owner, values: { title: `Title ${i} ${["Alpha", "Beta", "Gamma", "Delta"][i % 4]}`, format: ["DVD", "Blu-ray", "4K"][i % 3] } } as Record);
    out.push({ id: `U-${i}`, kind: "item", level: "unit", of: `P-${i}`, owner, values: { condition: ["NM", "VG", "G", "F"][i % 4], price: { $money: `${5 + (i % 40)}.00`, currency: "USD" } } } as unknown as Record);
  }
  return out;
}

async function ownerStore(owner: string): Promise<PgStore> {
  const have = (await pool.query("select 1 from host_owners where owner = $1", [owner])).rows.length > 0;
  if (!have) await host.createOwner(owner);
  const store = await host.storeFor(owner);
  if (!(await store.installed()).length) await store.install(bundle);
  return store;
}

// ── Load ──
console.log(`probe: ${OWNERS} owners × ${EACH} records, one at ${BIG}; schema ${SCHEMA}; rss ${mem()} MB`);
let t = process.hrtime.bigint();
let loaded = 0;
for (let o = 1; o <= OWNERS; o++) {
  const owner = `shop${o}.example`;
  const store = await ownerStore(owner);
  if ((await store.records({ level: "product" }, { limit: 1 })).length) continue;
  await store.load(catalog(owner, EACH), { migration: "probe" }, { publish: false });
  loaded += EACH;
  if (o % 100 === 0) console.log(`  ${o} owners loaded, ${loaded} records, ${Math.round(ms(t) / 1000)} s, rss ${mem()} MB`);
}
const big = await ownerStore("big.example");
const bigHave = Number((await pool.query("select count(*) from records where owner = $1", ["big.example"])).rows[0].count);
if (bigHave < BIG) {
  const step = 20_000;
  for (let from = Math.floor(bigHave / 2) + 1; from * 2 <= BIG; from += step / 2) {
    await big.load(catalog("big.example", step, from), { migration: "probe" }, { publish: false });
    if ((from - 1) % 100_000 === 0) console.log(`  big: ${(from - 1) * 2 + step} records, ${Math.round(ms(t) / 1000)} s, rss ${mem()} MB`);
  }
}
console.log(`loaded in ${Math.round(ms(t))} ms; rss ${mem()} MB`);

// ── The costs ──
const results: JsonObject = {};
host.forgetStore("big.example");
const s = await host.storeFor("big.example");
// The first publish of the largest view, then the index taking it.
t = process.hrtime.bigint();
const first = await s.project("catalog");
results.firstPublishMs = ms(t);
results.firstPublishRows = first.length;
t = process.hrtime.bigint();
await index.apply(s, "catalog");
results.firstIndexMs = ms(t);
await s.project("units");
await index.apply(s, "units");
// A commit; with `fresh: write` the rows it made stale publish inline, so this is commit plus incremental publish.
t = process.hrtime.bigint();
await s.commit({ migration: "probe" }, (d) => { const r = d.records.get("U-7"); if (r) d.records.set("U-7", { ...r, values: { ...r.values, condition: "G" } }); });
results.commitWithInlinePublishMs = ms(t);
t = process.hrtime.bigint();
await s.commit({ migration: "probe" }, (d) => { const r = d.records.get("P-9"); if (r) d.records.set("P-9", { ...r, values: { ...r.values, title: "Title 9 changed" } }); });
results.secondCommitMs = ms(t);
t = process.hrtime.bigint();
const inc = await s.project("catalog");
results.idlePublishMs = ms(t);
results.idlePublishRows = inc.length;
await index.apply(s, "catalog");
t = process.hrtime.bigint();
const page = await index.serve(s, "catalog", { page: 1 });
results.pageMs = ms(t);
results.pageRows = page.rows.length;
t = process.hrtime.bigint();
const search = await index.serve(s, "catalog", { q: "Gamma" });
results.searchMs = ms(t);
results.searchRows = search.rows.length;
t = process.hrtime.bigint();
await s.records({ level: "unit", key: ["condition", "NM"] }, { limit: 48 });
results.keyLookupMs = ms(t);
t = process.hrtime.bigint();
await host.tick();
results.tickAllOwnersMs = ms(t);
t = process.hrtime.bigint();
const before = mem();
for (let o = 1; o <= Math.min(OWNERS, 1000); o++) {
  const st = await host.storeFor(`shop${o}.example`);
  await st.records({ level: "product" }, { limit: 5 });
}
results.thousandOwnerReadsMs = ms(t);
results.rssBeforeMB = before;
results.rssAfterMB = mem();
results.storesKept = (host as unknown as { stores: Map<string, unknown> }).stores.size;
// The planner on the queries the working set and the projector make: every one an index scan.
const plans: JsonObject = {};
const explain = async (label: string, sql: string, params: unknown[]) => {
  const { rows } = await pool.query(`explain (format json) ${sql}`, params);
  const plan = (rows[0] as { "QUERY PLAN": { Plan: { "Node Type": string; Plans?: { "Node Type": string }[] } }[] })["QUERY PLAN"][0]?.Plan;
  const walk = (p: { "Node Type": string; Plans?: unknown[] } | undefined): string[] => (p ? [p["Node Type"], ...((p.Plans as { "Node Type": string; Plans?: unknown[] }[] | undefined) ?? []).flatMap(walk)] : []);
  plans[label] = walk(plan).join(" > ");
};
await explain("recordsByLevel", "select * from records where owner = $1 and level = $2 order by ord limit 48", ["big.example", "unit"]);
await explain("recordById", "select * from records where owner = $1 and id = $2", ["big.example", "U-7"]);
await explain("childrenOf", 'select * from records where owner = $1 and "of" = $2 and level = $3 order by ord', ["big.example", "P-7", "unit"]);
await explain("byKey", "select * from records where owner = $1 and level = $2 and doc -> 'values' -> 'condition' = $3::jsonb order by ord", ["big.example", "unit", '"NM"']);
await explain("byKind", "select * from records where owner = $1 and kind = $2 order by ord limit 48", ["big.example", "item"]);
await explain("stale", "select record from stale where owner = $1 and view = $2", ["big.example", "catalog"]);
await explain("logSince", "select seq, entry from log where owner = $1 and chain = $2 and seq > $3 order by seq", ["big.example", "main", 0]);
await explain("indexSearch", "select record from index_rows where owner = $1 and view = $2 and version = $3 and audience = $4 and search @@ plainto_tsquery('simple', $5)", ["big.example", "catalog", "2026-10-01", "public", "Gamma"]);
await explain("drainWaiting", "select r.id from records r where r.owner = $1 and coalesce(r.status ->> 'state', '') <> 'archived' and r.\"of\" = $2 order by r.ord limit 10", ["big.example", "P-1"]);
results.plans = plans;
console.log(JSON.stringify(results, null, 1));
if (!flag("--keep")) { const d = testSchema; void d; await pool.query(`drop schema ${SCHEMA} cascade`); }
await pool.end();
