// A facet's unit is a spelling (spec 4.2): `hr` and `hours` are the table's `h`. The definition keeps the
// table's unit, so values convert and compare by it, and publish accepts any spelling the table knows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkPackage } from "../src/dictionary.ts";

test("a unit spelling folds to the table's unit, in the long form, the shorthand and accepts", () => {
  const d = readDefinitions(`facet: activationPeriod
  type: number
  unit: hr
runtime#hours accepts: mins, s
weight#kg accepts: g, lb, oz
`);
  assert.equal(d.facets.get("activationPeriod")?.unit, "h");
  assert.equal(d.facets.get("runtime")?.unit, "h");
  assert.deepEqual(d.facets.get("runtime")?.accepts, ["min", "s"]);
  assert.deepEqual(d.facets.get("weight")?.accepts, ["g", "lb", "oz"]);
  checkPackage(d);
});

test("a currency and the word currency stay as written; a word the table doesn't know is refused at publish", () => {
  const d = readDefinitions("price#USD\nfee#currency\n");
  assert.equal(d.facets.get("price")?.unit, "USD");
  assert.equal(d.facets.get("fee")?.unit, "currency");
  checkPackage(d);
  assert.throws(() => checkPackage(readDefinitions("span#fortnights\n")), /fortnights isn't a unit the units table knows/);
});
