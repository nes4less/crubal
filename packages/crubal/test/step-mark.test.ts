// Revision 34 (spec 12.3, 12.10, 12.11): a step's mark. A filter over a mark has two buckets, open (no real
// value) and done; a lane names its step in place of pick and done, and the marks that end the waiting
// (until); a flow's step stops stand in any order and chain with nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkPackages, flowStamps, readPackages } from "../src/packages.ts";
import { CrubalError } from "../src/tree.ts";
import { checkViews, readViews, Views } from "../src/views.ts";
import { actWrites, markFacets } from "../src/acts.ts";

const lane = (name: string, step: string, until: string, act: string) => `lane: ${name} /2027-01-05
  label: ${name}
  utility: orders
  view: lines
  step: ${step}${until ? `\n  until: ${until}` : ""}
  band: daily
  serves: owner, fulfiller(pick)
  home:
    figure: count
    press: Go -> /orders
  card:
    name: title
    primary: Go -> ${act}
`;

const lanes = `${lane("linesToPull", "pulled", "shipped, cancelled", "pull")}
${lane("linesToPack", "packed", "shipped, cancelled", "pack")}
${lane("linesToShip", "shipped", "cancelled", "ship")}`;

const flow = (stops: string, done = "shipped") => `flow: pullPackShip /2027-01-05
  label: Pull, pack, ship
  utility: orders
  follow: queue
  serves: owner, fulfiller(pick)
  stops:
${stops.split(",").map((s) => `    ${s.trim()}`).join("\n")}
  done: ${done}`;

const shop = (tail: string) => `package: shop /2027-01-05
  owner: shop.example
  crubal: 2

kind: order
  levels: order, line
title$
orderState{paid|shipped}
pulled@
packed@
shipped@
cancelled@

shape: lineRow
  slots:
    title -> title

filter: pulled
  facet: pulled
  buckets: marked

filter: packed
  facet: packed
  buckets: marked

filter: shipped
  facet: shipped
  buckets: marked

filter: cancelled
  facet: cancelled
  buckets: marked

filter: orderState
  facet: orderState

view: lines
  label: Lines
  select:
    level: line
  shape: lineRow
  filters: pulled, packed, shipped, cancelled, orderState
  show: staff

permissions: shop
  menu:
    pick: run pick
  presets:
    fulfiller: pick    audience: staff
  relations: buyer, follower only

utility: orders /2027-01-05
  label: Orders
  serves: owner, fulfiller(pick)
  acts: pull, pack, ship
  mark: parcel amber

${tail}
`;

