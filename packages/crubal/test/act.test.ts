// Acts as declarations (chapter 15, revision 25): an `act:` block read with its parts, carried into the bundle and
// back, versioned in `members`, checked, and the writes a landing makes answered from what the finds found.

import assert from "node:assert/strict";
import { test } from "node:test";
import { followersOn } from "../src/access.ts";
import { type ActRecord, actWrites, findPicksOf, givenOf, mintValuesOf, nextInSeries, routeCountPicksOf, routeOf, tellsValuesOf } from "../src/acts.ts";
import type { JsonObject } from "../src/model.ts";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkActsInForce, checkPackages, readPackages } from "../src/packages.ts";
import { publish } from "../src/publish.ts";
import { CrubalError } from "../src/tree.ts";

const bench = (tail: string) => `package: bench /2026-11-08
  owner: shop.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
kind: container
  levels: container
  base: Container
kind: station
  levels: station
  base: Station
kind: location
  levels: location
  base: Location
title$
condition$
filedIn&container
filedBox$
filedSlot$
filedAt@
containerLabel$
containerState{open|full}
containerCount#
containerCapacity#
containerStation&station
containerSlot$
containerLocation&location
unitPrint$
printer$
stationLocation&location
filledAt@
locationName$
facet: slots
  type: compound
  pick: any
  ordered: yes
  label: Routing
  facets:
    !slotName$80
    slotRule$
    boxPrefix$20
    boxSuffix$20
    boxCapacity# 1..10000
    keep# 1..1000

class: Item
  for: item
  facets:
    !title
    condition
    filedIn
    filedBox
    filedSlot
    filedAt
class: Container
  for: container
  facets:
    !containerLabel
    containerState
    containerCount
    containerCapacity
    containerStation
    containerSlot
    containerLocation
    filledAt
class: Station
  for: station
  facets:
    unitPrint
    printer
    stationLocation
    slots
class: Location
  for: location
  facets:
    locationName

utility: bench /2026-11-08
  label: Bench
  serves: owner
  acts: file, label
  mark: box amber

${tail}`;

const file = `act: file /2026-11-08
  utility: bench
  label: File
  on: unit
  context: station
  find:
    box -> first container where containerStation = context.station, containerState = open order containerLabel
  set:
    filedIn -> link box
    filedBox -> box.containerLabel
    filedAt -> now
  then:
    when box.containerCount + 1 >= box.containerCapacity set box.containerState = full
`;

const label = `act: label /2026-11-08
  utility: bench
  label: Print the label
  on: unit
  context: station
  send: print context.station.unitPrint to context.station.printer
  lands: when the send reports
`;

test("an act block is read with its parts: the level, the context, the finds, the sets, the thens, the send, the landing", () => {
  const [info] = readPackages(bench(file + label));
  const a = info?.acts.find((x) => x.name === "file");
  assert.equal(a?.utility, "bench");
  assert.equal(a?.on, "unit");
  assert.deepEqual(a?.context, ["station"]);
  assert.deepEqual(a?.finds.map((f) => [f.name, f.take, f.kind, f.where.length, f.order?.facet]), [["box", "first", "container", 2, "containerLabel"]]);
  assert.deepEqual(a?.finds[0]?.where.map((p) => p.value), [{ context: "station" }, { literal: "open" }]);
  assert.deepEqual(a?.sets.map((s) => s.source), [{ link: "box" }, { found: "box", facet: "containerLabel" }, { now: true }]);
  assert.deepEqual(a?.thens[0]?.when, { left: { ref: { found: "box", facet: "containerCount" }, plus: 1 }, op: ">=", right: { ref: { found: "box", facet: "containerCapacity" } } });
  assert.equal(a?.lands, "now");
  const b = info?.acts.find((x) => x.name === "label");
  assert.deepEqual(b?.send, { verb: "print", words: "context.station.unitPrint to context.station.printer" });
  assert.equal(b?.lands, "reports");
  checkPackages(bench(file + label));
});

