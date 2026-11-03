// The definitions as built, kept in the store (the speed round, 2026-11-03): a new instance reads them back
// instead of replaying every installed version; what it reads equals what was built, down to the maps and the
// prototypes; a define write or an install changes the key, so a stale copy is never read. Skipped without
// CRUBAL_PG_URL.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { publish } from "@cruba/crubal";
import { connect, type Pool, testSchema } from "../src/db.ts";
import { definitionsOf, forgetParsedShared, latestInstalls } from "../src/definitions.ts";
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

const text = (v: string, sizes: string, extra = "", perms = "  presets:\n    sizer: sizing                      audience: staff\n") => `package: thing /${v}
  owner: lab.example
  label: Things
  crubal: 2

kind: thing
  levels: thing
  base: Thing

size{${sizes}}

class: Thing
  label: Thing
  for: thing
  facets:
    size

permissions: lab
  menu:
    sizing: edit size
${perms}  relations: operator, staff, customer
${extra}`;

test("a new instance reads the definitions another built, equal to them; an install moves the key and the next read builds again", { skip: !url }, async () => {
  const store = new PgStore(pool, "built.example", { allowUnsigned: true });
  const v1 = publish(text("2026-10-01", "S|M|L"), { date: "2026-10-01" }).bundle;
  await store.install(v1, undefined, "2026-10-17T00:00:00Z");
  const client = await pool.connect();
  try {
    forgetParsedShared();
    const built = await definitionsOf(client, "built.example");
    const row = await client.query("select key from definitions_built where owner = $1", ["built.example"]);
    assert.equal(row.rows.length, 1, "the build is kept");
    assert.match(String(row.rows[0]?.key), /thing\/2026-10-01/);
    forgetParsedShared();
    const read = await definitionsOf(client, "built.example");
    assert.notEqual(read, built, "a new instance's copy, not the same object");
    assert.deepStrictEqual(read, built, "equal to what was built, maps and prototypes included");
    assert.ok(read.dict.facets.has("size"));
    const v2 = publish(text("2026-10-02", "S|M|L|XL"), { date: "2026-10-02", previous: v1 }).bundle;
    await store.install(v2, undefined, "2026-10-17T00:00:01Z");
    forgetParsedShared();
    const after2 = await definitionsOf(client, "built.example");
    assert.deepEqual(
      after2.dict.facets.get("size")?.values?.map((v) => v.value),
      ["S", "M", "L", "XL"],
      "the install's values, never the kept copy's",
    );
    const row2 = await client.query("select key from definitions_built where owner = $1", ["built.example"]);
    assert.match(String(row2.rows[0]?.key), /thing\/2026-10-02/, "the new build is kept");
  } finally {
    client.release();
  }
});

test("inside a transaction a failing keep never aborts the caller's work", { skip: !url }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("create temporary table t_guard (x int) on commit drop");
    forgetParsedShared();
    await definitionsOf(client, "built.example");
    await client.query("insert into t_guard values (1)");
    await client.query("commit");
  } finally {
    client.release();
  }
});

test("the versions in force are each package's latest install, where it was last installed", () => {
  const row = (p: string, v: string) => ({ json: { package: p, version: v } });
  const got = latestInstalls([row("a", "1"), row("b", "1"), row("a", "2"), row("c", "1"), row("b", "2")]);
  assert.deepEqual(
    got.map((r) => `${r.json.package}/${r.json.version}`),
    ["a/2", "c/1", "b/2"],
  );
});

test("a place that installed two versions reads the same definitions as one that installed the latest alone", { skip: !url }, async () => {
  const v1 = publish(text("2026-10-01", "S|M|L"), { date: "2026-10-01" }).bundle;
  const v2 = publish(text("2026-10-02", "S|M|L|XL"), { date: "2026-10-02", previous: v1 }).bundle;
  const both = new PgStore(pool, "both.example", { allowUnsigned: true });
  await both.install(v1, undefined, "2026-10-17T00:00:00Z");
  await both.install(v2, undefined, "2026-10-17T00:00:01Z");
  const latest = new PgStore(pool, "latest.example", { allowUnsigned: true });
  await latest.install(v2, undefined, "2026-10-17T00:00:00Z");
  const client = await pool.connect();
  try {
    forgetParsedShared();
    const a = await definitionsOf(client, "both.example");
    const b = await definitionsOf(client, "latest.example");
    assert.deepStrictEqual(a.dict, b.dict);
    assert.deepStrictEqual(a.contracts, b.contracts);
    assert.deepStrictEqual(a.views, b.views);
    assert.deepStrictEqual(a.perms, b.perms);
  } finally {
    client.release();
  }
});
