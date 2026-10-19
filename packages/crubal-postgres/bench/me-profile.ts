// me-profile.mts: the phases of one view's full publish on ME's catalog: load, project (per page), write.
import { Access, Views, serialize } from "@cruba/crubal";
import { connect, PgStore, Needs, settle, workingState } from "../src/index.ts";
import { loadWhole } from "../src/working.ts";
const pool = connect(process.env.CRUBAL_PG_URL ?? "postgres:///postgres", process.env.CRUBAL_PG_SCHEMA ?? "crubal_me");
const owner = "mediaencyclopedia.com";
const name = process.argv[2] ?? "channelStatus";
const s = new PgStore(pool, owner, { allowUnsigned: true });
const p = (await s.projecting())!;
const v = p.views.views.get(name)!;
const client = await pool.connect();
const ms = (t: bigint) => Number((process.hrtime.bigint() - t) / 1000n) / 1000;
let t = process.hrtime.bigint();
const needs = new Needs();
const base = workingState(needs);
await loadWhole(client, owner, base);
console.log("loadWhole", ms(t), "ms; loaded", needs.loaded.size);
t = process.hrtime.bigint();
let pages = 0; let reruns = 0; let projectMs = 0;
const { out: now } = await settle(client, owner, base, (st) => {
  reruns++;
  const views = new Views(p.dict, p.views, st.records);
  const access = p.perms ? new Access(p.dict, p.perms, st.records, [...st.edges.values()] as never[], owner) : undefined;
  if (access && p.views) access.views = p.views;
  const rows = new Map<string, unknown>();
  for (let page = 1; ; page++) {
    const t0 = process.hrtime.bigint();
    const pr = views.project(name, { audience: v.show, page, ...(access ? { access } : {}) });
    projectMs += ms(t0);
    for (const row of pr.rows) {
      const rec = st.records.get(String(row.record));
      rows.set(String(row.record), { row, buckets: rec ? views.bucketsFor(v, rec) : {}, ...(rec ? views.sortOf(v, rec) : { sort: [] }) });
    }
    pages = pr.pages;
    if (page >= pr.pages) break;
  }
  return rows;
});
console.log("settle+project", ms(t), "ms; rows", now.size, "pages", pages, "page size", v.page, "reruns", reruns, "project() alone (last run)", projectMs, "ms; loaded now", needs.loaded.size);
t = process.hrtime.bigint();
let n = 0;
for (const [, r] of now) { serialize(r as never); n++; }
console.log("serialize", ms(t), "ms for", n);
const kinds: Record<string, number> = {};
for (const k of needs.answered) { const kind = k.split(":")[0]; kinds[kind] = (kinds[kind] ?? 0) + 1; }
console.log("needs answered by kind", JSON.stringify(kinds), "absent", needs.absent.size);
client.release();
await pool.end();
