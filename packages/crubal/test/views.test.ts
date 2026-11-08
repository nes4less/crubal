import assert from "node:assert/strict";
import { test } from "node:test";
import { Access, emptyPermissions } from "../src/access.ts";
import { readDefinitions } from "../src/defs.ts";
import { MemoryRecords } from "../src/records.ts";
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
  assert.deepEqual(v.staleAfter("releases", { id: "W-2", kind: "work", level: "work", owner: "t", values: {} }), [], "a write to no key the view reads stales nothing");
});

// ─── A compound's rows in a view (1.10, [*]): a filter on a child, through a link too ───────────────────
const rowsSrc = `
kind: item
  levels: product
kind: work
  levels: work
title$
facet: ratings
  type: compound
  pick: any
  facets:
    board{MPAA|ESRB}
    value$
works&work*
filter: rating
  facet: works[*].ratings[*].value
  buckets:
    R: R
    PG: PG
shape: card
  slots:
    title -> heading
    works[*].ratings[*].value -> ratings
view: releases
  select:
    level: product
    when: works[*].ratings[*].value has R
  shape: card
  filters: rating
`;
test("a filter, a slot and a condition read a compound's rows by child, through a link", () => {
  const d = readDefinitions(rowsSrc);
  const vs = readViews(rowsSrc);
  checkViews(vs, d);
  const v = new Views(d, vs);
  v.put({ id: "W-1", kind: "work", level: "work", owner: "t", values: { ratings: [{ board: "MPAA", value: "R" }] } });
  v.put({ id: "W-2", kind: "work", level: "work", owner: "t", values: { ratings: [{ board: "MPAA", value: "PG" }] } });
  v.put({ id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "R film", works: [{ $link: "W-1" }] } });
  v.put({ id: "P-2", kind: "item", level: "product", owner: "t", values: { title: "PG film", works: [{ $link: "W-2" }] } });
  const p = v.project("releases");
  assert.deepEqual(p.records, ["P-1"], "the condition reads the rows through the link");
  assert.deepEqual(p.rows[0]?.ratings, ["R"]);
  assert.deepEqual(p.counts.rating, { R: 1, PG: 0 });
});

test("a filter on a compound's child buckets by the child's own list", () => {
  const src = `
kind: item
  levels: product
title$
facet: Audio
  type: compound
  pick: any
  facets:
    language{English|French|Spanish}
    codec$
filter: language
  facet: Audio[*].language
shape: s
  slots:
    title -> t
view: v
  select:
    level: product
  shape: s
  filters: language
`;
  const d = readDefinitions(src);
  const vs = readViews(src);
  checkViews(vs, d);
  const v = new Views(d, vs);
  v.put({ id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "a", Audio: [{ language: "English", codec: "DTS" }, { language: "French" }] } });
  v.put({ id: "P-2", kind: "item", level: "product", owner: "t", values: { title: "b", Audio: [{ language: "Spanish" }] } });
  const p = v.project("v");
  assert.deepEqual(p.counts.language, { English: 1, French: 1, Spanish: 1 });
  assert.deepEqual(v.project("v", { picks: { language: ["French"] } }).records, ["P-1"]);
});

// ─── Displays (12.9): a template for a screen over a view, carried like a shape ───

const displaySrc = `
kind: item
  levels: product
title$
price#
shape: card
  slots:
    title -> heading
    price -> price
display: menu
  label: Menu
  describe: Two columns of name and price, for a board above a counter.
  layout: menu
  slots:
    heading -> name
    price -> price
  tokens:
    columns: 2
    every: 30s
    scale: large
display: bare
  layout: grid
`;

test("a display is read: its layout, slots, tokens and words", () => {
  const set = readViews(displaySrc);
  const d = set.displays.get("menu");
  assert.ok(d);
  assert.equal(d.label, "Menu");
  assert.equal(d.layout, "menu");
  assert.deepEqual(d.slots.map((s) => [s.from, s.to]), [["heading", "name"], ["price", "price"]]);
  assert.deepEqual(Object.fromEntries(d.tokens), { columns: "2", every: "30s", scale: "large" });
  const bare = set.displays.get("bare");
  assert.ok(bare);
  assert.equal(bare.slots.length, 0);
  assert.equal(bare.tokens.size, 0);
  checkViews(set, readDefinitions(displaySrc));
});

test("a display without a layout, with a malformed slot, or filling one slot twice is refused", () => {
  assert.throws(() => readViews("display: x\n  slots:\n    a -> b\n"), (e: unknown) => e instanceof CrubalError && /names no layout/.test(e.message));
  assert.throws(() => readViews("display: x\n  layout: menu\n  slots:\n    a b\n"), (e: unknown) => e instanceof CrubalError && /shapeSlot -> displaySlot/.test(e.message));
  const twice = readViews("display: x\n  layout: menu\n  slots:\n    a -> n\n    b -> n\n");
  assert.throws(() => checkViews(twice, readDefinitions("kind: item\n  levels: product\n")), (e: unknown) => e instanceof CrubalError && /fills the slot n twice/.test(e.message));
});

