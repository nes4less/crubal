// Colors (1.4.9a, revision 20): a color facet holds a hex code alone, a name alone, or a name with its hex code
// beside it. A hex code is #RRGGBB, kept in uppercase; a name is a word or a short phrase. Anything else is a
// contradiction. The text form writes `#1F2A5C`, `Navy`, or `Navy [hex: #1F2A5C]`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, checkRecord, colorOk, foldRecord, printText, readDefinitions, readText } from "../src/index.ts";
import { checkScalar } from "../src/dictionary.ts";

const dict = readDefinitions(`
kind: item
  levels: product
title$
color%
colors%*
facet: trim
  type: color
`);
const f = (k: string) => dict.facets.get(k) as never;

test("the % mark and the long form both declare a color", () => {
  assert.equal(dict.facets.get("color")?.type, "color");
  assert.equal(dict.facets.get("colors")?.pick, "any");
  assert.equal(dict.facets.get("trim")?.type, "color");
});

test("a hex code, a name, or both; nothing else", () => {
  for (const ok of ["#1F2A5C", "#1f2a5c", { $color: "Navy" }, { $color: "Navy", hex: "#1F2A5C" }, { $color: "Midnight blue" }])
    assert.equal(checkScalar(f("color"), ok as never).outcome, "absorbed", JSON.stringify(ok));
  for (const bad of ["Navy", "#1F2A5", "#1F2A5CFF", "1F2A5C", { $color: "" }, { $color: " Navy" }, { $color: "Navy", hex: "navy" }, { $color: "Navy", rgb: "1,2,3" }, { $color: "x".repeat(61) }, 12, true])
    assert.equal(checkScalar(f("color"), bad as never).outcome, "contradiction", JSON.stringify(bad));
  assert.ok(colorOk({ $color: "x".repeat(60) }));
});

test("a hex code folds to uppercase, alone or beside a name", () => {
  const r = { id: "P-1", kind: "item", level: "product", owner: "t.example", values: { color: "#1f2a5c", colors: [{ $color: "Navy", hex: "#ab12cd" }, "#00ff00"] } };
  const out = foldRecord(r as never, dict).values;
  assert.equal(out.color, "#1F2A5C");
  assert.deepEqual(out.colors, [{ $color: "Navy", hex: "#AB12CD" }, "#00FF00"]);
  assert.ok(!checkRecord({ ...r, values: out } as never, dict).outcomes.some((o) => o.outcome === "contradiction"));
});

test("the text form reads and prints all three, and a bad hex stays a contradiction", () => {
  const src = 'owner: t.example\nproduct: P-1\n  color: #1f2a5c\n  colors: Navy [hex: #1F2A5C], "#1 Red", Sky blue\n  trim: #12\n';
  const w = readText(src, dict);
  const v = w.records[0]?.values as Record<string, unknown>;
  assert.equal(v.color, "#1F2A5C");
  assert.deepEqual(v.colors, [{ $color: "Navy", hex: "#1F2A5C" }, { $color: "#1 Red" }, { $color: "Sky blue" }]);
  assert.equal(v.trim, "#12");
  const printed = printText(w, dict);
  assert.match(printed, /colors: Navy \[hex: #1F2A5C\], "#1 Red", Sky blue/);
  assert.equal(canonical(readText(printed, dict), dict), canonical(w, dict));
  const bad = checkRecord(w.records[0] as never, dict).outcomes.filter((o) => o.outcome === "contradiction");
  assert.deepEqual(bad.map((o) => o.address), ["trim"]);
});
