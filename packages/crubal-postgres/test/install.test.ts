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

test("one key, one definition: a package defining another's key with a different type is refused; a recipe restamps only the package's own records", { skip: !url }, async () => {
  const store = new PgStore(pool, "keys.example", { allowUnsigned: true });
  const a1 = publish(`package: places /2026-10-01
  owner: keys.example
  label: Places
  crubal: 2

kind: place
  levels: place
  base: Place

origin?

class: Place
  for: place
  facets:
    origin
`, { date: "2026-10-01" }).bundle;
  await store.install(a1, undefined, "2026-10-17T00:00:00Z");
  const clash = publish(`package: roots /2026-10-01
  owner: keys.example
  label: Roots
  crubal: 2

kind: root
  levels: root
  base: Root

origin&place

class: Root
  for: root
  facets:
    origin
`, { date: "2026-10-01" }).bundle;
  await assert.rejects(store.install(clash, undefined, "2026-10-17T00:00:01Z"), /defines origin as link, but keys.example\/places defines it as yes-no/);
  const sameTypeOtherList = publish(`package: sizes /2026-10-01
  owner: keys.example
  label: Sizes
  crubal: 2

kind: garment
  levels: garment
  base: Garment

origin{here|there}

class: Garment
  for: garment
  facets:
    origin
`, { date: "2026-10-01" }).bundle;
  await assert.rejects(store.install(sameTypeOtherList, undefined, "2026-10-17T00:00:01Z"), /defines origin as choice/);
  const roots1 = publish(`package: roots /2026-10-01
  owner: keys.example
  label: Roots
  crubal: 2

kind: root
  levels: root
  base: Root

from$

class: Root
  for: root
  facets:
    from
`, { date: "2026-10-01" }).bundle;
  await store.install(roots1, undefined, "2026-10-17T00:00:02Z");
  await store.commit(
    { person: "keys.example" },
    (d) => {
      d.records.set("R-1", { id: "R-1", kind: "root", level: "root", owner: "keys.example", values: { from: "K-1" }, sources: { "*": { origin: "declared", via: "L-1" } } });
      d.records.set("K-1", { id: "K-1", kind: "place", level: "place", owner: "keys.example", values: { origin: true, from: "here" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    },
    "2026-10-17T00:00:03Z",
  );
  const roots2 = publish(`package: roots /2026-10-02
  owner: keys.example
  label: Roots
  crubal: 2

kind: root
  levels: root
  base: Root

source$

class: Root
  for: root
  facets:
    source

migration: roots /2026-10-01 -> roots /2026-10-02
  facet: from
    move: -> source
`, { date: "2026-10-02", previous: roots1 }).bundle;
  const dry = await store.dryRun(roots2);
  assert.equal(dry.records, 1, "the dry run counts the package's own records");
  await store.install(roots2, undefined, "2026-10-17T00:00:04Z");
  const s = await store.state();
  assert.equal(s.records.get("R-1")?.values.source, "K-1", "the root's value moved");
  assert.equal(s.records.get("K-1")?.values.from, "here", "the place's value, another package's record, stayed");
});


test("the dry run and the restamp read the package's own records by kind and class, never the catalog whole", { skip: !url }, async () => {
  const store = new PgStore(pool, "narrow.example", { allowUnsigned: true });
  const v1 = publish(text("2026-10-01", "S|M|L"), { date: "2026-10-01" }).bundle;
  const v2 = publish(text("2026-10-02", "Small|M|L", RECIPE_12), { date: "2026-10-02", previous: v1 }).bundle;
  await store.install(v1, undefined, "2026-10-17T00:00:00Z");
  await store.commit(
    { person: "narrow.example" },
    (d) => {
      d.records.set("T-1", { id: "T-1", kind: "thing", level: "thing", owner: "narrow.example", values: { size: "S" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    },
    "2026-10-17T00:00:01Z",
  );
  // A million-record owner's install read every record into memory for a recipe over a dozen (2026-10-22):
  // from here, reading the catalog whole is the failure.
  (store as unknown as { wholeState: () => Promise<never> }).wholeState = async () => {
    throw new Error("the catalog was read whole");
  };
  const dry = await store.dryRun(v2);
  assert.equal(dry.records, 1, "the dry run counts the package's own records without the whole state");
  assert.deepEqual(dry.recipes.map((r) => r.steps.map((s) => s.changed)), [[1]]);
  await store.install(v2, undefined, "2026-10-17T00:00:02Z");
  assert.equal((await store.records({ kind: "thing" }))[0]?.values.size, "Small", "the restamp moved the value from the package's own records");
});

const shelf = (v: string, noteLabel: string, extraFacet = "", extraClassFacet = "") => `package: shelf /${v}
  owner: lab.example
  label: Shelf
  crubal: 2

kind: book
  levels: book
  base: Book

title$200
facet: note
  type: text
  label: ${noteLabel}
${extraFacet}
class: Book
  label: Book
  for: book
  facets:
    title
    note
${extraClassFacet}
shape: titled
  slots:
    title -> title
shape: noted
  slots:
    note -> title
view: byTitle
  select:
    level: book
  shape: titled
view: byNote
  select:
    level: book
  shape: noted

permissions: shelf
  menu:
    shelving: edit title
  presets:
    shelver: shelving                      audience: staff
  relations: operator, staff, customer
`;

test("a pin move marks stale only the views the version can have changed; a version that touches nothing they read marks none", { skip: !url }, async () => {
  const owner = "shelf.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const v1 = publish(shelf("2026-10-01", "Note"), { date: "2026-10-01" }).bundle;
  const v2 = publish(shelf("2026-10-02", "Remark"), { date: "2026-10-02", previous: v1 }).bundle;
  const v3 = publish(shelf("2026-10-03", "Remark", "color$", "    color"), { date: "2026-10-03", previous: v2 }).bundle;
  await store.install(v1, undefined, "2026-10-17T00:00:00Z");
  await store.commit(
    { person: owner },
    (d) => {
      d.records.set("B-1", { id: "B-1", kind: "book", level: "book", owner, values: { title: "Dune", note: "worn" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    },
    "2026-10-17T00:00:01Z",
  );
  const marks = async () => (await pool.query("select view, record from stale where owner = $1 order by view, record", [owner])).rows.map((r: { view: string; record: string }) => `${r.view}:${r.record}`);
  await pool.query("delete from stale where owner = $1", [owner]);
  // The note's label changes: the view whose shape reads note rebuilds; the view over titles is untouched.
  await store.install(v2, undefined, "2026-10-17T00:00:02Z");
  assert.deepEqual(await marks(), ["byNote:B-1"], "only the view reading the changed facet is marked");
  await pool.query("delete from stale where owner = $1", [owner]);
  // A new facet nothing reads: no view rebuilds.
  await store.install(v3, undefined, "2026-10-17T00:00:03Z");
  assert.deepEqual(await marks(), [], "a version that changes nothing a view reads marks no view");
});