const refused = (tail: string, why: RegExp) => assert.throws(() => checkPackages(shop(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("a marked filter has two buckets: open holds the records with no value, done those with one", () => {
  const src = shop("");
  const dict = readDefinitions(src);
  const set = readViews(src);
  checkViews(set, dict);
  assert.equal(set.filters.get("pulled")?.marked, true);
  const v = new Views(dict, set);
  const rec = (id: string, values: Record<string, string>) => ({ id, kind: "order", level: "line", owner: "t", values });
  v.put(rec("A", { title: "a" }));
  v.put(rec("B", { title: "b", pulled: "2027-01-05T10:00:00Z" }));
  v.put(rec("C", { title: "c", pulled: "2027-01-05T10:00:00Z", shipped: "2027-01-06T10:00:00Z" }));
  const p = v.project("lines", { audience: "staff" });
  assert.deepEqual(p.counts.pulled, { open: 1, done: 2 });
  assert.deepEqual(p.counts.shipped, { open: 2, done: 1 });
  // A step lane's to-dos: open on its step, and open on each until.
  const ahead = v.project("lines", { audience: "staff", picks: { packed: ["open"], shipped: ["open"], cancelled: ["open"] } });
  assert.deepEqual([...ahead.records].sort(), ["A", "B"], "a line shipped without being packed waits to pack no longer");
});

test("a lane's step is read in place of pick and done, with its untils, and travels through the bundle and back", () => {
  const [info] = readPackages(shop(lanes));
  const pull = info?.lanes.find((l) => l.name === "linesToPull");
  assert.equal(pull?.step, "pulled");
  assert.deepEqual(pull?.until, ["shipped", "cancelled"]);
  assert.deepEqual([pull?.pick?.filter, pull?.pick?.value], ["pulled", "open"]);
  assert.deepEqual(pull?.done === "viewed" ? [] : [pull?.done?.filter, pull?.done?.value], ["pulled", "done"]);
  checkPackages(shop(`${lanes}\n${flow("linesToPull -> pull, linesToPack -> pack, linesToShip -> ship")}`));
  const source = shop(`${lanes}\n${flow("linesToPull -> pull, linesToPack -> pack, linesToShip -> ship")}`);
  const bundle = bundleOf(parsePackage(source));
  const json = bundle.lanes as { lane: string; step?: string; until?: string[]; pick?: unknown; done?: unknown }[];
  const j = json.find((l) => l.lane === "linesToPull");
  assert.deepEqual([j?.step, j?.until, j?.pick, j?.done], ["pulled", ["shipped", "cancelled"], undefined, undefined]);
  const text = printBundle(bundle);
  assert.match(text, /buckets: marked/);
  assert.match(text, /step: pulled\n {2}until: shipped, cancelled/);
  assert.match(text, /\n {2}done: shipped\n/);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
});

test("a step lane is refused when its step or until is no marked filter of its view, or it names a pick or a done as well", () => {
  refused(lane("x", "orderState", "", "pull"), /step names orderState, which isn't a marked filter/);
  refused(lane("x", "pulled", "orderState", "pull"), /until names orderState, which isn't a marked filter/);
  refused(lane("x", "nowhere", "", "pull"), /step names nowhere, which isn't a filter of lines/);
  assert.throws(() => readPackages(shop(lane("x", "pulled", "", "pull").replace("  step: pulled", "  step: pulled\n  pick: orderState = paid"))), /names a step, so it names no pick and no done/);
  assert.throws(() => readPackages(shop(lane("x", "pulled", "", "pull").replace("  step: pulled", "  pick: orderState = paid\n  until: shipped"))), /names an until, so it needs a step/);
});

test("a flow's step stops stand in any order, any may be left out, and each stamps its mark", () => {
  checkPackages(shop(`${lanes}\n${flow("linesToShip -> ship, linesToPull -> pull, linesToPack -> pack")}`));
  checkPackages(shop(`${lanes}\n${flow("linesToPull -> pull, linesToShip -> ship")}`));
  refused(`${lanes}\n${flow("linesToPull -> pull", "orderState")}`, /done names orderState, which isn't a marked filter/);
  const [info] = readPackages(shop(`${lanes}\n${flow("linesToPack -> pack, linesToPull -> pull, linesToShip -> ship")}`));
  const f = info?.flows[0];
  assert.ok(f && info);
  assert.deepEqual(f.done && [f.done.filter, f.done.value, f.done.mark], ["shipped", "done", true]);
  assert.deepEqual(flowStamps(f, info.lanes, (flt) => flt), [
    { stop: "linesToPack", at: 0, facet: "packed", value: "done", mark: true },
    { stop: "linesToPull", at: 1, facet: "pulled", value: "done", mark: true },
    { stop: "linesToShip", at: 2, facet: "shipped", value: "done", mark: true },
  ]);
});

test("a mark is taken once: an act that sets a mark the record holds is stopped before any write; cleared, it may be taken again", () => {
  const src = shop(`act: pull /2027-01-05
  label: Pull
  utility: orders
  on: line
  set:
    pulled -> now

act: putBack /2027-01-05
  label: Put back
  utility: orders
  on: line
  set:
    pulled -> none`);
  const marks = markFacets(readViews(src).filters.values());
  assert.deepEqual(marks.sort(), ["cancelled", "packed", "pulled", "shipped"]);
  const acts = readPackages(src)[0]?.acts ?? [];
  const pull = acts.find((a) => a.name === "pull");
  const back = acts.find((a) => a.name === "putBack");
  assert.ok(pull && back);
  const open = { id: "L1", values: { title: "a" } };
  const taken = { id: "L1", values: { title: "a", pulled: "2027-01-05T10:00:00Z" } };
  const first = actWrites(pull, { record: open, context: {}, found: {}, now: "2027-01-05T10:00:00Z", marks });
  assert.deepEqual(first.ok && first.record, { pulled: "2027-01-05T10:00:00Z" });
  assert.deepEqual(actWrites(pull, { record: taken, context: {}, found: {}, now: "x", marks }), { ok: false, why: "pulled is taken: a mark is set once" });
  const cleared = actWrites(back, { record: taken, context: {}, found: {}, now: "x", marks });
  assert.deepEqual(cleared.ok && cleared.clear, ["pulled"]);
});
