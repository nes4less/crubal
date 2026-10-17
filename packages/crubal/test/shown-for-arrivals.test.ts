// Brief 3's engine work: a show rule's `for` scopes it (12.4), so a location's phone is the public's while a
// person's stays staff's, in access and in projections; and an arrival by a caller is permitted like a run
// (7.4 step 1, 14.4): an admitted member starts a member form, a stranger only one that grants the consumer's
// edge, nobody below staff a staff one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, readAccess } from "../src/access.ts";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";
import { MemoryRecords } from "../src/records.ts";
import { readViews, Views } from "../src/views.ts";

const DEFS = `kind: person
  levels: person
kind: location
  levels: location
name$
phone$
class: Location
  for: location
  facets:
    name
    phone
rule: phoneIsStaff
  for: everywhere
  strength: must
  then: phone shown to staff
rule: locationPhoneIsPublic
  for: Location
  strength: must
  then: phone shown to public
`;

const records = () =>
  new Map([
    ["P-1", { id: "P-1", kind: "person", level: "person", owner: "s", values: { name: "Sam", phone: "555-0101" }, sources: {} }],
    ["K-1", { id: "K-1", kind: "location", level: "location", owner: "s", wears: ["Location"], values: { name: "Shop", phone: "555-0100" }, sources: {} }],
  ]);

test("a show rule for a class decides for its records; the rule for everywhere decides for the rest", () => {
  const dict = readDefinitions(DEFS);
  const views = readViews(DEFS);
  assert.equal(views.shown.get("phone"), "staff");
  assert.deepEqual(views.shownFor.get("phone"), [{ for: "Location", audience: "public" }]);
  const { perms } = readAccess("permissions: p\n  menu:\n    x: see name\n  relations: customer\n");
  const edges = [{ edge: "E-m", who: "M", relation: "customer", mode: "consume", on: "K-1", grants: [], by: "owner", line: 0 }];
  const a = new Access(dict, perms, records() as never, edges as never, "s");
  a.views = views;
  assert.equal(a.may("M", "see", "phone", "K-1"), true, "a location's phone is the public's");
  assert.equal(a.may("M", "see", "phone", "P-1"), false, "a person's phone stays staff's");
});

test("a projection applies the scoped rule per record", () => {
  const src = `${DEFS}
shape: card
  slots:
    !name -> heading
    phone -> phone
view: places
  select:
    level: location
  shape: card
  show: public
view: people
  select:
    level: person
  shape: card
  show: public
`;
  const dict = readDefinitions(src);
  const rs = new MemoryRecords();
  for (const r of records().values()) rs.set(r.id, r as never);
  const v = new Views(dict, readViews(src), rs);
  const places = v.project("places", { audience: "public" }).rows;
  const people = v.project("people", { audience: "public" }).rows;
  assert.equal(places[0]?.phone, "555-0100");
  assert.equal(people[0]?.phone, undefined);
});

const ARRIVALS = `kind: order
  levels: order
kind: location
  levels: location
item$
locationName$
contract: placeOrder
  kind: form
  origin: declared
  relation: buyer
  needs:
    !item
contract: note
  kind: form
  origin: declared
  needs:
    !item
contract: location
  kind: form
  origin: declared
  audience: staff
  needs:
    !locationName
`;

const arrivals = (edges: { who: string; mode: string; grants?: string[] }[]) => {
  const dict = readDefinitions(ARRIVALS);
  const ex = new Exchange(dict, readContracts(ARRIVALS), [], []);
  ex.put({ id: "ROOT", kind: "order", level: "order", owner: "s", values: { item: "root" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  const { perms } = readAccess("permissions: p\n  menu:\n    places: run location\n  presets:\n    keeper: places   audience: staff\n  relations: operator, staff, customer, buyer\n");
  ex.access = new Access(dict, perms, ex.records as never, edges.map((e, i) => ({ edge: `E-${i}`, relation: "customer", on: "ROOT", grants: e.grants ?? [], by: "owner", line: 0, ...e })) as never, "s");
  return ex;
};

test("an arrival by a caller is permitted like a run: a stranger starts only what grants the consumer's edge, and is a member after", () => {
  const ex = arrivals([]);
  assert.equal(ex.arriveRun("note", JSON.stringify({ item: "x" }), "order", "S-1").stopped, "permission", "a member form is not a stranger's");
  assert.equal(ex.arriveRun("placeOrder", JSON.stringify({ item: "disc" }), "order", "S-1").stopped, undefined, "a first order makes a member");
  assert.equal(ex.arriveRun("note", JSON.stringify({ item: "x" }), "order", "S-1").stopped, undefined, "and a member starts a member form");
});

test("an admitted member starts a member form; a staff form takes staff", () => {
  const ex = arrivals([{ who: "M", mode: "consume" }, { who: "K", mode: "control", grants: ["keeper"] }]);
  assert.equal(ex.arriveRun("note", JSON.stringify({ item: "x" }), "order", "M").stopped, undefined);
  assert.equal(ex.arriveRun("location", JSON.stringify({ locationName: "Annex" }), "location", "M").stopped, "permission");
  assert.equal(ex.arriveRun("location", JSON.stringify({ locationName: "Annex" }), "location", "K").stopped, undefined);
});
