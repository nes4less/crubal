// Revision 35 (11.2, 15.1): the tools the orders borrowed. A level declares its quantity (`shares:`), an act may
// land on fewer than the record holds (`takes: share`), and a find or a count may name the caller.

import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkPackages, readPackages, sharesOf } from "../src/packages.ts";
import { CrubalError } from "../src/tree.ts";
import { findPicksOf, mintValuesOf, shareOf } from "../src/acts.ts";

const shop = (o: { shares?: string; act?: string; qty?: string } = {}) => `package: shop /2027-01-06
  owner: shop.example
  crubal: 2

kind: order
  levels: order, pick
${o.shares ?? "  shares:\n    pick: pickQty"}
kind: tote
  levels: tote
title$
${o.qty ?? "pickQty#"}
pulled@
inTote&tote
toteLabel$
toteHolder&
toteState{open|closed}

permissions: shop
  menu:
    pick: run pull
  presets:
    fulfiller: pick    audience: staff
  relations: buyer only

utility: orders /2027-01-06
  label: Orders
  serves: owner, fulfiller(pick)
  acts: pull
  mark: parcel amber

${
  o.act ??
  `act: pull /2027-01-06
  label: Pull
  utility: orders
  on: pick
  takes: share
  find:
    tote -> first tote where toteHolder = caller, toteState = open order toteLabel
  mint:
    tote -> tote when none
      toteLabel -> next "TOTE" in tote.toteLabel
      toteHolder -> link caller
      toteState -> open
  count:
    mine -> tote where toteHolder = caller
  set:
    pulled -> now
    inTote -> link tote`
}
`;

const refused = (src: string, why: RegExp) => assert.throws(() => checkPackages(src), (e: unknown) => e instanceof CrubalError && why.test(e.message));

test("a kind's shares names a level's quantity, an act takes a share, a find names the caller: read, checked, and through the bundle and back", () => {
  const src = shop();
  checkPackages(src);
  const dict = readDefinitions(src);
  assert.deepEqual([...sharesOf(dict)], [["pick", "pickQty"]]);
  const act = readPackages(src)[0]?.acts.find((a) => a.name === "pull");
  assert.equal(act?.takes, "share");
  assert.deepEqual(act?.finds[0]?.where[0]?.value, { caller: true });
  assert.deepEqual(act?.counts[0]?.where[0]?.value, { caller: true });
  const bundle = bundleOf(parsePackage(src));
  const kind = (bundle.kinds as { kind: string; shares?: unknown }[]).find((k) => k.kind === "order");
  assert.deepEqual(kind?.shares, { pick: "pickQty" });
  const text = printBundle(bundle);
  assert.match(text, /\n {2}shares:\n {4}pick: pickQty\n/);
  assert.match(text, /\n {2}takes: share\n/);
  assert.match(text, /where toteHolder = caller, toteState = open/);
  assert.match(text, /toteLabel -> next "TOTE" in tote\.toteLabel/);
  assert.equal(serialize(bundleOf(parsePackage(text))), serialize(bundle), "the printed text reads back to the same bundle");
});

test("refused: shares on no level of the kind, on no facet, on a facet that is no number; takes on a level with no quantity; a takes that is not share", () => {
  refused(shop({ shares: "  shares:\n    line: pickQty" }), /shares names line, which isn't a level of order/);
  refused(shop({ shares: "  shares:\n    pick: nothing" }), /shares at pick names nothing, which isn't a facet/);
  refused(shop({ qty: "pickQty$" }), /shares at pick names pickQty, which isn't a number/);
  refused(shop({ shares: "" }), /the act pull takes a share, and pick declares no quantity/);
  assert.throws(() => readPackages(shop().replace("takes: share", "takes: half")), /takes is "share"/);
});

test("a find's caller resolves to the person running the act", () => {
  const act = readPackages(shop())[0]?.acts.find((a) => a.name === "pull");
  assert.ok(act?.finds[0]);
  const picks = findPicksOf(act.finds[0], { record: { id: "K1", values: {} }, context: {}, caller: "person:shop.example:P-7" });
  assert.deepEqual(picks, [{ facet: "toteHolder", value: "person:shop.example:P-7" }, { facet: "toteState", value: "open" }]);
  // The mint: the next label in a series whose prefix is the words themselves, and the caller as its holder.
  const made = mintValuesOf(act.finds[0], { record: { id: "K1", values: {} }, context: {}, found: {}, now: "2027-01-06T10:00:00Z", caller: "person:shop.example:P-7", labels: { "tote.toteLabel": ["TOTE 001", "TOTE 004"] } });
  assert.deepEqual(made.ok && made.values, { toteLabel: "TOTE 005", toteHolder: { $link: "person:shop.example:P-7" }, toteState: "open" });
});

test("a share: all of it is the record itself; fewer is the count taken and the count kept; none, too many and a part of one are refused", () => {
  const three = { id: "K1", values: { pickQty: "3" } };
  assert.deepEqual(shareOf(three, "pickQty", 3), { ok: true, whole: true });
  assert.deepEqual(shareOf(three, "pickQty", 1), { ok: true, whole: false, taken: "1", rest: "2" });
  assert.deepEqual(shareOf(three, "pick::pickQty", 2), { ok: true, whole: false, taken: "2", rest: "1" });
  assert.equal(shareOf(three, "pickQty", 0).ok, false);
  assert.equal(shareOf(three, "pickQty", 4).ok, false);
  assert.equal(shareOf(three, "pickQty", 1.5).ok, false);
  // No count said is one thing: taken whole, never in part.
  assert.deepEqual(shareOf({ id: "K2", values: {} }, "pickQty", 1), { ok: true, whole: true });
  assert.equal(shareOf({ id: "K2", values: {} }, "pickQty", 2).ok, false);
});
