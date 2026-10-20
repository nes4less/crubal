import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkRules, Engine, readRules } from "../src/rules.ts";
import { CrubalError } from "../src/tree.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
title$ length: 10
subtitle$
format{DVD|Blu-ray}
hdr{HDR10|...}*
`);

test("templates: fallbacks, optional placeholders, literal braces", () => {
  const e = new Engine(dict, []);
  assert.equal(e.template('"{title ?? subtitle} · {subtitle?}"', { subtitle: "B" }), "B · B");
  assert.equal(e.template('"{title} · {subtitle?}"', { title: "A" }), "A");
  assert.equal(e.template('"{{x}} {title}"', { title: "A" }), "{x} A");
  assert.equal(e.template('"{title} {subtitle}"', { title: "A" }), undefined);
  assert.equal(e.template('"{title}"', { title: "Vacation, The" }), "Vacation, The");
});

test("a failing gate fills does-not-apply when the value is empty", () => {
  const rules = readRules("rule: gate\n  when: format is DVD\n  then: hdr is -\n  strength: must\n");
  const e = new Engine(dict, rules);
  const results = e.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: { format: "DVD" } });
  assert.ok(results.some((r) => r.result === "filled" && r.address === "hdr"));
});

test("a shortcut's length rule flags, never refuses", () => {
  const e = new Engine(dict, []);
  const results = e.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "A long title indeed" } });
  assert.ok(results.some((r) => r.result === "flagged" && r.rule === "title: length"));
  assert.ok(results.some((r) => r.result === "complete"));
});

test("a fill never overwrites a person's value", () => {
  const rules = readRules("rule: f\n  when: format is DVD\n  then: subtitle is Standard\n  strength: suggest\n");
  const e = new Engine(dict, rules);
  const results = e.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: { format: "DVD", subtitle: "Mine" } });
  assert.ok(!results.some((r) => r.result === "filled"));
});

test("contradicting must rules are refused at publish", () => {
  const rules = readRules("rule: a\n  then: format is DVD\n  strength: must\nrule: b\n  then: format is Blu-ray\n  strength: must\n");
  assert.throws(() => checkRules(rules, dict), (e: unknown) => e instanceof CrubalError && e.line === 1);
});

test("whens that can't both hold don't contradict", () => {
  const rules = readRules(
    "rule: a\n  when: title is X\n  then: format is DVD\n  strength: must\nrule: b\n  when: title is Y\n  then: format is Blu-ray\n  strength: must\n",
  );
  checkRules(rules, dict);
});

// ─── Rollups over lower levels (6.4): a product counts its units; a unit reads the best of its offers ──────
const shop = readDefinitions(`
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
const shopRules = readRules(`rule: unitsCounted
  then: unitCount is count of unit::cashierfuId
  strength: should
rule: unitStock
  for: unit::
  then: stock is best of offer::availability
  strength: should
`);
import { MemoryRecords } from "../src/records.ts";
const shopRecords = () => {
  const m = new MemoryRecords();
  const put = (r: Record) => m.set(r.id, r);
  put({ id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "Die Hard" } });
  put({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", values: { cashierfuId: "AAA" } });
  put({ id: "U-2", kind: "item", level: "unit", of: "P-1", owner: "t", values: { cashierfuId: "BBB" } });
  put({ id: "F-1", kind: "item", level: "offer", of: "U-1", owner: "t", values: { availability: "sold" } });
  put({ id: "F-2", kind: "item", level: "offer", of: "U-1", owner: "t", values: { availability: "available" } });
  return m;
};
import type { Record } from "../src/model.ts";

test("a rollup reads a lower level: count of unit:: on the product, best of offer:: on the unit; the scope unit:: applies to units", () => {
  const m = shopRecords();
  const e = new Engine(shop, shopRules, () => m);
  for (const r of m.values()) e.put(r);
  const onProduct = e.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: {} });
  assert.deepEqual(onProduct.find((r) => r.result === "derived" && r.address === "unitCount")?.value, "2");
  const onUnit = e.write({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "t", values: {} });
  assert.equal(onUnit.find((r) => r.result === "derived" && r.address === "stock")?.value, "available", "best of a ranked choice is the earliest");
  const onUnit2 = e.write({ id: "U-2", kind: "item", level: "unit", of: "P-1", owner: "t", values: {} });
  assert.ok(!onUnit2.some((r) => r.result === "derived" && r.address === "stock"), "no offers, nothing produced");
  assert.ok(!onProduct.some((r) => r.result === "derived" && r.address === "stock"), "the unit rule never runs on the product");
});

