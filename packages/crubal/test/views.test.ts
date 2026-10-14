import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkViews, readViews, Views } from "../src/views.ts";
import { CrubalError } from "../src/tree.ts";

const src = `
kind: item
  levels: product, unit
title$
year#
format{DVD|Blu-ray}
filter: decade
  facet: year
  buckets:
    1980s: 1980..1989
    1990s: 1990..1999
shape: s
  slots:
    title -> t
view: v
  select:
    level: product
    when: format is DVD
  order: year after
  shape: s
  filters: decade
`;
const dict = readDefinitions(src);
const set = readViews(src);
const rec = (id: string, values: Record<string, string>) => ({ id, kind: "item", level: "product", owner: "t", values });

test("range buckets and a select condition", () => {
  checkViews(set, dict);
  const v = new Views(dict, set);
  v.put(rec("A", { title: "a", year: "1985", format: "DVD" }));
  v.put(rec("B", { title: "b", year: "1995", format: "DVD" }));
  v.put(rec("C", { title: "c", year: "1991", format: "Blu-ray" }));
  const p = v.project("v");
  assert.deepEqual(p.records, ["B", "A"]);
  assert.deepEqual(p.counts.decade, { "1980s": 1, "1990s": 1 });
  const picked = v.project("v", { picks: { decade: ["1980s"] } });
  assert.deepEqual(picked.records, ["A"]);
  assert.equal(picked.indexable, false); // decade isn't an indexed filter
});

test("an unknown shape is refused at the view's line", () => {
  const bad = readViews("view: w\n  select:\n    level: product\n  shape: nope\n");
  assert.throws(() => checkViews(bad, dict), (e: unknown) => e instanceof CrubalError && e.line === 1);
});

test("the read set names what a view reads", () => {
  const v = new Views(dict, set);
  assert.deepEqual([...v.readSet("v")].sort(), ["format", "title", "year"]);
});
