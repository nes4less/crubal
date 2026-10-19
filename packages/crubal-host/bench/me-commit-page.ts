// me-commit-page.ts: brief 17 item 8's standing targets on ME's catalog: a commit under 50 ms (one unit's
// value set and set back, two real entries with every view's stale marks), a page under 100 ms (the shop
// view's first page, a page with one pick, a search), from the local host index.
import { connect, PgStore } from "@cruba/crubal-postgres";
import { Index } from "../src/indexer.ts";
const pool = connect(process.env.CRUBAL_PG_URL ?? "postgres:///postgres", process.env.CRUBAL_PG_SCHEMA ?? "crubal_me");
const owner = "mediaencyclopedia.com";
const s = new PgStore(pool, owner, { allowUnsigned: true });
const ms = (t: bigint) => Number((process.hrtime.bigint() - t) / 1000n) / 1000;
const unit = process.argv[2] ?? "U-1";
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const was = (await s.get(unit))?.values.description;
let t = process.hrtime.bigint();
const e1 = await s.commit({ person: `${owner}:owner`, contract: "bench" }, (d) => { const r = d.records.get(unit); if (r) d.records.set(unit, { ...r, values: { ...r.values, description: `${String(r.values.description ?? "")} ` } }); }, now());
const c1 = ms(t);
t = process.hrtime.bigint();
const e2 = await s.commit({ person: `${owner}:owner`, contract: "bench" }, (d) => { const r = d.records.get(unit); if (r) d.records.set(unit, { ...r, values: { ...r.values, description: was ?? "" } }); }, now());
const c2 = ms(t);
const marked = Number((await pool.query("select count(*) from stale where owner = $1", [owner])).rows[0].count);
t = process.hrtime.bigint();
const published = await s.project();
const pub = ms(t);
console.log(`commit ${c1} ms (${e1?.log}), commit back ${c2} ms (${e2?.log}); ${marked} rows marked stale; publishing them ${pub} ms, ${published.length} entries`);
const index = new Index(pool);
const p = (await s.definitions()).views.views.get("shop")!;
t = process.hrtime.bigint();
const page1 = await index.serve(s, "shop", { page: 1 });
const p1 = ms(t);
const filter = p.filters[0];
const bucket = filter ? Object.keys(page1.counts[filter] ?? {})[0] : undefined;
t = process.hrtime.bigint();
const page2 = filter && bucket ? await index.serve(s, "shop", { page: 1, picks: { [filter]: [bucket] } }) : page1;
const p2 = ms(t);
t = process.hrtime.bigint();
const page3 = await index.serve(s, "shop", { page: 1, q: "gibson" });
const p3 = ms(t);
console.log(`page 1 ${p1} ms (${page1.rows.length} rows of ${page1.pages} pages); with ${filter}=${bucket} ${p2} ms (${page2.rows.length} rows); search ${p3} ms (${page3.rows.length} rows)`);
await pool.end();