test("a derived value keeps following its rule across engines (its source says derived); an adopted one doesn't; reproduce recomputes a record and names its ancestors", () => {
  const m = shopRecords();
  m.set("P-1", { ...(m.get("P-1") as Record), values: { title: "Die Hard", unitCount: "1" }, sources: { unitCount: { origin: "derived", via: "unitsCounted" } } });
  const e = new Engine(shop, shopRules, () => m);
  for (const r of m.values()) e.put(r);
  const again = e.reproduce("P-1");
  assert.equal(again.find((r) => r.result === "derived" && r.address === "unitCount")?.value, "2", "a stale derived value is recomputed");
  m.set("P-1", { ...(m.get("P-1") as Record), values: { title: "Die Hard", unitCount: "7" }, sources: { unitCount: { origin: "declared", via: "L-9" } } });
  const e2 = new Engine(shop, shopRules, () => m);
  for (const r of m.values()) e2.put(r);
  assert.ok(!e2.reproduce("P-1").some((r) => r.result === "derived" && r.address === "unitCount"), "a person's value is adopted, never overwritten");
  assert.deepEqual(e2.ancestorsOf("F-2"), ["U-1", "P-1"], "the chain up along of");
  assert.equal(e2.readsLowerLevels, true);
  assert.equal(new Engine(shop, []).readsLowerLevels, false);
});

// ─── Rollups over a compound's rows (6.11): a count of the manifest's disc rows, with a row filter ─────────
const manifestDefs = readDefinitions(`
kind: item
  levels: product
title$
discCount#
facet: Manifest
  type: compound
  pick: any
  facets:
    manifestItem$
    manifestItemType$
    qty#
`);
const manifestRules = readRules(`rule: discsCounted
  then: discCount is sum of Manifest[*].qty where manifestItemType is disc
  strength: should
`);
test("a rollup reads the rows of the record's own compound, filtered by a row condition", () => {
  const m = new MemoryRecords();
  const rec: Record = { id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "Combo", Manifest: [
    { manifestItem: "DVD disc", manifestItemType: "disc", qty: "1" },
    { manifestItem: "Blu-ray disc", manifestItemType: "disc", qty: "2" },
    { manifestItem: "Keep case", manifestItemType: "case", qty: "1" },
  ] } };
  m.set(rec.id, rec);
  const e = new Engine(manifestDefs, manifestRules, () => m);
  e.put(rec);
  const out = e.write({ ...rec });
  assert.equal(out.find((r) => r.result === "derived" && r.address === "discCount")?.value, "3", "two disc rows, quantities 1 and 2; the case row is filtered out");
  const counted = readRules(`rule: rowsCounted
  then: discCount is count of Manifest[*] where manifestItemType is disc
  strength: should
`);
  const e2 = new Engine(manifestDefs, counted, () => m);
  e2.put(rec);
  assert.equal(e2.write({ ...rec }).find((r) => r.result === "derived" && r.address === "discCount")?.value, "2", "a bare [*] counts rows");
  const none = readRules(`rule: rowsCounted
  then: discCount is count of Manifest[*].qty
  strength: should
`);
  const e3 = new Engine(manifestDefs, none, () => m);
  e3.put(rec);
  assert.equal(e3.write({ ...rec }).find((r) => r.result === "derived" && r.address === "discCount")?.value, "3", "without a filter every row counts");
});

test("a rollup over a lower level reads the active records; a filter naming status reads the archived too", () => {
  const m = shopRecords();
  m.set("U-2", { ...(m.get("U-2") as Record), status: { state: "archived", reason: "legacy" } });
  const e = new Engine(shop, shopRules, () => m);
  for (const r of m.values()) e.put(r);
  assert.equal(e.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: {} }).find((r) => r.result === "derived" && r.address === "unitCount")?.value, "1", "the archived unit is left out");
  const all = readRules(`rule: unitsCounted
  then: unitCount is count of unit::cashierfuId where status has
  strength: should
`);
  const e2 = new Engine(shop, all, () => m);
  for (const r of m.values()) e2.put(r);
  assert.equal(e2.write({ id: "P-1", kind: "item", level: "product", owner: "t", values: {} }).find((r) => r.result === "derived" && r.address === "unitCount")?.value, "2", "status named: history included");
});

test("a rule's because round-trips through the printer's quoting", () => {
  const rules = readRules(`rule: counted
  then: unitCount is count of unit::cashierfuId where status has
  strength: should
  because: "the catalog pages the products that have units, history included (6.4)"
`);
  assert.equal(rules[0]?.because, "the catalog pages the products that have units, history included (6.4)");
});
