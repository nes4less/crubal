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
