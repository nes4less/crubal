// A new `must … shown to` rule is visibility (12.4), not a test of data, so publishing it against the previous
// version needs no recipe; a new must rule over data still does (4.8).

import assert from "node:assert/strict";
import { test } from "node:test";
import { publish } from "../src/publish.ts";

const base = (extra = "") => `package: shop /2026-10-01
  owner: shop.example
  label: Shop
  crubal: 2

kind: deployment
  levels: deployment
  base: Deployment

name$
plan{free|paid}
holdMinutes# 1..120

class: Deployment
  label: Deployment
  for: deployment
  facets:
    name
    plan
    holdMinutes
${extra}`;

test("a new show rule publishes against the previous version without a recipe", () => {
  const v1 = publish(base(), { date: "2026-10-01" }).bundle;
  const { changes } = publish(
    base(`
rule: planIsForStaff
  for: Deployment
  strength: must
  then: plan shown to staff
`).replace("/2026-10-01", "/2026-10-02"),
    { date: "2026-10-02", previous: v1 },
  );
  const rule = changes.find((c) => c.member === "rule:planIsForStaff");
  assert.equal(rule?.kind, "new");
  assert.equal(rule?.recipe, undefined);
});

test("a new must rule over data is still breaking without a recipe", () => {
  const v1 = publish(base(), { date: "2026-10-01" }).bundle;
  assert.throws(
    () =>
      publish(
        base(`
rule: paidHoldsLong
  for: Deployment
  strength: must
  when: plan is paid
  then: holdMinutes over 30
`).replace("/2026-10-01", "/2026-10-02"),
        { date: "2026-10-02", previous: v1 },
      ),
    /breaking change .* needs review/,
  );
});
