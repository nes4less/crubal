import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { convert, currencyPlaces, extendUnits, knownUnit, resetUnits, unitOf, unitsTable } from "../src/units.ts";
import { STANDARD_UNITS } from "../src/units-table.ts";

test("the embedded table is the published one", () => {
  const published = readFileSync(fileURLToPath(new URL("../../../std/units/units.crubal", import.meta.url)), "utf8");
  assert.equal(STANDARD_UNITS, published, "run `npm run units` in packages/crubal");
  assert.equal(unitsTable().version, "2026-10-15");
});

test("spellings fold to their unit; a spelling nobody knows is null", () => {
  assert.equal(unitOf("MIN."), "min");
  assert.equal(unitOf("Fl. Oz."), "floz");
  assert.equal(unitOf("stone"), null);
  assert.ok(knownUnit("USD") && knownUnit("currency") && knownUnit("°C") && !knownUnit("stone"));
});

test("conversion goes through the base by factor and offset, rounded to the facet's places or the dimension's", () => {
  assert.equal(convert("1.5", "h", "min"), "90");
  assert.equal(convert("98.6", "°F", "°C", 1), "37.0");
  assert.equal(convert("0", "°C", "K"), "273.15");
  assert.equal(convert("1", "gal", "mL"), "3785.412");
  assert.equal(convert("1", "lb", "L"), null, "never across dimensions");
  assert.equal(currencyPlaces("JPY"), 0);
});

test("an extension adds units under a prefix and spellings to standard ones, never a factor", () => {
  extendUnits("measure: me:slab\n  dimension: count\n  factor: 1\n  spellings: slab, slabs\nmeasure: min\n  factor: 999\n  spellings: Min.\n");
  assert.equal(unitOf("slabs"), "me:slab");
  assert.equal(unitOf("Min."), "min");
  assert.equal(convert("1", "h", "min"), "60", "the standard factor stands");
  resetUnits();
  assert.equal(unitOf("slabs"), null);
});

test("an extension never changes a standard unit (11.9): it may only add spellings", () => {
  resetUnits();
  const before = unitOf("kg");
  extendUnits("measure: kg\n  dimension: mass\n  factor: 2\n  spellings: kilo\n");
  assert.equal(unitOf("kilo"), "kg", "the spelling joined");
  assert.equal(convert("1", "kg", "g"), "1000", "the factor didn't move");
  assert.equal(before, "kg");
  resetUnits();
});