// ─── A print, a label design (12.12; revision 21) ──────────────────────────────────────────────────────
const printSrc = `
kind: item
  levels: product
title$
cashierfuId$
condition{good|fair}
class: Filed
  label: Filed
  for: item
  facets:
    title
    cashierfuId
    condition
print: tag
  label: Unit tag
  describe: A 2.5 by 1 thermal tag: the id as bars, the title under them.
  for: Filed
  inches: 2.5 1
  fields:
    code -> cashierfuId
    title -> title
    shop -> place:name
  elements:
    rect 0 0 1 1 fill white
    barcode 0.06 0.02 0.88 0.68 code text
    text 0.5 0.95 0.067 "{code} | {title}" anchor middle weight bold clip 0.04 0.86 0.92 0.12
    text 0.98 0.08 0.05 shop anchor end rotate cw
    text 0.5 0.3 0.09 title anchor middle clip 0.3 0.01 0.7 0.5 lines 2
    image 0.8 0.5 0.15 0.3 shop
print: square
  for: item
  inches: 2 2
  stretch: yes
  elements:
    qr 0.1 0.1 0.8 0.8 id gravity top-left
`;

test("a print is read: what it prints, its inches, its fields and its elements, each as written", () => {
  const set = readViews(printSrc);
  const p = set.prints.get("tag");
  assert.ok(p);
  assert.equal(p.label, "Unit tag");
  assert.equal(p.for, "Filed");
  assert.deepEqual(p.inches, { w: 2.5, h: 1 });
  assert.equal(p.stretch, false);
  assert.deepEqual(p.fields.map((f) => [f.slot, f.from]), [["code", "cashierfuId"], ["title", "title"], ["shop", "place:name"]]);
  assert.equal(p.elements.length, 6);
  const [rect, bars, line, side] = p.elements;
  assert.deepEqual(rect, { type: "rect", box: { x: 0, y: 0, w: 1, h: 1 }, fill: "white", line: rect?.line });
  assert.equal(bars?.type, "barcode");
  if (bars?.type === "barcode") {
    assert.equal(bars.field, "code");
    assert.equal(bars.text, true);
    assert.deepEqual(bars.box, { x: 0.06, y: 0.02, w: 0.88, h: 0.68 });
  }
  assert.equal(line?.type, "text");
  if (line?.type === "text") {
    assert.deepEqual(line.source, { literal: "{code} | {title}" });
    assert.equal(line.anchor, "middle");
    assert.equal(line.weight, "bold");
    assert.deepEqual(line.clip, { x: 0.04, y: 0.86, w: 0.92, h: 0.12 });
  }
  if (side?.type === "text") {
    assert.deepEqual(side.source, { field: "shop" });
    assert.equal(side.rotate, "cw");
  }
  const square = set.prints.get("square");
  assert.ok(square);
  assert.equal(square.stretch, true);
  assert.equal(square.elements[0]?.type, "qr");
  checkViews(set, readDefinitions(printSrc));
});

