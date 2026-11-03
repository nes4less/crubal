// A record's carriers in the store (5.5, revision 18): written by a commit, kept in the record's doc, read back
// by a fresh store, and taken off when the carrier leaves. Skipped without CRUBAL_PG_URL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { publish, shedBy, wearBy } from "@cruba/crubal";
import { connect, type Pool, testSchema } from "../src/db.ts";
import { PgStore } from "../src/store.ts";

const url = process.env.CRUBAL_PG_URL;
let pool: Pool;
let drop: () => Promise<void>;
before(async () => {
  if (!url) return;
  pool = connect(url);
  drop = await testSchema(pool);
});
after(async () => {
  if (!url) return;
  await drop();
  await pool.end();
});

const text = `package: disc /2026-10-01
  owner: lab.example
  label: Discs
  crubal: 2

kind: disc
  levels: disc
  base: Disc

name$
region$

class: Disc
  label: Disc
  for: disc
  facets:
    name

class: Regional
  label: Regional
  for: disc
  facets:
    region
`;

test("carriers are written, read back by a fresh store, and a leaving carrier takes off what it alone brought", { skip: !url }, async () => {
  const store = new PgStore(pool, "lab.example", { allowUnsigned: true });
  await store.install(publish(text, { date: "2026-10-01" }).bundle, undefined, "2026-10-17T00:00:00Z");
  await store.commit({ person: "lab.example" }, (d) => {
    d.records.set("D-1", wearBy({ id: "D-1", kind: "disc", level: "disc", owner: "lab.example", values: { name: "Alien" }, sources: { "*": { origin: "declared", via: "L-1" } } } as never, ["Regional"], { by: "gpc:10001234", version: "2026-10-01" }));
  }, "2026-10-17T00:00:01Z");
  const fresh = new PgStore(pool, "lab.example", { allowUnsigned: true });
  const r = await fresh.get("D-1");
  assert.deepEqual(r?.carriers, { Regional: [{ by: "gpc:10001234", version: "2026-10-01" }] });
  await fresh.commit({ person: "lab.example" }, (d) => {
    d.records.set("D-1", shedBy(d.records.get("D-1") as never, "gpc:10001234"));
  }, "2026-10-17T00:00:02Z");
  const after2 = await new PgStore(pool, "lab.example", { allowUnsigned: true }).get("D-1");
  assert.deepEqual(after2?.wears ?? [], []);
  assert.equal(after2?.carriers, undefined);
});
