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
