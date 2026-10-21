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

test("before and after compare moments by instant, and refuse to compare across kinds", () => {
  const at = (cond: string, values: Record<string, string>, now?: string) => evaluate(parseCondition(cond), values, undefined, now);
  assert.equal(at("t before now", { t: "2026-10-14T08:00-05:00" }, "2026-10-14T12:00Z"), false); // 13:00Z
  assert.equal(at("t before now", { t: "2026-10-14T06:00-05:00" }, "2026-10-14T12:00Z"), true); // 11:00Z
  assert.equal(at("d before now", { d: "2026-10-13" }, "2026-10-14T00:30+05:00"), false); // that moment is 2026-10-13 UTC
  assert.equal(at("w before now", { w: "2026-10-14T08:00" }, "2026-10-14T12:00Z"), "undetermined"); // local vs moment
  assert.equal(at("o after 09:00", { o: "22:30" }), true);
  assert.equal(at("o after 2026-10-14T09:00Z", { o: "22:30" }), "undetermined"); // a time of day vs a moment
});

test("time facets: marks, offsets, and the 24-hour clock", () => {
  const d = readDefinitions("ends@ymdhm\nopens@hm\nwall@ymdh zone: local\n");
  assert.equal(d.facets.get("ends")?.type, "date");
  assert.equal(d.facets.get("ends")?.precision, "minute");
  assert.equal(d.facets.get("opens")?.type, "time");
  assert.equal(d.facets.get("wall")?.zone, "local");
});

test("a class carries its prefixed settings (5.2), through the bundle too", async () => {
  const d = readDefinitions("title$\nclass: DVD\n  label: DVD\n  for: item\n  cfu:gpc: 543527\n  cfu:hints: format DVD, MiniDVD\n  facets:\n    title\n");
  assert.deepEqual(d.classes.get("DVD")?.extra, { "cfu:gpc": "543527", "cfu:hints": "format DVD, MiniDVD" });
  const { publish } = await import("../src/publish.ts");
  const { readBundle } = await import("../src/bundle.ts");
  const src = "package: discs /2026-10-21\n  owner: discs.example\n  crubal: 2\n\nkind: item\n  levels: product\n\ntitle$\n\nclass: DVD\n  for: item\n  cfu:gpc: 543527\n  facets:\n    title\n";
  const { bundle } = publish(src, { date: "2026-10-21" });
  assert.equal(readBundle(bundle).dict.classes.get("DVD")?.extra["cfu:gpc"], "543527");
});
