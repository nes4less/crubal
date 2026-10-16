import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkPackage, checkPackages, checkRecord, checkRules, foldRecord, readDefinitions, readRules, readText } from "../src/index.ts";

const std = (p: string) => readFileSync(new URL(`../../../std/${p}`, import.meta.url), "utf8");

// A package is checked with the packages it extends in the dictionary (11.4), as a publish does.
const EXTENDS: { [name: string]: string[] } = { commerce: ["product", "service"], media: ["product"] };
for (const name of ["core", "units", "party", "product", "service", "commerce", "media"]) {
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
