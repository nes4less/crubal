import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkPackage, checkPackages, checkRecord, checkRules, foldRecord, readDefinitions, readRules, readText, STANDARD_PACKAGES, standardDefinitions } from "../src/index.ts";

const std = (p: string) => readFileSync(new URL(`../../../std/${p}`, import.meta.url), "utf8");

test("the embedded standard packages are the published ones", () => {
  for (const name of ["core", "units", "party"] as const) assert.equal(STANDARD_PACKAGES[name], std(`${name}/package.crubal`), `run \`npm run embed\` in packages/crubal (${name})`);
  const d = standardDefinitions();
  assert.ok(d.facets.has("crubal:notables"));
  assert.ok(d.levels.get("person") === "person" && d.levels.get("organization") === "organization");
  assert.ok(d.classes.has("Person"));
});

// A package is checked with the packages it extends in the dictionary (11.4), as a publish does.
const EXTENDS: { [name: string]: string[] } = {};
for (const name of ["core", "units", "party"]) {
  test(`the standard package ${name} passes its publish checks`, () => {
    const src = std(`${name}/package.crubal`);
    checkPackages(src);
    const d = readDefinitions((EXTENDS[name] ?? []).map((e) => std(`${e}/package.crubal`)).join("\n"));
    readDefinitions(src, d);
    checkPackage(d);
    checkRules(readRules(src), d);
  });
}

test("every unit and currency record fits the units package", () => {
  const d = readDefinitions(std("units/package.crubal"));
  const records = readText(std("units/units.crubal"), d).records.map((r) => foldRecord(r, d));
  assert.ok(records.length > 20);
  for (const r of records) {
    const { outcomes, summary } = checkRecord(r, d);
    assert.deepEqual(outcomes.filter((o) => o.outcome !== "absorbed"), [], r.id);
    assert.equal(summary.outcome, "complete", r.id);
  }
});
