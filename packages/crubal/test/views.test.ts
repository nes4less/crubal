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

// ─── Shared parts read through (1.6, 12): a release's view reads its works' values through the link ────────
const sharedSrc = `
kind: item
  levels: product
kind: work
  levels: work
title$
workTitle$
genres{Drama|Comedy|Horror}*
works&work* ordered
filter: genre
  facet: works[*].genres
shape: releaseCard
  slots:
    title -> heading
    works[*].workTitle -> works
    works[*].genres -> genres
view: releases
  select:
    level: product
  order: title
  shape: releaseCard
  filters: genre
view: dramas
  select:
    level: product
    when: works[*].genres has Drama
  shape: releaseCard
`;
test("a view reads a shared part through its link: slots, filters, conditions, and staleness when the part changes", () => {
  const d = readDefinitions(sharedSrc);
  const vs = readViews(sharedSrc);
  checkViews(vs, d);
  const v = new Views(d, vs);
  const put = (r: { id: string; kind: string; level: string; values: Record<string, unknown> }) => v.put({ ...r, owner: "t" } as never);
  put({ id: "W-1", kind: "work", level: "work", values: { workTitle: "Die Hard", genres: ["Drama"] } });
  put({ id: "W-2", kind: "work", level: "work", values: { workTitle: "Airplane!", genres: ["Comedy"] } });
  put({ id: "P-1", kind: "item", level: "product", values: { title: "Double feature", works: [{ $link: "W-1" }, { $link: "W-2" }] } });
  put({ id: "P-2", kind: "item", level: "product", values: { title: "Just comedy", works: [{ $link: "W-2" }] } });
  const p = v.project("releases");
  assert.deepEqual(p.records, ["P-1", "P-2"]);
  assert.deepEqual(p.rows[0]?.works, ["Die Hard", "Airplane!"], "the works' titles, in the link's order");
  assert.deepEqual(p.rows[0]?.genres, ["Drama", "Comedy"]);
  assert.deepEqual(p.counts.genre, { Drama: 1, Comedy: 2, Horror: 0 }, "a filter buckets by a value read through the link");
  assert.deepEqual(v.project("releases", { picks: { genre: ["Drama"] } }).records, ["P-1"]);
  assert.deepEqual(v.project("dramas").records, ["P-1"], "a condition reads through the link");
  assert.ok([...v.readSet("releases")].includes("works[*].workTitle"));
  const stale = v.staleAfter("releases", { id: "W-2", kind: "work", level: "work", owner: "t", values: { workTitle: "Airplane! (1980)", genres: ["Comedy"] } });
  assert.deepEqual(stale.sort(), ["P-1", "P-2"], "a write to the work stales every release that links it");
  assert.deepEqual(v.staleAfter("releases", { id: "W-2", kind: "work", level: "work", owner: "t", values: { workTitle: "Airplane!", genres: ["Comedy"] } }), [], "an unchanged key stales nothing");
});