test("an act round-trips through its bundle and is versioned in members", () => {
  const first = bundleOf(parsePackage(bench(file + label)));
  const acts = first.acts as { act: string }[];
  assert.deepEqual(acts.map((a) => a.act), ["file", "label"]);
  const text = printBundle(first);
  assert.match(text, /^act: file \/2026-11-08$/m);
  assert.match(text, /^    box -> first container where containerStation = context\.station, containerState = open order containerLabel$/m);
  assert.match(text, /^    when box\.containerCount \+ 1 >= box\.containerCapacity set box\.containerState = full$/m);
  assert.match(text, /^  send: print context\.station\.unitPrint to context\.station\.printer$/m);
  assert.match(text, /^  lands: when the send reports$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  const { bundle } = publish(bench(file + label), { date: "2026-11-08" });
  assert.equal((bundle.members as { [k: string]: string })["act:file"], "2026-11-08");
  // Valueless: a later version without it publishes with no recipe.
  const { changes } = publish(bench(label), { previous: bundle, date: "2026-11-09" });
  assert.equal(changes.find((c) => c.member === "act:file")?.kind, "safe");
});

const refused = (tail: string, why: RegExp) => assert.throws(() => checkPackages(bench(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("an act is refused when its utility lacks it, its level, kind or facet is unknown, a find or context is named undeclared, or it lands on a send it lacks", () => {
  refused(file.replace("act: file", "act: pack"), /the act pack isn't among bench's acts/);
  refused(file.replace("on: unit", "on: parcel"), /is on parcel, which isn't a level/);
  refused(file.replace("first container", "first parcel"), /finds parcel, which isn't a kind/);
  refused(file.replace("filedBox -> box.containerLabel", "weight -> box.containerLabel"), /sets weight, which isn't a facet/);
  refused(file.replace("filedIn -> link box", "filedIn -> link crate"), /links filedIn to crate, which no find or context declares/);
  refused(file.replace("  context: station\n", ""), /names context.station, which its context lacks/);
  assert.throws(() => readPackages(bench(file.replace("  then:\n    when box.containerCount + 1 >= box.containerCapacity set box.containerState = full\n", "  lands: when the send reports\n"))), /lands when the send reports, but sends nothing/);
});

test("the writes a landing makes: the links, the copies, the moment, and the then when it holds; nothing without the first find", () => {
  const [info] = readPackages(bench(file));
  const a = info?.acts[0];
  assert.ok(a);
  const station = { id: "T-1", values: { unitPrint: "tag" } };
  const unit = { id: "U-1", values: { title: "A thing" } };
  const box = { id: "C-7", values: { containerLabel: "BIN 007", containerState: "open", containerCount: 4, containerCapacity: 5 } };
  assert.deepEqual(findPicksOf(a.finds[0] as NonNullable<typeof a.finds[0]>, { record: unit, context: { station } }), [
    { facet: "containerStation", value: "T-1" },
    { facet: "containerState", value: "open" },
  ]);
  const w = actWrites(a, { record: unit, context: { station }, found: { box: [box] }, now: "2026-11-08T10:00:00Z" });
  assert.deepEqual(w, {
    ok: true,
    record: { filedIn: { $link: "C-7" }, filedBox: "BIN 007", filedAt: "2026-11-08T10:00:00Z" },
    clear: [],
    then: [{ id: "C-7", values: { containerState: "full" } }],
    sends: [],
  });
  const roomy = { ...box, values: { ...box.values, containerCount: 1 } };
  const w2 = actWrites(a, { record: unit, context: { station }, found: { box: [roomy] }, now: "x" });
  assert.deepEqual(w2.ok && w2.then, []);
  assert.deepEqual(actWrites(a, { record: unit, context: { station }, found: {}, now: "x" }), { ok: false, why: "no container for box" });
});

// ─── Revision 26: a route, a mint, a series, thens that set several and send, replaces ───────────────────────────

const fileWhole = `act: file /2026-11-09
  utility: bench
  label: File
  on: unit
  context: station
  route:
    slot -> row of context.station.slots by slotRule over record, record.of keep keep by unit where of = record.of, filedSlot = slot.slotName, filedIn.containerStation = context.station
  find:
    box -> first container where containerStation = context.station, containerSlot = slot.slotName, containerState = open order containerLabel
  mint:
    box -> container when none
      containerLabel -> next slot.boxPrefix in container.containerLabel, slot.boxSuffix
      containerStation -> link station
      containerSlot -> slot.slotName
      containerLocation -> context.station.stationLocation
      containerCapacity -> slot.boxCapacity
      containerState -> open
  count:
    boxed -> unit where filedIn = box
  set:
    filedIn -> link box
    filedBox -> box.containerLabel
    filedSlot -> slot.slotName
    filedAt -> now
  then:
    when boxed + 1 >= box.containerCapacity set box.containerState = full, box.filledAt = now send notify containerFull about context.station
`;

const byCategory = `act: fileByCategory /2026-11-09
  utility: bench
  replaces: file
  on: unit
  context: station
  find:
    box -> first container where containerStation = context.station, containerState = open
  set:
    filedIn -> link box
`;

test("revision 26: the route, the mint, the series, the then's several sets and send, and replaces are read, checked, carried and printed back", () => {
  const [info] = readPackages(bench(fileWhole + label + byCategory));
  const a = info?.acts.find((x) => x.name === "file");
  assert.ok(a?.route);
  assert.deepEqual(a.route.rows, { context: "station", facet: "slots" });
  assert.equal(a.route.by, "slotRule");
  assert.deepEqual(a.route.over, [{ record: "" }, { record: "of" }]);
  assert.deepEqual(a.route.keep?.where.map((p) => [p.facet, p.value]), [
    ["of", { record: "of" }],
    ["filedSlot", { route: "slot", column: "slotName" }],
    ["filedIn.containerStation", { context: "station" }],
  ]);
  const box = a.finds[0];
  assert.deepEqual(box?.where[1]?.value, { route: "slot", column: "slotName" });
  assert.equal(box?.mint?.kind, "container");
  assert.deepEqual(box?.mint?.sets[0]?.source, { next: { prefix: { route: "slot", column: "boxPrefix" }, in: { kind: "container", facet: "containerLabel" }, suffix: { route: "slot", column: "boxSuffix" } } });
  assert.deepEqual(box?.mint?.sets[3]?.source, { context: "station", facet: "stationLocation" });
  assert.deepEqual(a.counts, [{ name: "boxed", kind: "unit", where: [{ facet: "filedIn", value: { found: "box" }, line: a.counts[0]?.line }], line: a.counts[0]?.line }]);
  assert.deepEqual((a.thens[0]?.when as { left?: unknown } | undefined)?.left, { count: "boxed", plus: 1 });
  assert.deepEqual(a.thens[0]?.sets, [
    { found: "box", facet: "containerState", value: { literal: "full" } },
    { found: "box", facet: "filledAt", value: { now: true } },
  ]);
  assert.deepEqual(a.thens[0]?.send, { verb: "notify", words: "containerFull about context.station" });
  const b = info?.acts.find((x) => x.name === "fileByCategory");
  assert.equal(b?.replaces, "file");
  checkPackages(bench(fileWhole + label + byCategory));
  const first = bundleOf(parsePackage(bench(fileWhole + label + byCategory)));
  const text = printBundle(first);
  assert.match(text, /^    slot -> row of context\.station\.slots by slotRule over record, record\.of keep keep by unit where of = record\.of, filedSlot = slot\.slotName, filedIn\.containerStation = context\.station$/m);
  assert.match(text, /^  mint:\n    box -> container when none\n      containerLabel -> next slot\.boxPrefix in container\.containerLabel, slot\.boxSuffix$/m);
  assert.match(text, /^  count:\n    boxed -> unit where filedIn = box$/m);
  assert.match(text, /^    when boxed \+ 1 >= box\.containerCapacity set box\.containerState = full, box\.filledAt = now send notify containerFull about context\.station$/m);
  assert.match(text, /^  replaces: file$/m);
  assert.equal(serialize(bundleOf(readBundle(first))), serialize(first));
  // A revision-25 then (one `set`) still prints.
  assert.match(printBundle(bundleOf(parsePackage(bench(file)))), /set box\.containerState = full$/m);
});

test("revision 26: the refusals: a route over no compound or by a column it lacks, a mint of an all find or of nothing, replacing itself or an act the utility lacks", () => {
  refused(fileWhole.replace("context.station.slots", "context.station.unitPrint"), /routes over unitPrint, which isn't a compound/);
  refused(fileWhole.replace("by slotRule", "by slotColour"), /routes by slotColour, a column the rows lack/);
  refused(fileWhole.replace("filedSlot -> slot.slotName", "filedSlot -> slot.slotColour"), /reads slot\.slotColour, a column the rows lack/);
  refused(fileWhole.replace("over record, record.of", "over record, record.title"), /routes over record\.title, which isn't a link/);
  refused(fileWhole.replace("box -> first container", "box -> all container"), /is of a find that takes all/);
  refused(fileWhole.replace("box -> container when none", "crate -> container when none"), /the mint crate names no find above it/);
  refused(byCategory.replace("replaces: file", "replaces: fileByCategory"), /replaces itself/);
  refused(byCategory.replace("replaces: file", "replaces: pack"), /replaces pack, which isn't among bench's acts/);
  refused(byCategory.replace("  replaces: file\n", ""), /isn't among bench's acts/);
  refused(fileWhole.replace("boxed -> unit where filedIn = box", "box -> unit where filedIn = box").replace("when boxed", "when box"), /counts box, a name already taken/);
  refused(fileWhole.replace("when boxed + 1", "when held + 1"), /reads held, which no count declares above it/);
});

test("the row a route takes: the rack in order, the rule over the unit's values laid over the product's, the last the catch-all, a kept row passed over; the counts' picks per row", () => {
  const [info] = readPackages(bench(fileWhole));
  const a = info?.acts[0];
  assert.ok(a?.route);
  const slots: JsonObject[] = [
    { slotName: "New", slotRule: 'condition is "new"', boxPrefix: "NEW", boxCapacity: 2, keep: 1 },
    { slotName: "Rest", boxPrefix: "BIN", boxSuffix: "Sealed" },
  ];
  const station: ActRecord = { id: "T-1", values: { stationLocation: { $link: "K-1" }, slots } };
  const product: ActRecord = { id: "P-1", values: { title: "A thing", condition: "used" } };
  const unitNew: ActRecord = { id: "U-1", of: "P-1", values: { condition: "new" } };
  const unitPlain: ActRecord = { id: "U-2", of: "P-1", values: {} };
  const base = { context: { station }, linked: { of: product }, now: "2026-11-09T10:00:00Z" };
  const r1 = routeOf(a.route, { ...base, record: unitNew });
  assert.deepEqual(r1.ok && [r1.index, r1.row.slotName, r1.why], [0, "New", 'row 1 took it: condition is "new"']);
  // The product says used; the unit's own word, new, wins.
  const r2 = routeOf(a.route, { ...base, record: unitPlain });
  assert.deepEqual(r2.ok && [r2.index, r2.why], [1, "nothing above claimed it: the last row"]);
  // Kept: the New row already holds one of this title.
  const r3 = routeOf(a.route, { ...base, record: unitNew }, [1, 0]);
  assert.deepEqual(r3.ok && r3.index, 1);
  assert.deepEqual(routeCountPicksOf(a.route, { ...base, record: unitNew }, slots[0] as JsonObject), [
    { facet: "of", value: "P-1" },
    { facet: "filedSlot", value: "New" },
    { facet: "filedIn.containerStation", value: "T-1" },
  ]);
  const bad: ActRecord = { ...station, values: { ...station.values, slots: [{ slotName: "Odd", slotRule: "condition izz new" }, { slotName: "Rest" }] } };
  const r4 = routeOf(a.route, { ...base, context: { station: bad }, record: unitNew });
  assert.match(!r4.ok ? r4.why : "", /the rule of row 1 can't be read/);
});

test("the values a mint makes: the series' next label, the links, the row's columns; the writes then set several, the moment among them, and send", () => {
  const [info] = readPackages(bench(fileWhole));
  const a = info?.acts[0];
  assert.ok(a);
  const station: ActRecord = { id: "T-1", values: { stationLocation: { $link: "K-1" } } };
  const row: JsonObject = { slotName: "New", slotRule: 'condition is "new"', boxPrefix: "NEW", boxSuffix: "Sealed", boxCapacity: 2 };
  const unit: ActRecord = { id: "U-1", of: "P-1", values: {} };
  const i = { record: unit, context: { station }, route: { index: 0, row }, found: {}, labels: { "container.containerLabel": ["NEW 001", "NEW 007 Sealed", "BIN 002"] }, now: "2026-11-09T10:00:00Z" };
  const box = a.finds[0] as NonNullable<(typeof a.finds)[0]>;
  assert.deepEqual(findPicksOf(box, i), [
    { facet: "containerStation", value: "T-1" },
    { facet: "containerSlot", value: "New" },
    { facet: "containerState", value: "open" },
  ]);
  assert.deepEqual(mintValuesOf(box, i), {
    ok: true,
    kind: "container",
    values: { containerLabel: "NEW 008 Sealed", containerStation: { $link: "T-1" }, containerSlot: "New", containerLocation: { $link: "K-1" }, containerCapacity: 2, containerState: "open" },
  });
  assert.equal(nextInSeries("BIN", undefined, []), "BIN 001");
  assert.equal(nextInSeries("BIN", "Sealed", ["BIN 012", "BIN 3 x"]), "BIN 013 Sealed");
  const made = { id: "C-9", values: { containerLabel: "NEW 008 Sealed", containerCapacity: 2 } };
  assert.deepEqual(findPicksOf(a.counts[0] as NonNullable<(typeof a.counts)[0]>, { ...i, found: { box: [made] } }), [{ facet: "filedIn", value: "C-9" }]);
  const w = actWrites(a, { ...i, found: { box: [made] }, counts: { boxed: 1 } });
  assert.deepEqual(w, {
    ok: true,
    record: { filedIn: { $link: "C-9" }, filedBox: "NEW 008 Sealed", filedSlot: "New", filedAt: "2026-11-09T10:00:00Z" },
    clear: [],
    then: [{ id: "C-9", values: { containerState: "full", filledAt: "2026-11-09T10:00:00Z" } }],
    sends: [{ verb: "notify", words: "containerFull about context.station" }],
  });
  const w2 = actWrites(a, { ...i, found: { box: [made] }, counts: { boxed: 0 } });
  assert.deepEqual(w2.ok && [w2.then, w2.sends], [[], []]);
  // A count the host never answered leaves the then unread, as a missing facet does.
  const w3 = actWrites(a, { ...i, found: { box: [made] } });
  assert.deepEqual(w3.ok && w3.then, []);
  // Nothing found and nothing minted stops the act.
  assert.deepEqual(actWrites(a, { ...i, found: {} }), { ok: false, why: "no container for box" });
});

// ─── Revision 29: the caller as a link, a facet cleared ───────────────────────────────────────────────────────────

const arrive = `act: arrive /2026-11-10
  utility: bench
  on: station
  set:
    stationOperator -> link caller
act: leave /2026-11-10
  utility: bench
  on: station
  set:
    stationOperator -> none
`;

test("revision 29: a set links the caller or clears the facet; carried, printed back, and written as the caller's link or nothing", () => {
  const src = bench(file + label + arrive).replace("acts: file, label", "acts: file, label, arrive, leave").replace("stationLocation&location\n", "stationLocation&location\nstationOperator&person\n").replace("    stationLocation\n", "    stationLocation\n    stationOperator\n");
  const [info] = readPackages(src);
  const a = info?.acts.find((x) => x.name === "arrive");
  const l = info?.acts.find((x) => x.name === "leave");
  assert.deepEqual(a?.sets[0]?.source, { caller: true });
  assert.deepEqual(l?.sets[0]?.source, { none: true });
  checkPackages(src);
  const text = printBundle(bundleOf(parsePackage(src)));
  assert.match(text, /^    stationOperator -> link caller$/m);
  assert.match(text, /^    stationOperator -> none$/m);
  const station = { id: "T-1", values: {} };
  const came = actWrites(a as NonNullable<typeof a>, { record: station, context: {}, found: {}, now: "x", caller: "person:P-3" });
  assert.deepEqual(came.ok && came.record, { stationOperator: { $link: "person:P-3" } });
  const nobody = actWrites(a as NonNullable<typeof a>, { record: station, context: {}, found: {}, now: "x" });
  assert.deepEqual(nobody, { ok: false, why: "no caller to link stationOperator to" });
  const left = actWrites(l as NonNullable<typeof l>, { record: station, context: {}, found: {}, now: "x" });
  assert.deepEqual(left.ok && [left.record, left.clear], [{}, ["stationOperator"]]);
});

// ─── Revision 39: a pick by the record in hand; a then with no condition, a link, a copy, a clear ─────────────────────

const reach = `act: empty /2026-11-15
  utility: bench
  on: container
  context: station
  find:
    inside -> all unit where filedIn = record
    parts -> all unit where of = record
  count:
    held -> unit where filedIn = record
  set:
    containerState -> open
  then:
    set inside.filedIn = none, inside.filedBox = record.containerLabel, inside.filedSlot = context.station.printer
    when held > 1 set inside.filedAt = now
act: gather /2026-11-15
  utility: bench
  on: container
  find:
    loose -> all unit where filedBox = "record"
  then:
    set loose.filedIn = link record, loose.filedBox = none
`;

test("revision 39: a pick names the record in hand; a then stands with no condition and writes a link, a copy or a clear; read, checked, carried, printed and answered", () => {
  const src = bench(file + label + reach).replace("acts: file, label", "acts: file, label, empty, gather");
  const [info] = readPackages(src);
  const e = info?.acts.find((x) => x.name === "empty") as NonNullable<ReturnType<typeof readPackages>[number]["acts"][number]>;
  const g = info?.acts.find((x) => x.name === "gather") as typeof e;
  assert.deepEqual(e.finds[0]?.where[0]?.value, { self: true });
  assert.deepEqual(e.finds[1]?.where[0]?.facet, "of");
  assert.deepEqual(e.counts[0]?.where[0]?.value, { self: true });
  assert.equal(e.thens[0]?.when, undefined);
  assert.deepEqual(e.thens[0]?.sets.map((x) => x.value), [{ none: true }, { record: "containerLabel" }, { context: "station", facet: "printer" }]);
  assert.deepEqual(g.finds[0]?.where[0]?.value, { literal: "record" }, "the word itself, quoted, is a literal");
  assert.deepEqual(g.thens[0]?.sets.map((x) => x.value), [{ link: "record" }, { none: true }]);
  checkPackages(src);
  const bundle = bundleOf(parsePackage(src));
  const text = printBundle(bundle);
  assert.match(text, /^    inside -> all unit where filedIn = record$/m);
  assert.match(text, /^    set inside\.filedIn = none, inside\.filedBox = record\.containerLabel, inside\.filedSlot = context\.station\.printer$/m);
  assert.match(text, /^    when held > 1 set inside\.filedAt = now$/m);
  assert.match(text, /^    set loose\.filedIn = link record, loose\.filedBox = none$/m);
  assert.match(text, /^    loose -> all unit where filedBox = "record"$/m);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
  const box = { id: "C-1", values: { containerLabel: "BIN 001" } };
  const station = { id: "T-1", values: { printer: "zebra" } };
  assert.deepEqual(findPicksOf(e.finds[0] as NonNullable<(typeof e.finds)[number]>, { record: box, context: { station } }), [{ facet: "filedIn", value: "C-1" }]);
  assert.deepEqual(findPicksOf(e.finds[1] as NonNullable<(typeof e.finds)[number]>, { record: box, context: { station } }), [{ facet: "of", value: "C-1" }]);
  const units = [{ id: "U-1", values: { filedIn: { $link: "C-1" } } }, { id: "U-2", values: { filedIn: { $link: "C-1" } } }];
  const w = actWrites(e, { record: box, context: { station }, found: { inside: units, parts: [] }, counts: { held: 2 }, now: "N" });
  assert.deepEqual(w.ok && w.record, { containerState: "open" });
  assert.deepEqual(w.ok && w.then, [
    { id: "U-1", values: { filedBox: "BIN 001", filedSlot: "zebra", filedAt: "N" }, clear: ["filedIn"] },
    { id: "U-2", values: { filedBox: "BIN 001", filedSlot: "zebra", filedAt: "N" }, clear: ["filedIn"] },
  ]);
  const one = actWrites(e, { record: box, context: { station }, found: { inside: [units[0] as (typeof units)[number]], parts: [] }, counts: { held: 1 }, now: "N" });
  assert.deepEqual(one.ok && one.then, [{ id: "U-1", values: { filedBox: "BIN 001", filedSlot: "zebra" }, clear: ["filedIn"] }], "the conditional then did not hold; the plain one always writes");
  const got = actWrites(g, { record: box, context: {}, found: { loose: [{ id: "U-9", values: { filedBox: "record" } }] }, now: "N" });
  assert.deepEqual(got.ok && got.then, [{ id: "U-9", values: { filedIn: { $link: "C-1" } }, clear: ["filedBox"] }]);
  // Refused: a then's link or reference to what the act never declared.
  assert.throws(() => checkPackages(src.replace("loose.filedIn = link record", "loose.filedIn = link nobody")), /then links loose\.filedIn to nobody, which no find or context declares/);
  assert.throws(() => checkPackages(src.replace("inside.filedBox = record.containerLabel", "inside.filedBox = record.nothing")), /nothing/);
});

const closed = `act: start /2026-11-15
  utility: bench
  on: container
  needs:
    no filledAt "a count is already open on this box"
    containerLabel
  find:
    inside -> all unit where filedIn = record
  set:
    filledAt -> now
  then:
    set inside.filedSlot = expected
    when inside.condition <= 0 set inside.filedSlot = none send notify emptyUnit about record
`;

test("revision 42: an act needs what the record in hand holds or lacks, refused with its words before any write; a then's condition that reads a record it writes on is read on each", () => {
  const src = bench(file + label + closed).replace("acts: file, label", "acts: file, label, start");
  const [info] = readPackages(src);
  const a = info?.acts.find((x) => x.name === "start") as NonNullable<ReturnType<typeof readPackages>[number]["acts"][number]>;
  assert.deepEqual(a.needs?.map((n) => [n.facet, !!n.lacks, n.words]), [["filledAt", true, "a count is already open on this box"], ["containerLabel", false, undefined]]);
  checkPackages(src);
  const bundle = bundleOf(parsePackage(src));
  const text = printBundle(bundle);
  assert.match(text, /^  needs:\n    no filledAt "a count is already open on this box"\n    containerLabel$/m);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
  const units: { id: string; values: { [k: string]: string } }[] = [
    { id: "U-1", values: { condition: "2" } },
    { id: "U-2", values: { condition: "0" } },
    { id: "U-3", values: {} },
  ];
  const input = (values: { [k: string]: string }, inside = units) => ({ record: { id: "C-1", values }, context: {}, found: { inside }, now: "N" });
  const w = actWrites(a, input({ containerLabel: "BIN 001" }));
  assert.deepEqual(w.ok && w.record, { filledAt: "N" });
  assert.deepEqual(w.ok && w.then, [
    { id: "U-1", values: { filedSlot: "expected" } },
    { id: "U-2", values: {}, clear: ["filedSlot"] },
    { id: "U-3", values: { filedSlot: "expected" } },
  ], "read on each: only the unit with none is cleared; one with no value for the term is left as the plain then wrote it");
  assert.deepEqual(w.ok && w.sends, [{ verb: "notify", words: "emptyUnit about record" }], "the send goes once, since it held on one");
  const none = actWrites(a, input({ containerLabel: "BIN 001" }, [units[0] as (typeof units)[number]]));
  assert.deepEqual(none.ok && none.sends, [], "held on none: no send");
  assert.deepEqual(actWrites(a, input({ containerLabel: "BIN 001", filledAt: "M" })), { ok: false, why: "a count is already open on this box" });
  assert.deepEqual(actWrites(a, input({})), { ok: false, why: "containerLabel is not set" });
  // One hop: a need of the record the record in hand links to, as the host handed it.
  const hop = readPackages(src.replace("    containerLabel\n  find:", "    containerStation.printer \"this box's station has no printer\"\n  find:"))[0]?.acts.find((x) => x.name === "start") as typeof a;
  const at = (linked: { [k: string]: { id: string; values: { [k: string]: string } } }) => actWrites(hop, { ...input({}), linked });
  assert.equal(at({ containerStation: { id: "T-1", values: { printer: "zebra" } } }).ok, true);
  assert.deepEqual(at({ containerStation: { id: "T-1", values: {} } }), { ok: false, why: "this box's station has no printer" });
  assert.deepEqual(at({}), { ok: false, why: "this box's station has no printer" }, "linked to nothing: it holds nothing");
  // Refused: a need of a facet nothing declares; a need that is no facet's name.
  assert.throws(() => checkPackages(src.replace("    containerLabel\n  find:", "    nothingHere\n  find:")), /needs nothingHere, which isn't a facet/);
  assert.throws(() => readPackages(src.replace("    containerLabel\n  find:", "    containerLabel is set\n  find:")), /a need is "<facet>" or "no <facet>"/);
});

const given = `act: reprice /2026-11-15
  utility: bench
  label: Reprice
  on: container
  given:
    count as containerCapacity "How many does it hold?" from record.containerCapacity
    word as containerState default open
  find:
    inside -> all unit where filedIn = record
  set:
    containerCapacity -> given.count
    containerState -> given.word
  then:
    when given.count > 2 set inside.filedSlot = given.word
`;

test("revision 44: an act says what it is given, each typed by a facet; the question opens from the record, a default stands in unasked; what is given is read by a set, a then and a when; nothing lands while one is still to ask", () => {
  const src = bench(file + label + given).replace("acts: file, label", "acts: file, label, reprice");
  const [info] = readPackages(src);
  const a = info?.acts.find((x) => x.name === "reprice") as NonNullable<ReturnType<typeof readPackages>[number]["acts"][number]>;
  assert.deepEqual(a.given?.map((g) => [g.name, g.facet, g.words, g.default]), [["count", "containerCapacity", "How many does it hold?", undefined], ["word", "containerState", undefined, "open"]]);
  checkPackages(src);
  const bundle = bundleOf(parsePackage(src));
  const text = printBundle(bundle);
  assert.match(text, /^  given:\n    count as containerCapacity "How many does it hold\?" from record\.containerCapacity\n    word as containerState default open$/m);
  assert.match(text, /^    containerCapacity -> given\.count$/m);
  assert.match(text, /^    when given\.count > 2 set inside\.filedSlot = given\.word$/m);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
  const box = { id: "C-1", values: { containerCapacity: "6" } };
  const at = { record: box, context: {} };
  // Nothing said: the count is still to ask and opens on the record's; the word takes its default.
  assert.deepEqual(givenOf(a, {}, at), { values: { word: "open" }, asks: ["count"], opens: { count: "6", word: "open" }, refused: [] });
  assert.deepEqual(givenOf(a, { count: "4", word: "full" }, at), { values: { count: "4", word: "full" }, asks: [], opens: { count: "4", word: "full" }, refused: [] });
  // With the facets at hand, a value its facet refuses is refused with its words, and nothing lands.
  const dict = readDefinitions(src);
  const facetOf = (k: string) => dict.facets.get(k);
  assert.deepEqual(givenOf(a, { count: "many" }, at, facetOf).refused, [{ name: "count", why: "count is a number" }]);
  assert.deepEqual(givenOf(a, { count: "4", word: "ajar" }, at, facetOf).refused, [{ name: "word", why: "word is one of open, full" }]);
  assert.deepEqual(givenOf(a, { count: "4", word: "full" }, at, facetOf).refused, []);
  assert.deepEqual(actWrites(a, { ...at, found: { inside: [] }, now: "N", given: { count: "many" }, facetOf }), { ok: false, why: "count is a number" });
  const units = [{ id: "U-1", values: {} }];
  const input = (told?: { [k: string]: string }) => ({ ...at, found: { inside: units }, now: "N", ...(told ? { given: told } : {}) });
  assert.deepEqual(actWrites(a, input()), { ok: false, why: "count is not given" });
  const w = actWrites(a, input({ count: "4" }));
  assert.deepEqual(w.ok && w.record, { containerCapacity: "4", containerState: "open" }, "the default stood in for the word");
  assert.deepEqual(w.ok && w.then, [{ id: "U-1", values: { filedSlot: "open" } }]);
  const few = actWrites(a, input({ count: "2", word: "full" }));
  assert.deepEqual(few.ok && few.record, { containerCapacity: "2", containerState: "full" });
  assert.deepEqual(few.ok && few.then, [], "the when read what was given, and did not hold");
  // Refused: a given read that was never declared, a facet nothing declares, one name twice, a find named given,
  // a given that opens from what is not yet found, and a line that is no given.
  assert.throws(() => checkPackages(src.replace("containerCapacity -> given.count", "containerCapacity -> given.nothing")), /reads given\.nothing, which its given lacks/);
  assert.throws(() => checkPackages(src.replace("count as containerCapacity", "count as nothingHere")), /is given count as nothingHere, which isn't a facet/);
  assert.throws(() => readPackages(src.replace("    word as containerState default open", "    count as containerState")), /is given count twice/);
  assert.throws(() => checkPackages(src.replace(/inside/g, "given").replace("set given.filedSlot = given.word", "set given.filedSlot = open")), /finds given, the word for what an act is given/);
  assert.throws(() => checkPackages(src.replace("from record.containerCapacity", "from inside.filedSlot")), /opens from inside\.filedSlot/);
  assert.throws(() => readPackages(src.replace("count as containerCapacity", "count is capacity")), /a given is "<name> as <facet>"/);
});

// ─── Revision 31: a kind's follow aspects, an act's tells, the post it lands when followed ───────────────────────────

const computes = `act: recount /2026-11-16
  utility: bench
  label: Count
  on: container
  given:
    count as containerCapacity "How many are there?" from record.containerCapacity
  make:
    moved -> unit when given.count != record.containerCapacity and record.containerCapacity > 0
      filedIn -> link record
      filedSlot -> given.count - record.containerCapacity
      filedBox -> counted
    again -> unit when record.containerCapacity <= 0 and given.count > 0
      filedIn -> link record
      filedSlot -> given.count
      filedBox -> "made again"
  set:
    containerCapacity -> given.count
  then:
    when given.count != record.containerCapacity set record.containerSlot = record.containerSlot + 1
`;

test("revision 45: a set or a then adds or takes one number from another; a when says `!=` and joins comparisons with `and`; a then writes on the record in hand; an act makes records when it lands, each under its own when; read, checked, carried, printed back; refused where a name is taken or a facet unknown", () => {
  const src = bench(file + label + computes).replace("acts: file, label", "acts: file, label, recount");
  const [info] = readPackages(src);
  const a = info?.acts.find((x) => x.name === "recount") as NonNullable<ReturnType<typeof readPackages>[number]["acts"][number]>;
  assert.deepEqual(a.makes?.map((m) => [m.name, m.kind, (m.when as { op?: string } | undefined)?.op, m.when?.and?.length, m.sets.length]), [["moved", "unit", "!=", 1, 3], ["again", "unit", "<=", 1, 3]]);
  assert.deepEqual(a.makes?.[0]?.sets[1]?.source, { sum: { left: { given: "count" }, op: "-", right: { record: "containerCapacity" } } });
  assert.deepEqual(a.thens[0]?.sets[0], { found: "record", facet: "containerSlot", value: { sum: { left: { record: "containerSlot" }, op: "+", right: { number: 1 } } } });
  checkPackages(src);
  const bundle = bundleOf(parsePackage(src));
  const text = printBundle(bundle);
  assert.match(text, /^  make:\n    moved -> unit when given\.count != record\.containerCapacity and record\.containerCapacity > 0\n      filedIn -> link record\n      filedSlot -> given\.count - record\.containerCapacity\n      filedBox -> counted$/m);
  assert.match(text, /^    when given\.count != record\.containerCapacity set record\.containerSlot = record\.containerSlot \+ 1$/m);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
  const at = (capacity: string | undefined, slot?: string) => ({ record: { id: "C-1", values: { ...(capacity === undefined ? {} : { containerCapacity: capacity }), ...(slot ? { containerSlot: slot } : {}) } } as ActRecord, context: {}, found: {}, now: "N" });
  // Three expected, two counted: one made, the difference signed, read as the record stood; the counter raised from nothing.
  assert.deepEqual(actWrites(a, { ...at("3"), given: { count: "2" } }), {
    ok: true,
    record: { containerCapacity: "2", containerSlot: "1" },
    clear: [],
    then: [],
    makes: [{ name: "moved", kind: "unit", values: { filedIn: { $link: "C-1" }, filedSlot: "-1", filedBox: "counted" } }],
    sends: [],
  });
  // The same count: the quantity is written as it was, nothing is made and the counter stands.
  const same = actWrites(a, { ...at("3", "4"), given: { count: "3" } });
  assert.deepEqual(same.ok && [same.record, same.makes], [{ containerCapacity: "3" }, []]);
  // None on hand and some found: the other make, and the counter one more than it held.
  const again = actWrites(a, { ...at("0", "4"), given: { count: "5" } });
  assert.deepEqual(again.ok && [again.record, again.makes], [{ containerCapacity: "5", containerSlot: "5" }, [{ name: "again", kind: "unit", values: { filedIn: { $link: "C-1" }, filedSlot: "5", filedBox: "made again" } }]]);
  // A term of a when that reads no number holds nowhere: nothing made where the record holds no count.
  const bareBox = actWrites(a, { ...at(undefined), given: { count: "5" } });
  assert.deepEqual(bareBox.ok && bareBox.makes, []);
  // A sum over what is no number refuses the act before any write.
  assert.deepEqual(actWrites(a, { ...at("3", "A"), given: { count: "2" } }), { ok: false, why: "record.containerSlot holds no number to add" });
  // Revision 46: `caller` writes the person running the act as words, in a set, a make and a then; quoted, it is the word.
  const whoSrc = bench(file + label + computes.replace("filedBox -> counted", "filedBox -> caller").replace('filedBox -> "made again"', 'filedBox -> "caller"').replace("set record.containerSlot = record.containerSlot + 1", "set record.containerLabel = caller")).replace("acts: file, label", "acts: file, label, recount");
  const who = readPackages(whoSrc)[0]?.acts.find((x) => x.name === "recount") as typeof a;
  assert.deepEqual([who.makes?.[0]?.sets[2]?.source, who.makes?.[1]?.sets[2]?.source, who.thens[0]?.sets[0]?.value], [{ person: true }, { literal: "caller" }, { person: true }]);
  const whoText = printBundle(bundleOf(parsePackage(whoSrc)));
  assert.match(whoText, /^      filedBox -> caller$/m);
  assert.match(whoText, /^      filedBox -> "caller"$/m);
  assert.match(whoText, /set record\.containerLabel = caller$/m);
  assert.equal(serialize(bundleOf(parsePackage(whoText))), serialize(bundleOf(parsePackage(whoSrc))));
  const byPat = actWrites(who, { ...at("3"), given: { count: "2" }, caller: "P-pat" });
  assert.deepEqual(byPat.ok && [byPat.record.containerLabel, byPat.makes?.[0]?.values.filedBox], ["P-pat", "P-pat"]);
  assert.deepEqual(actWrites(who, { ...at("3"), given: { count: "2" } }), { ok: false, why: "no caller to set record.containerLabel to" });
  // A literal that reads like a sum is written quoted and stays words.
  const lit = readPackages(bench(file + label + computes.replace("filedBox -> counted", 'filedBox -> "record.x - 1"')).replace("acts: file, label", "acts: file, label, recount"))[0]?.acts.find((x) => x.name === "recount");
  assert.deepEqual(lit?.makes?.[0]?.sets[2]?.source, { literal: "record.x - 1" });
  const no = (from: string, to: string, why: RegExp) => assert.throws(() => checkPackages(bench(file + label + computes.replace(from, to)).replace("acts: file, label", "acts: file, label, recount")), (e: unknown) => e instanceof CrubalError && why.test(e.message), String(why));
  no("again -> unit", "moved -> unit", /makes moved, a name already taken/);
  no("moved -> unit when", "moved -> gizmo when", /makes gizmo, which isn't a kind/);
  no("filedSlot -> given.count - record.containerCapacity", "filedSlot -> given.count - record.nope", /reads nope, which isn't a facet/);
  no("filedSlot -> given.count\n", "filedSlot -> given.other\n", /reads given\.other, which its given lacks/);
  no("set record.containerSlot = record.containerSlot + 1", "set record.nope = 1", /then sets nope, which isn't a facet/);
  no('      filedBox -> "made again"\n', '      filedBox -> "made again"\n      filedBox -> twice\n', /make again sets filedBox twice/);
});

const stands = `act: recount /2026-11-18
  utility: bench
  label: Count
  on: container
  given:
    count as containerCapacity "How many are there?" from record.containerCapacity
  find:
    inside -> all unit where filedIn = record
  set:
    containerCapacity -> given.count
  then:
    when given.count > 0 restore record
    when given.count <= 0 archive record as emptied
    when no inside.filedSlot archive inside
    when has inside.filedSlot and given.count > 0 set inside.filedBox = kept
  also:
    label on record when has record.containerSlot and given.count > 0
    bench/file on inside when no inside.filedSlot
`;

test("revision 47: a then archives or restores the record in hand or the records found; a when says `has` and `no`; an act says the acts run also when it has landed; read, checked, carried, printed back; refused where a name is undeclared, an act is not its utility's, or an act runs itself", () => {
  const src = bench(file + label + stands).replace("acts: file, label", "acts: file, label, recount");
  const [info] = readPackages(src);
  const a = info?.acts.find((x) => x.name === "recount") as NonNullable<ReturnType<typeof readPackages>[number]["acts"][number]>;
  assert.deepEqual(a.thens.map((t) => t.stand), [{ to: "active", on: "record" }, { to: "archived", on: "record", reason: "emptied" }, { to: "archived", on: "inside" }, undefined]);
  assert.deepEqual(a.thens[2]?.when, { has: { found: "inside", facet: "filedSlot" }, lacks: true });
  assert.deepEqual(a.also?.map((x) => [x.utility, x.act, x.on, !!x.when]), [[undefined, "label", "record", true], ["bench", "file", "inside", true]]);
  checkPackages(src);
  const bundle = bundleOf(parsePackage(src));
  const text = printBundle(bundle);
  assert.match(text, /^    when given\.count > 0 restore record\n    when given\.count <= 0 archive record as emptied\n    when no inside\.filedSlot archive inside\n    when has inside\.filedSlot and given\.count > 0 set inside\.filedBox = kept$/m);
  assert.match(text, /^  also:\n    label on record when has record\.containerSlot and given\.count > 0\n    bench\/file on inside when no inside\.filedSlot$/m);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
  const box = (slot?: string): ActRecord => ({ id: "C-1", values: { containerCapacity: "3", ...(slot ? { containerSlot: slot } : {}) } });
  const inside: ActRecord[] = [{ id: "U-1", values: { filedSlot: "New" } }, { id: "U-2", values: {} }];
  // Some there: the box stands again; a condition on what is found is read on each; the also runs where it holds.
  const some = actWrites(a, { record: box("New"), context: {}, found: { inside }, now: "N", given: { count: "2" } });
  assert.deepEqual(some.ok && [some.stands, some.then, some.also], [
    [{ id: "C-1", to: "active" }, { id: "U-2", to: "archived" }],
    [{ id: "U-1", values: { filedBox: "kept" } }],
    [{ act: "label", id: "C-1" }, { utility: "bench", act: "file", id: "U-2" }],
  ]);
  // None there: the box is archived with its reason; the record's own also needs a count.
  const none = actWrites(a, { record: box(), context: {}, found: { inside: [] }, now: "N", given: { count: "0" } });
  assert.deepEqual(none.ok && [none.stands, none.also], [[{ id: "C-1", to: "archived", reason: "emptied" }], []]);
  // An act with no standing line and no also answers neither.
  const plain = readPackages(bench(file + label))[0]?.acts.find((x) => x.name === "label");
  const pw = plain && actWrites(plain, { record: box(), context: { station: { id: "S-1", values: {} } }, found: {}, now: "N" });
  assert.ok(pw?.ok && !("stands" in pw) && !("also" in pw));
  const no = (from: string, to: string, why: RegExp) => assert.throws(() => checkPackages(bench(file + label + stands.replace(from, to)).replace("acts: file, label", "acts: file, label, recount")), (e: unknown) => e instanceof CrubalError && why.test(e.message), String(why));
  no("archive inside", "archive nobody", /then archives nobody, which no find declares/);
  no("label on record", "label on nobody", /also runs label on nobody, which no find declares/);
  no("label on record", "polish on record", /also runs polish, which isn't among bench's acts/);
  no("label on record", "recount on record", /also runs itself on the record in hand/);
  no("when no inside.filedSlot archive inside", "when no inside.nope archive inside", /reads nope, which isn't a facet/);
});

const linking = `act: recount /2026-11-19
  utility: bench
  label: Count
  on: container
  given:
    count as containerCapacity
  find:
    inside -> all unit where filedIn = record
  make:
    note -> unit when given.count > 0
      filedBox -> made
      filedIn -> link record
    echo -> unit when given.count > 1
      filedIn -> link note
  set:
    containerStation -> link note
  then:
    set inside.filedIn = link echo
`;

test("revision 48: a link names a record the act makes, carried as $made for the host to resolve, and writes nothing where it was not made; sums and whens read money and quantities, keeping what they are of and refusing a mix", () => {
  const src = bench(file + label + linking).replace("acts: file, label", "acts: file, label, recount");
  checkPackages(src);
  const a = readPackages(src)[0]?.acts.find((x) => x.name === "recount") as NonNullable<ReturnType<typeof readPackages>[number]["acts"][number]>;
  const at = { record: { id: "C-1", values: {} } as ActRecord, context: {}, found: { inside: [{ id: "U-1", values: {} }] }, now: "N" };
  const two = actWrites(a, { ...at, given: { count: "2" } });
  assert.deepEqual(two.ok && [two.record, two.then, two.makes], [
    { containerStation: { $made: "note" } },
    [{ id: "U-1", values: { filedIn: { $made: "echo" } } }],
    [{ name: "note", kind: "unit", values: { filedBox: "made", filedIn: { $link: "C-1" } } }, { name: "echo", kind: "unit", values: { filedIn: { $made: "note" } } }],
  ]);
  // The second was not made: what linked to it writes nothing; the first still stands.
  const one = actWrites(a, { ...at, given: { count: "1" } });
  assert.deepEqual(one.ok && [one.record, one.then, one.makes?.map((m) => m.name)], [{ containerStation: { $made: "note" } }, [{ id: "U-1", values: {} }], ["note"]]);
  const none = actWrites(a, { ...at, given: { count: "0" } });
  assert.deepEqual(none.ok && [none.record, none.makes], [{}, []]);
  assert.throws(() => checkPackages(src.replace("containerStation -> link note", "containerStation -> link nobody")), (e: unknown) => e instanceof CrubalError && /links containerStation to nobody/.test(e.message));
  // Money and quantities.
  const priced = `act: recount /2026-11-19
  utility: bench
  on: container
  given:
    price as containerLabel
  set:
    containerLabel -> given.price - record.containerLabel
  then:
    when given.price != record.containerLabel set record.containerSlot = record.containerLabel + 1
    when given.price > record.containerCapacity set record.containerState = full
`;
  const p = readPackages(bench(file + label + priced).replace("acts: file, label", "acts: file, label, recount"))[0]?.acts.find((x) => x.name === "recount") as typeof a;
  const usd = (n: string) => ({ $money: n, currency: "USD" });
  const m = actWrites(p, { record: { id: "C-1", values: { containerLabel: usd("12.50"), containerCapacity: usd("10.00") } }, context: {}, found: {}, now: "N", given: { price: usd("15.00") } });
  assert.deepEqual(m.ok && m.record, { containerLabel: usd("2.50"), containerSlot: usd("13.50"), containerState: "full" });
  // The same price: the when over money does not hold. Another currency holds nowhere and is not summed.
  const same = actWrites(p, { record: { id: "C-1", values: { containerLabel: usd("15.00") } }, context: {}, found: {}, now: "N", given: { price: usd("15.00") } });
  assert.deepEqual(same.ok && same.record, { containerLabel: usd("0.00") });
  assert.deepEqual(actWrites(p, { record: { id: "C-1", values: { containerLabel: { $money: "12.50", currency: "EUR" } } }, context: {}, found: {}, now: "N", given: { price: usd("15.00") } }), { ok: false, why: "given.price and record.containerLabel are not of one currency or unit" });
  const q = actWrites(p, { record: { id: "C-1", values: { containerLabel: { $qty: "2", unit: "kg" } } }, context: {}, found: {}, now: "N", given: { price: "5" } });
  assert.deepEqual(q.ok && q.record.containerLabel, { $qty: "3", unit: "kg" });
});

const feed = (tail: string) => `package: feed /2026-11-12
  owner: shop.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
  follow:
    product: units, details, posts
    unit: filed, price, posts
kind: station
  levels: station
  base: Station
kind: post
  levels: post
  base: Post
title$
filedAt@
sender$
postAbout&item
actRun$
postedAt@
visibility{public|followers|private}

class: Item
  for: item
  facets:
    !title
    filedAt
class: Station
  for: station
  facets:
    title
class: Post
  for: post
  facets:
    sender
    postAbout
    actRun
    postedAt
    visibility

utility: bench /2026-11-12
  label: Bench
  serves: owner
  acts: file
  mark: box amber

${tail}`;

const told = `act: file /2026-11-12
  utility: bench
  label: File
  on: unit
  context: station
  set:
    filedAt -> now
  tells: post as filed
    sender -> owner
    postAbout -> link record
    actRun -> run
    postedAt -> now
    visibility -> public
`;

test("revision 31: a kind declares the aspects a follower may choose per level, the first the default; refused off its levels, empty or twice", () => {
  const [info] = readPackages(feed(told));
  assert.deepEqual(info?.dict.kinds.get("item")?.follow, { product: ["units", "details", "posts"], unit: ["filed", "price", "posts"] });
  assert.equal(info?.dict.kinds.get("post")?.follow, undefined);
  const b = bundleOf(parsePackage(feed(told)));
  const item = (b.kinds as JsonObject[]).find((k) => k.kind === "item");
  assert.deepEqual(item?.follow, { product: ["units", "details", "posts"], unit: ["filed", "price", "posts"] });
  assert.match(printBundle(b), /^  follow:\n    product: units, details, posts\n    unit: filed, price, posts$/m);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
  assert.throws(() => readPackages(feed(told).replace("    unit: filed, price, posts", "    parcel: filed")), /follow names parcel, which isn't a level of item/);
  assert.throws(() => readPackages(feed(told).replace("    unit: filed, price, posts", "    unit:")), /follow at unit names no aspect/);
  assert.throws(() => readPackages(feed(told).replace("    unit: filed, price, posts", "    unit: filed, filed")), /names an aspect twice/);
  assert.throws(() => readPackages(feed(told).replace("    unit: filed, price, posts", "    unit: Filed")), /an aspect is a lower-case word/);
});

test("revision 31: an act tells a post as an aspect, with the owner, the run and a link to the record among its sources; it round-trips; refused on an unknown kind, an undeclared aspect, no set lines or a facet set twice", () => {
  const [info] = readPackages(feed(told));
  const a = info?.acts.find((x) => x.name === "file");
  assert.equal(a?.tells?.kind, "post");
  assert.equal(a?.tells?.aspect, "filed");
  assert.deepEqual(a?.tells?.sets.map((s) => s.source), [{ owner: true }, { link: "record" }, { run: true }, { now: true }, { literal: "public" }]);
  checkPackages(feed(told));
  const b = bundleOf(parsePackage(feed(told)));
  const text = printBundle(b);
  assert.match(text, /^  tells: post as filed$/m);
  assert.match(text, /^    sender -> owner$/m);
  assert.match(text, /^    postAbout -> link record$/m);
  assert.match(text, /^    actRun -> run$/m);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
  const refusedFeed = (tail: string, why: RegExp) => assert.throws(() => checkPackages(feed(tail)), (e: unknown) => e instanceof CrubalError && why.test(e.message));
  refusedFeed(told.replace("tells: post as filed", "tells: notice as filed"), /tells notice, which isn't a kind/);
  refusedFeed(told.replace("tells: post as filed", "tells: post as boxed"), /tells post as boxed, an aspect no kind declares under follow/);
  refusedFeed(told.replace("    postedAt -> now\n", "    postedAt -> now\n    sender -> owner\n"), /tells post and sets sender twice/);
  refusedFeed(told.replace("    visibility -> public\n", "    weight -> public\n"), /tells with weight, which isn't a facet/);
  assert.throws(() => readPackages(feed(told.replace(/  tells: post as filed\n(    .*\n)+/, "  tells: post as filed\n"))), /tells post and sets nothing/);
  assert.throws(() => readPackages(feed(told.replace("tells: post as filed", "tells: post"))), /tells is "<kind> as <aspect>"/);
});

test("revision 31: the post a landing tells, given the owner and the run; nothing without them; the followers on a record or its ancestors, live ones only", () => {
  const [info] = readPackages(feed(told));
  const a = info?.acts[0];
  assert.ok(a);
  const unit: ActRecord = { id: "U-1", values: { title: "A thing" }, of: "P-1" };
  const station = { id: "T-1", values: {} };
  const at = { record: unit, context: { station }, found: {}, now: "2026-11-12T10:00:00Z" };
  assert.deepEqual(tellsValuesOf(a, { ...at, owner: "shop.example", run: "R-9" }), {
    ok: true,
    kind: "post",
    aspect: "filed",
    values: { sender: "shop.example", postAbout: { $link: "U-1" }, actRun: "R-9", postedAt: "2026-11-12T10:00:00Z", visibility: "public" },
  });
  assert.deepEqual(tellsValuesOf(a, { ...at, run: "R-9" }), { ok: false, why: "no owner to set sender to" });
  assert.deepEqual(tellsValuesOf(a, { ...at, owner: "shop.example" }), { ok: false, why: "no act run to set actRun to" });
  // The landing's own writes stand apart from the post: the set lines alone.
  const w = actWrites(a, at);
  assert.deepEqual(w.ok && w.record, { filedAt: "2026-11-12T10:00:00Z" });
  const edge = (on: string, until?: string, relation = "follower") => ({ edge: `E-${on}`, who: "person:P-2", relation, mode: "none" as const, on, grants: [], by: "owner", ...(until ? { until } : {}) });
  const edges = [edge("P-1"), edge("U-7"), edge("U-1", "2026-11-01T00:00:00Z"), edge("P-1", undefined, "subscriber")];
  assert.deepEqual(followersOn(edges, ["U-1", "P-1"], "2026-11-12T10:00:00Z").map((e) => e.edge), ["E-P-1"], "the product's follower stands for its unit; the lapsed edge and the subscriber don't");
  assert.deepEqual(followersOn(edges, ["U-9"], "2026-11-12T10:00:00Z"), []);
  assert.deepEqual(followersOn(edges, ["U-1"]).map((e) => e.edge), ["E-U-1"], "without a moment, an until is not weighed");
});

test("in force, a telling whose aspect no kind declares is inert, never a refusal (revision 32's erratum); at publish it is still refused", () => {
  const [info] = readPackages(feed(told.replace("tells: post as filed", "tells: post as boxed")));
  assert.ok(info);
  const dict = readDefinitions(feed(told));
  // The in-force check: lenient on the aspect alone.
  checkActsInForce({ info: { acts: info.acts, utilities: info.utilities }, dict });
  // The file-local check at publish: refused.
  assert.throws(
    () => checkPackages(feed(told.replace("tells: post as filed", "tells: post as boxed"))),
    (e: unknown) => e instanceof CrubalError && /an aspect no kind declares under follow/.test(e.message),
  );
});

