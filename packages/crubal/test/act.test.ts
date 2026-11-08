// Acts as declarations (chapter 15, revision 25): an `act:` block read with its parts, carried into the bundle and
// back, versioned in `members`, checked, and the writes a landing makes answered from what the finds found.

import assert from "node:assert/strict";
import { test } from "node:test";
import { actWrites, findPicksOf } from "../src/acts.ts";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { checkPackages, readPackages } from "../src/packages.ts";
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
title$
filedIn&container
filedBox$
filedAt@
containerLabel$
containerState{open|full}
containerCount#
containerCapacity#
containerStation&station
unitPrint$
printer$

class: Item
  for: item
  facets:
    !title
    filedIn
    filedBox
    filedAt
class: Container
  for: container
  facets:
    !containerLabel
    containerState
    containerCount
    containerCapacity
    containerStation
class: Station
  for: station
  facets:
    unitPrint
    printer

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
    then: [{ id: "C-7", values: { containerState: "full" } }],
  });
  const roomy = { ...box, values: { ...box.values, containerCount: 1 } };
  const w2 = actWrites(a, { record: unit, context: { station }, found: { box: [roomy] }, now: "x" });
  assert.deepEqual(w2.ok && w2.then, []);
  assert.deepEqual(actWrites(a, { record: unit, context: { station }, found: {}, now: "x" }), { ok: false, why: "no container for box" });
});
