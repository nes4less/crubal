import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, readAccess } from "../src/access.ts";
import { MemoryRecords } from "../src/records.ts";
import { readDefinitions } from "../src/defs.ts";
import { apply, emptyStore, issue, pending } from "../src/lifecycle.ts";
import { rebuild, redactable } from "../src/log.ts";
import { readTree } from "../src/tree.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
  vary:
    unit: price
title$
price#USD
graded?
grade{Graded|Ungraded}
`);

test("rebuild applies effects in order and a held value leaves the current values", () => {
  const state = rebuild([
    { log: "L-1", at: "2026-01-01T00:00:00Z", source: { origin: "declared" }, writes: [{ record: "P-1", envelope: "created", value: { kind: "item", level: "product", owner: "t" } }, { record: "P-1", address: "title", value: "A" }] },
    { log: "L-2", at: "2026-01-02T00:00:00Z", writes: [{ record: "P-1", address: "title", as: "held", rule: "r" }] },
  ]);
  const p = state.records.get("P-1") as unknown as { values: object; held: object; updated: string };
  assert.deepEqual(p.values, {});
  assert.deepEqual(p.held, { title: { value: "A", rule: "r" } });
  assert.equal(p.updated, "2026-01-02T00:00:00Z");
});

test("only value, observation and read writes may be redacted; witnessed entries never", () => {
  assert.equal(redactable({ log: "L-1", writes: [{ record: "P-1", address: "title", value: "A" }] }), null);
  assert.ok(redactable({ log: "L-1", writes: [{ record: "P-1", envelope: "created", value: {} }] }));
  assert.ok(redactable({ log: "L-1", witnessed: true, writes: [] }));
});

test("instructions pend per issuer and apply in order", () => {
  const store = emptyStore();
  store.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner: "t", values: {} });
  store.records.set("U-1", { id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", values: { graded: true }, sources: { "*": { origin: "observed", via: "L-2" } } });
  issue(store, "P-1", readTree("+grade\n-graded -> grade\n  yes -> Graded\n  no -> Ungraded\n"));
  assert.equal(pending(store, store.records.get("U-1")!).length, 2);
  apply(store, "U-1", dict);
  const u = store.records.get("U-1")!;
  assert.deepEqual(u.values, { grade: "Graded" });
  assert.deepEqual(u.applied, { "P-1": 2 });
  assert.equal(pending(store, u).length, 0);
});

test("an edge is only as good as its grantor, and the owner holds admin everywhere", () => {
  const { perms, edges } = readAccess(`
permissions: p
  menu:
    recordScores: edit score
  relations: operator, coordinator
edge: E-1
  who: C-OP
  relation: operator
  mode: admin
  on: F-1
  by: owner
edge: E-3
  who: C-CO
  relation: coordinator
  mode: control
  on: L-1
  grants: recordScores
  until: 2027-06-30T00:00Z
  by: E-1
`);
  const records = new MemoryRecords([
    ["F-1", { id: "F-1", kind: "facility", level: "facility", owner: "t", values: {} }],
    ["L-1", { id: "L-1", kind: "league", level: "league", owner: "t", within: "F-1", values: {} }],
    ["T-1", { id: "T-1", kind: "team", level: "team", owner: "t", within: "L-1", values: {} }],
  ]);
  const before = new Access(dict, perms, records, edges, "t", "2027-01-01T00:00Z");
  assert.ok(before.may("C-CO", "edit", "score", "T-1"));
  assert.ok(!before.may("C-CO", "edit", "score", "F-1"));
  assert.ok(before.may("t", "merge", "T-1", "T-1"));
  const after = new Access(dict, perms, records, edges, "t", "2027-07-01T00:00Z");
  assert.equal(after.effective("C-CO", "T-1").mode, "none");
  assert.deepEqual(after.ancestors("T-1"), ["L-1", "F-1"]);
});
