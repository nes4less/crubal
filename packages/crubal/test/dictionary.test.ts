import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parseCondition } from "../src/conditions.ts";
import { checkPackage, foldKey, resolve } from "../src/dictionary.ts";
import { readDefinitions } from "../src/defs.ts";
import { CrubalError } from "../src/tree.ts";
import { convert } from "../src/units.ts";

test("fold keys ignore case and spacing", () => {
  assert.equal(foldKey("  DVD   Video "), "dvd video");
  assert.equal(foldKey("VIDEOFORMAT"), foldKey("videoFormat"));
});

test("conditions are three-valued over empties", () => {
  const c = parseCondition("workType is series and not region is B");
  assert.equal(evaluate(c, { workType: "series", region: "A" }), true);
  assert.equal(evaluate(c, { workType: "series" }), "undetermined");
  // "is -" and "is _" test the empties themselves, so they are never undetermined (6.3.1).
  assert.equal(evaluate(parseCondition("not region is -"), {}), true);
  assert.equal(evaluate(c, { workType: "film" }), false);
  assert.equal(evaluate(parseCondition("format is DVD"), { format: { $empty: "n/a" } }), false);
  assert.equal(evaluate(parseCondition("format is -"), { format: { $empty: "n/a" } }), true);
  assert.equal(evaluate(parseCondition("runtime in 1..600"), { runtime: "97" }), true);
  assert.equal(evaluate(parseCondition("genres has Comedy"), { genres: ["Comedy", "Holiday"] }), true);
});

test("a class's meet narrows and never widens", () => {
  const d = readDefinitions(`
format{DVD|Blu-ray|4K}
class: A
  facets:
    format{DVD|Blu-ray}
class: B
  uses: A
  facets:
    !format{Blu-ray|4K}
`);
  checkPackage(d);
  const [line] = resolve(d, ["B"]);
  assert.deepEqual(line?.values, ["Blu-ray"]);
  assert.equal(line?.required, true);
});

test("a class line that widens is refused at its line", () => {
  const d = readDefinitions("format{DVD}\nclass: W\n  facets:\n    format{DVD|LP}\n");
  assert.throws(() => checkPackage(d), (e: unknown) => e instanceof CrubalError && e.line === 4);
});

test("a redundant class line warns without refusing", () => {
  const d = readDefinitions("title$\nclass: A\n  facets:\n    title\nclass: B\n  uses: A\n  facets:\n    title\n");
  const warnings = checkPackage(d);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.line, 8);
});

test("units convert within a dimension only", () => {
  assert.equal(convert("1.5", "h", "min"), "90");
  assert.equal(convert("1", "h", "kg"), null);
});
