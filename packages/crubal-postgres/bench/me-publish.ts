// me-publish.mts: brief 17 item 8. The cost of publishing each of ME's views on ME's own catalog, in the
// local store (schema crubal_me): idle (nothing stale), every row marked stale, and a full first publish.
// The last two run inside a transaction that is rolled back, so the store is left as it was.
//   CRUBAL_PG_URL=postgres:///postgres CRUBAL_PG_SCHEMA=crubal_me npx tsx scripts/bench/me-publish.mts [view]
import { connect, PgStore, publish } from "../src/index.ts";
const url = process.env.CRUBAL_PG_URL ?? "postgres:///postgres";
const pool = connect(url, process.env.CRUBAL_PG_SCHEMA ?? "crubal_me");
const owner = process.env.OWNER ?? "mediaencyclopedia.com";
const s = new PgStore(pool, owner, { allowUnsigned: true });
const p = await s.projecting();
if (!p) throw new Error("no views");
const pick = process.argv[2];
const ms = (t: bigint) => Number((process.hrtime.bigint() - t) / 1000n) / 1000;
const client = await pool.connect();
const rows: string[][] = [];
for (const [name, v] of p.views.views) {
  if (pick && name !== pick) continue;
  const aud = v.show;
  const n = Number((await client.query("select count(*) from projections where owner=$1 and view=$2 and audience=$3", [owner, name, aud])).rows[0].count);
  let t = process.hrtime.bigint();
  await s.project(name);
  const idle = ms(t);
  await client.query("begin");
  await client.query("insert into stale (owner, view, record, since) select $1, $2, id, 0 from records where owner = $1 and level = $3 on conflict do nothing", [owner, name, v.level]);
  t = process.hrtime.bigint();
  const e1 = await publish(client, owner, p, name);
  const stale = ms(t);
  await client.query("rollback");
  await client.query("begin");
  await client.query("delete from projections where owner=$1 and view=$2", [owner, name]);
  await client.query("delete from projection_stream where owner=$1 and view=$2", [owner, name]);
  await client.query("delete from published where owner=$1 and view=$2", [owner, name]);
  t = process.hrtime.bigint();
  const e2 = await publish(client, owner, p, name);
  const full = ms(t);
  await client.query("rollback");
  rows.push([name, String(v.level), String(aud), String(n), `${idle}`, `${stale} (${e1.length})`, `${full} (${e2.length})`]);
  console.error(`${name}: idle ${idle} ms, all stale ${stale} ms, full ${full} ms (${e2.length} rows)`);
}
console.log(["view", "level", "audience", "rows", "idle ms", "all stale ms", "full ms"].join(" | "));
for (const r of rows) console.log(r.join(" | "));
client.release();
await pool.end();