test("a print without a for or inches, a malformed element, an unknown class, a field that isn't a facet, or an element naming no field is refused", () => {
  const dict = readDefinitions(printSrc);
  assert.throws(() => readViews("print: x\n  inches: 2 1\n  elements:\n    rect 0 0 1 1\n"), (e: unknown) => e instanceof CrubalError && /says no for/.test(e.message));
  assert.throws(() => readViews("print: x\n  for: Filed\n  inches: 2\n  elements:\n    rect 0 0 1 1\n"), (e: unknown) => e instanceof CrubalError && /width height/.test(e.message));
  assert.throws(() => readViews("print: x\n  for: Filed\n  inches: 2 1\n  elements:\n    circle 0 0 1 1\n"), (e: unknown) => e instanceof CrubalError && /a rect, a barcode, a qr, a text or an image/.test(e.message));
  assert.throws(() => readViews("print: x\n  for: Filed\n  inches: 2 1\n  elements:\n    rect 0 0 1 2\n"), (e: unknown) => e instanceof CrubalError && /fraction of the art/.test(e.message));
  assert.throws(() => readViews("print: x\n  for: Filed\n  inches: 2 1\n"), (e: unknown) => e instanceof CrubalError && /draws nothing/.test(e.message));
  assert.throws(() => checkViews(readViews("print: x\n  for: Nothing\n  inches: 2 1\n  elements:\n    rect 0 0 1 1\n"), dict), (e: unknown) => e instanceof CrubalError && /neither a class nor a kind/.test(e.message));
  assert.throws(() => checkViews(readViews("print: x\n  for: Filed\n  inches: 2 1\n  fields:\n    a -> nothingHere\n  elements:\n    rect 0 0 1 1\n"), dict), (e: unknown) => e instanceof CrubalError && /isn't a facet/.test(e.message));
  assert.throws(() => checkViews(readViews("print: x\n  for: Filed\n  inches: 2 1\n  fields:\n    a -> place:logo\n  elements:\n    rect 0 0 1 1\n"), dict), (e: unknown) => e instanceof CrubalError && /brand slot/.test(e.message));
  assert.throws(() => checkViews(readViews("print: x\n  for: Filed\n  inches: 2 1\n  elements:\n    barcode 0 0 1 1 code\n"), dict), (e: unknown) => e instanceof CrubalError && /draws code, which is none of its fields/.test(e.message));
  // `id` is every print's, declared or not.
  checkViews(readViews("print: x\n  for: Filed\n  inches: 2 1\n  elements:\n    qr 0 0 1 1 id\n"), dict);
});

// ─── A view partitioned by a link facet (12.2, 14.10; revision 11) ─────────────────────────────────────
const linkedSrc = `
kind: notice
  levels: notice
kind: person
  levels: person
words$
to&person
shape: n
  slots:
    words -> words
view: mine
  select:
    level: notice
  partition: linked to
  order: words
  shape: n
  show: member
`;

test("revision 11: a linked partition names a link facet; the row carries whom it names; a caller is served their own rows", () => {
  const d = readDefinitions(linkedSrc);
  const vs = readViews(linkedSrc);
  checkViews(vs, d);
  const bad = (partition: string) => readViews(`shape: n\n  slots:\n    words -> words\nview: w\n  select:\n    level: notice\n  partition: ${partition}\n  shape: n\n`);
  assert.throws(() => checkViews(bad("linked nope"), d), /isn't a facet/);
  assert.throws(() => checkViews(bad("linked words"), d), /isn't a link/);
  assert.throws(() => checkViews(bad("beside"), d), /a partition is/);
  const pairs: [string, { id: string; kind: string; level: string; owner: string; values: Record<string, unknown> }][] = [
    ["N-1", { id: "N-1", kind: "notice", level: "notice", owner: "t", values: { words: "a", to: { $link: "person:P-1" } } }],
    ["N-2", { id: "N-2", kind: "notice", level: "notice", owner: "t", values: { words: "b", to: { $link: "person:P-2" } } }],
    ["N-3", { id: "N-3", kind: "notice", level: "notice", owner: "t", values: { words: "c" } }],
  ];
  const access = new Access(d, emptyPermissions(), new MemoryRecords(pairs as never), [], "t");
  const v = new Views(d, vs);
  for (const [, r] of pairs) v.put(r as never);
  const caller = { id: "person:P-1", kind: "person", level: "person", owner: "t", values: {} };
  const p = v.project("mine", { caller: caller as never, access });
  assert.deepEqual(p.records, ["N-1"], "the caller is served the rows that name them, none other");
  assert.equal((p.rows[0] as { linked?: unknown }).linked, "person:P-1", "the row carries whom it names");
  const whole = v.project("mine", { audience: "member", access });
  assert.deepEqual(whole.records, ["N-1", "N-2", "N-3"], "with no caller the projection is the whole selection, for the stream");
  assert.deepEqual(whole.rows.map((r) => (r as { linked?: unknown }).linked), ["person:P-1", "person:P-2", undefined]);
  assert.ok(access.standsIn("person:P-2", "N-2", "linked to"));
  assert.ok(!access.standsIn("person:P-2", "N-1", "linked to"));
  assert.ok(!access.standsIn("person:P-2", "N-3", "linked to"));
});


test("revision 27: a text's lines, 2 to 9, wraps the words; one line, or ten, is refused", () => {
  const p = readViews(printSrc).prints.get("tag");
  const wrapped = p?.elements.find((e) => e.type === "text" && e.lines);
  assert.equal(wrapped && wrapped.type === "text" ? wrapped.lines : undefined, 2);
  assert.throws(() => readViews(printSrc.replace("lines 2", "lines 1")), /lines is a count from 2 to 9, not 1/);
  assert.throws(() => readViews(printSrc.replace("lines 2", "lines ten")), /lines is a count from 2 to 9, not ten/);
});

test("revision 28: an image element, the field's picture fit within its box; one with options or without a field is refused", () => {
  const p = readViews(printSrc).prints.get("tag");
  const img = p?.elements.find((e) => e.type === "image");
  assert.deepEqual(img && img.type === "image" ? { box: img.box, field: img.field } : undefined, { box: { x: 0.8, y: 0.5, w: 0.15, h: 0.3 }, field: "shop" });
  assert.throws(() => readViews(printSrc.replace("image 0.8 0.5 0.15 0.3 shop", "image 0.8 0.5 0.15 0.3")), /an image is "image x y w h <field>"/);
  assert.throws(() => readViews(printSrc.replace("image 0.8 0.5 0.15 0.3 shop", "image 0.8 0.5 0.15 0.3 shop gravity top-left")), /takes no options/);
});
