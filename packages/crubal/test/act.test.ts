// Acts as declarations (chapter 15, revision 25): an `act:` block read with its parts, carried into the bundle and
// back, versioned in `members`, checked, and the writes a landing makes answered from what the finds found.

import assert from "node:assert/strict";
import { test } from "node:test";
import { followersOn } from "../src/access.ts";
import { type ActRecord, actWrites, findPicksOf, mintValuesOf, nextInSeries, routeCountPicksOf, routeOf, tellsValuesOf } from "../src/acts.ts";
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
  assert.deepEqual(a.thens[0]?.when?.left, { count: "boxed", plus: 1 });
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

// ─── Revision 31: a kind's follow aspects, an act's tells, the post it lands when followed ───────────────────────────

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

