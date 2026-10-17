// Found by the engine pass of 2026-10-17 (docs/design/defects.md): a compound answer as an object is one
// answer, folded child by child (chapter 3, 7.7); an empty-string answer is no answer; a bare decimal under a
// facet with a unit is a number in that unit; and each access mode includes the ones below it (14.4), so a
// control holder still sees what a member sees.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, readAccess } from "../src/access.ts";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const DEFS = `kind: order
  levels: order
facet: shipTo
  type: compound
  label: Ship to
  facets:
    name$200
    street$
    sealed?
total#USD
weight#kg accepts: g, lb
note$
`;
const CONTRACTS = `contract: checkout
  kind: form
  origin: declared
  needs:
    shipTo
    total
    weight
    note
`;
const fresh = () => {
  const ex = new Exchange(readDefinitions(DEFS), readContracts(CONTRACTS), [], []);
  ex.put({ id: "O-1", kind: "order", level: "order", owner: "s", values: { total: "10", note: "keep" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  return ex;
};

test("a compound answer as an object lands whole, its children folded under their facets", () => {
  const ex = fresh();
  const r = ex.receiveRun("checkout", "O-1", JSON.stringify({ shipTo: { name: "Sam", street: "1 Main", sealed: true } }), "P-1");
  assert.equal(r.stopped, undefined, JSON.stringify(r));
  assert.deepEqual((r.outcomes as { to?: string; outcome: string }[]).map((o) => [o.to, o.outcome]), [["shipTo", "absorbed"]]);
  assert.deepEqual(ex.get("O-1")?.values.shipTo, { name: "Sam", street: "1 Main", sealed: true });
});

test("a compound answer with a child that contradicts its facet is a contradiction naming the child; nothing lands", () => {
  const ex = fresh();
  const r = ex.receiveRun("checkout", "O-1", JSON.stringify({ shipTo: { name: "Sam", sealed: "maybe" } }), "P-1");
  assert.deepEqual((r.outcomes as { to?: string; outcome: string; cites?: { type?: string } }[]).map((o) => [o.to, o.outcome, o.cites?.type]), [["shipTo", "contradiction", "sealed"]]);
  assert.equal(ex.get("O-1")?.values.shipTo, undefined);
});

test("a bare decimal under a facet with a unit is that number in the unit; a JSON number too; a unit spelling still converts", () => {
  const ex = fresh();
  ex.receiveRun("checkout", "O-1", JSON.stringify({ total: 12.5, weight: "2.25" }), "P-1");
  assert.deepEqual(ex.get("O-1")?.values.total, { $money: "12.5", currency: "USD" });
  assert.deepEqual(ex.get("O-1")?.values.weight, { $qty: "2.25", unit: "kg" });
  ex.receiveRun("checkout", "O-1", JSON.stringify({ weight: "500 g" }), "P-1");
  assert.deepEqual(ex.get("O-1")?.values.weight, { $qty: "0.5", unit: "kg" });
});

test("an empty-string answer is no answer: ignored, the value kept", () => {
  const ex = fresh();
  const r = ex.receiveRun("checkout", "O-1", JSON.stringify({ note: "", total: "11" }), "P-1");
  // The total differs from the current value, so it is a conflict the trust order decides (9.3): the person wins.
  assert.deepEqual((r.outcomes as { from: string; outcome: string }[]).map((o) => [o.from, o.outcome]), [["note", "ignored"], ["total", "conflict"]]);
  assert.equal(ex.get("O-1")?.values.note, "keep");
  assert.deepEqual(ex.get("O-1")?.values.total, { $money: "11", currency: "USD" });
});

test("each mode includes the ones below it: a control holder sees what a member sees", () => {
  const dict = readDefinitions("kind: deployment\n  levels: deployment\nname$\n");
  const { perms } = readAccess("permissions: p\n  menu:\n    settings: edit Deployment, run settings\n  presets:\n    controller: settings   audience: staff\n  relations: operator, staff, customer\n");
  const records = new Map([["ROOT", { id: "ROOT", kind: "deployment", level: "deployment", owner: "s", values: {} }]]);
  const edges = [
    { edge: "E-m", who: "M", relation: "customer", mode: "view", on: "ROOT", grants: [], by: "owner", line: 0 },
    { edge: "E-s", who: "S", relation: "staff", mode: "control", on: "ROOT", grants: ["controller"], by: "owner", line: 0 },
  ];
  const a = new Access(dict, perms, records as never, edges as never, "s");
  assert.equal(a.may("M", "see", "name", "ROOT"), true);
  assert.equal(a.may("S", "see", "name", "ROOT"), true, "staff see at least what a member sees");
  assert.equal(a.may("S", "edit", "Deployment", "ROOT"), true);
  assert.equal(a.may("S", "grant", "settings", "ROOT"), false, "nothing beyond the items and the lower modes");
  assert.equal(a.may("M", "edit", "Deployment", "ROOT"), false);
});

test("a see below admin is the audience's by the show rules, or an item's: a member never sees a staff facet", () => {
  const dict = readDefinitions("kind: item\n  levels: item\ntitle$\ncost#USD\nnotes$\n");
  const { perms } = readAccess("permissions: p\n  menu:\n    read: see title, see cost\n    other: see notes\n  presets:\n    helper: read   audience: staff\n  relations: operator, staff, customer\n");
  const records = new Map([["I-1", { id: "I-1", kind: "item", level: "item", owner: "s", values: {} }]]);
  const edges = [
    { edge: "E-m", who: "M", relation: "customer", mode: "consume", on: "I-1", grants: [], by: "owner", line: 0 },
    { edge: "E-h", who: "H", relation: "staff", mode: "control", on: "I-1", grants: ["helper"], by: "owner", line: 0 },
    { edge: "E-o", who: "O", relation: "staff", mode: "control", on: "I-1", grants: ["other"], by: "owner", line: 0 },
  ];
  const a = new Access(dict, perms, records as never, edges as never, "s");
  a.views = { shown: new Map([["cost", "staff"], ["notes", "staff"]]), shownFor: new Map() };
  assert.equal(a.may("M", "see", "title", "I-1"), true);
  assert.equal(a.may("M", "see", "cost", "I-1"), false, "a member never sees a staff facet");
  assert.equal(a.may("H", "see", "cost", "I-1"), true, "the item grants it within the staff audience");
  assert.equal(a.may("H", "see", "title", "I-1"), true);
  assert.equal(a.may("H", "see", "notes", "I-1"), false, "default deny above member: no item, no staff facet");
  assert.equal(a.may("O", "see", "notes", "I-1"), true);
  assert.equal(a.may("nobody", "see", "title", "I-1"), false);
});
