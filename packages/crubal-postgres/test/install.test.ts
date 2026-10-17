// Found by the engine pass of 2026-10-17 (docs/design/defects.md): an install two versions ahead restamps
// through every recipe between, in order (10.1, 10.4), and the dry run reports the same; a version that
// drops a preset or item live edges still grant is refused (14.12). Skipped without CRUBAL_PG_URL.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { publish } from "@cruba/crubal";
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

const RECIPE_12 = `
migration: thing /2026-10-01 -> thing /2026-10-02
  facet: size
    rename: S -> Small
`;
const RECIPE_23 = `
migration: thing /2026-10-02 -> thing /2026-10-03
  facet: size
    rename: M -> Medium
`;

test("an install two versions ahead restamps through both recipes in order; the dry run says so first", { skip: !url }, async () => {
  const store = new PgStore(pool, "lab.example", { allowUnsigned: true });
  const v1 = publish(text("2026-10-01", "S|M|L"), { date: "2026-10-01" }).bundle;
  const v2 = publish(text("2026-10-02", "Small|M|L", RECIPE_12), { date: "2026-10-02", previous: v1 }).bundle;
  const v3 = publish(text("2026-10-03", "Small|Medium|L", RECIPE_12 + RECIPE_23), { date: "2026-10-03", previous: v2 }).bundle;
  await store.install(v1, undefined, "2026-10-17T00:00:00Z");
  await store.commit(
    { person: "lab.example" },
    (d) => {
      d.records.set("T-1", { id: "T-1", kind: "thing", level: "thing", owner: "lab.example", values: { size: "S" }, sources: { "*": { origin: "declared", via: "L-1" } } });
      d.records.set("T-2", { id: "T-2", kind: "thing", level: "thing", owner: "lab.example", values: { size: "M" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    },
    "2026-10-17T00:00:01Z",
  );
  const dry = await store.dryRun(v3);
  assert.deepEqual(
    dry.recipes.map((r) => [r.from, r.to, r.steps.map((s) => s.changed)]),
    [
      ["thing /2026-10-01", "thing /2026-10-02", [1]],
      ["thing /2026-10-02", "thing /2026-10-03", [1]],
    ],
  );
  await store.install(v3, undefined, "2026-10-17T00:00:02Z");
  const s = await store.state();
  assert.equal(s.records.get("T-1")?.values.size, "Small");
  assert.equal(s.records.get("T-2")?.values.size, "Medium");
});

test("a version that drops a preset live edges grant is refused; lapsed edges don't count", { skip: !url }, async () => {
  const store = new PgStore(pool, "grants.example", { allowUnsigned: true });
  const v1 = publish(text("2026-10-01", "S|M|L"), { date: "2026-10-01" }).bundle;
  const v2 = publish(text("2026-10-02", "S|M|L", "", ""), { date: "2026-10-02", previous: v1 }).bundle;
  await store.install(v1, undefined, "2026-10-17T00:00:00Z");
  await store.commit(
    { person: "grants.example" },
    (d) => {
      d.records.set("T-1", { id: "T-1", kind: "thing", level: "thing", owner: "grants.example", values: { size: "S" }, sources: { "*": { origin: "declared", via: "L-1" } } });
      d.edges.set("E-1", { edge: "E-1", who: "P-9", relation: "staff", mode: "control", on: "T-1", grants: ["sizer"], by: "owner" });
    },
    "2026-10-17T00:00:01Z",
  );
  await assert.rejects(store.install(v2, undefined, "2026-10-17T00:00:02Z"), /drops sizer, which E-1 still grant/);
  await store.commit(
    { person: "grants.example" },
    (d) => {
      d.edges.set("E-1", { edge: "E-1", who: "P-9", relation: "staff", mode: "control", on: "T-1", grants: ["sizer"], by: "owner", until: "2026-10-17T00:00:02Z" });
    },
    "2026-10-17T00:00:02Z",
  );
  await store.install(v2, undefined, "2026-10-17T00:00:03Z");
  const installed = (await store.state()).installed.map((i) => String(i.version));
  assert.deepEqual(installed, ["2026-10-01", "2026-10-02"]);
});
