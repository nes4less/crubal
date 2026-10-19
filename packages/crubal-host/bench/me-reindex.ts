// me-reindex.ts: bring the local host index back to what the store holds: every view republished whole
// with a reset, then applied to the index. CRUBAL_PG_SCHEMA=crubal_me node bench/me-reindex.ts [owner]
import { connect, PgStore } from "@cruba/crubal-postgres";
import { Index } from "../src/indexer.ts";
const pool = connect(process.env.CRUBAL_PG_URL ?? "postgres:///postgres", process.env.CRUBAL_PG_SCHEMA ?? "crubal_me");
const owner = process.argv[2] ?? "mediaencyclopedia.com";
const s = new PgStore(pool, owner, { allowUnsigned: true });
await s.republish();
const t = Date.now();
const entries = await s.project();
console.log(`republished: ${entries.length} entries in ${Date.now() - t} ms`);
const index = new Index(pool);
for (const v of (await s.definitions()).views.views.values()) {
  const t1 = Date.now();
  const seq = await index.apply(s, v.name);
  const n = (await pool.query("select count(*) from index_rows where owner = $1 and view = $2 and version = $3 and audience = $4", [owner, v.name, v.version ?? "", v.show])).rows[0].count;
  console.log(`${v.name}: cursor ${seq}, ${n} rows, ${Date.now() - t1} ms`);
}
await pool.end();
