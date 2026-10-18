import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkContracts, Exchange } from "../src/exchange.ts";
import { checkPackages } from "../src/packages.ts";
import { readRules } from "../src/rules.ts";
import { readContracts } from "../src/store.ts";
import { CrubalError } from "../src/tree.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
title$
format{DVD|Blu-ray~BD}
`);
const rec = { id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "A", format: "Blu-ray" } };

test("map out builds nested payloads, applies value maps and literals", () => {
  const cs = readContracts(`
contract: send1
  kind: send
  writes:
    title -> item."Full Title"
    format -> item.fmt
      Blu-ray -> BD-50
    "USD" -> currency
`);
  checkContracts(cs, dict);
  const ex = new Exchange(dict, cs);
  ex.put(rec);
  const r = ex.run("send1", "P-1");
  assert.deepEqual(r.payload, { item: { "Full Title": "A", fmt: "BD-50" }, currency: "USD" });
});

test("a credential is a name, never a secret", () => {
  const cs = readContracts("contract: s\n  kind: send\n  credential: sk_live 4f9a=+/\n");
  assert.throws(() => checkContracts(cs, dict), (e: unknown) => e instanceof CrubalError && e.line === 3);
});

test("a part a contract's kind doesn't allow is refused", () => {
  const cs = readContracts("contract: s\n  kind: send\n  keep-raw: X\n  prefix: m\n");
  assert.throws(() => checkContracts(cs, dict), CrubalError);
});

test("a receive answer that disagrees with the record is a conflict, and lands by trust", () => {
  const cs = readContracts("contract: look\n  kind: receive\n  reads:\n    T -> title\n");
  const ex = new Exchange(dict, cs);
  ex.put({ ...rec, sources: { "*": { origin: "declared", via: "L-1" } } });
  const r = ex.receiveRun("look", "P-1", '{"T":"B"}');
  assert.equal((r.outcomes as { outcome: string }[])[0]?.outcome, "conflict");
  assert.equal(ex.get("P-1")?.values.title, "A");
});

test("an extending package may add values but not change a type", () => {
  checkPackages("package: base /1\n  owner: b.example\nformat{DVD}\n\npackage: mine /1\n  owner: m.example\n  extends: base /1\nfacet: base:format\n  type: choice\n  values: DVD, LP\n");
  assert.throws(
    () => checkPackages("package: base /1\n  owner: b.example\nformat{DVD}\n\npackage: mine /1\n  owner: m.example\n  extends: base /1\nfacet: base:format\n  type: text\n"),
    (e: unknown) => e instanceof CrubalError && e.line === 8,
  );
});

// ─── A child's write recomputes what its ancestors derive from it (6.4: recomputed whenever what it reads changes) ──
test("an arrival below recomputes the rollups above it, in the same run", () => {
  const d = readDefinitions(`
kind: item
  levels: product, unit, offer
  vary:
    unit: cashierfuId, stock
    offer: availability
title$
unitCount#
cashierfuId$
stock{available|held|sold|withdrawn|none}
availability{available|held|sold|withdrawn}
`);
  const rules = readRules(`rule: unitsCounted
  then: unitCount is count of unit::cashierfuId
  strength: should
rule: unitStock
  for: unit::
  then: stock is best of offer::availability
  strength: should
`);
  const cs = readContracts(`contract: unit
  kind: form
  for: unit::
  needs:
    unit::cashierfuId
contract: offer
  kind: form
  for: offer::
  needs:
    offer::availability
`);
  const ex = new Exchange(d, cs, [], rules);
  ex.put({ id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "Die Hard" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  const u1 = ex.arriveRun("unit", '{"cashierfuId":"AAA"}', "unit", undefined, "P-1");
  assert.ok(!u1.stopped, JSON.stringify(u1));
  assert.equal(ex.get("P-1")?.values.unitCount, "1", "the product counts its first unit");
  assert.deepEqual(ex.get("P-1")?.sources?.unitCount, { origin: "derived", via: "unitsCounted" });
  const u2 = ex.arriveRun("unit", '{"cashierfuId":"BBB"}', "unit", undefined, "P-1");
  assert.ok(!u2.stopped);
  assert.equal(ex.get("P-1")?.values.unitCount, "2", "and its second");
  const unitId = String((u1.arrival as { record: string }).record);
  const f1 = ex.arriveRun("offer", '{"availability":"available"}', "offer", undefined, unitId);
  assert.ok(!f1.stopped, JSON.stringify(f1));
  assert.equal(ex.get(unitId)?.values.stock, "available", "the unit reads the best of its offers");
  // The offer sells (a store's own write, as a checkout makes it): the unit follows.
  const offerId = String((f1.arrival as { record: string }).record);
  const offer = ex.get(offerId) as NonNullable<ReturnType<typeof ex.get>>;
  ex.put({ ...offer, values: { ...offer.values, availability: "sold" } });
  assert.deepEqual(ex.reproduceAncestors(offerId), [unitId], "the unit changed, the product didn't");
  assert.equal(ex.get(unitId)?.values.stock, "sold", "and follows them when they change");
  assert.equal(ex.get("P-1")?.values.unitCount, "2");
});
