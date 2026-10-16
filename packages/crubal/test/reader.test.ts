import assert from "node:assert/strict";
import { addressNames, checkWrapper, parseJson } from "../src/model.ts";
import { test } from "node:test";
import { canonical, CrubalError, emptyDictionary, printText, readDefinitions, readText } from "../src/index.ts";
import { needsQuotes, readList, readPiece } from "../src/lex.ts";
import { readTree, splitPair } from "../src/tree.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
title$
genres{Comedy|Drama|...}*
price#USD
runtime#min
sealed?
facet: tracks
  type: compound
  pick: any
  ordered: yes
  facets:
    language$
`);

test("the separator is the first colon followed by a space", () => {
  assert.deepEqual(splitPair("schema:name: Title"), { key: "schema:name", value: "Title" });
  assert.deepEqual(splitPair("homepage: https://a.example/x"), { key: "homepage", value: "https://a.example/x" });
  assert.equal(splitPair("no separator here"), null);
});

test("a URL's // is not a comment, a spaced // is", () => {
  const [n] = readTree("homepage: &https://a.example/x  // note");
  assert.equal(n?.value, "&https://a.example/x");
});

test("details split from the value, and lists split outside quotes and brackets", () => {
  const p = readPiece('15 [region: UK, origin: declared, via: L-4]');
  assert.equal(p.text, "15");
  assert.deepEqual(p.detail.map(([k]) => k), ["region", "origin", "via"]);
  assert.deepEqual(readList('"Blu-ray, 3D", DVD [region: "A, B"]').map((x) => x.text), ["Blu-ray, 3D", "DVD"]);
});

test("the printer quotes exactly what rule 2.5 says", () => {
  for (const t of ["_", "-x", "&x", "a, b", "a: b", " lead", "", "n/a", "line\nbreak"]) assert.ok(needsQuotes(t), t);
  for (const t of ["Comedy", "-3", "2.50", "PG-13", "Star Wars"]) assert.ok(!needsQuotes(t), t);
});

test("money, quantities and yes-no read by the facet", () => {
  const w = readText("owner: t.example\nproduct: P-1\n  price: 12.50USD\n  runtime: 97 min\n  sealed: no\n", dict);
  assert.deepEqual(w.records[0]?.values, {
    price: { $money: "12.50", currency: "USD" },
    runtime: { $qty: "97", unit: "min" },
    sealed: false,
  });
});

test("text that looks like a mark survives a round trip", () => {
  const src = 'owner: t.example\nproduct: P-1\n  title: "_"\n  genres: "Comedy, Drama", Comedy\n';
  const w = readText(src, dict);
  assert.equal(canonical(readText(printText(w, dict), dict), dict), canonical(w, dict));
  assert.equal(w.records[0]?.values.title, "_");
});

test("a minted row key is required where there is no identity", () => {
  assert.throws(
    () => readText("owner: t.example\nproduct: P-1\n  tracks:\n    - language: English\n", dict),
    (e: unknown) => e instanceof CrubalError && e.line === 4,
  );
});

test("an unknown key keeps its exact text", () => {
  const w = readText("owner: t.example\nproduct: P-1\n  market:Features: a, b [x]\n", emptyDictionaryWithProduct());
  assert.equal(w.records[0]?.values["market:Features"], "a, b [x]");
});

function emptyDictionaryWithProduct() {
  const d = emptyDictionary();
  d.levels.set("product", "item");
  return d;
}

test("the JSON form refuses what the spec forbids (3, 3.2): null anywhere, an unknown record member, a missing required one", () => {
  const ok = { crubal: "2", records: [{ id: "P-1", kind: "item", level: "product", owner: "test.example", values: { title: "x" } }] };
  checkWrapper(ok as never);
  assert.throws(() => checkWrapper({ ...ok, records: [{ ...ok.records[0], extra: 1 }] } as never), /unknown member extra/);
  assert.throws(() => checkWrapper({ ...ok, records: [{ ...ok.records[0], values: { title: null } }] } as never), /null/);
  assert.throws(() => checkWrapper({ ...ok, records: [{ id: "P-1", kind: "item", level: "product", values: {} }] } as never), /needs owner/);
});

test("JSON text naming a member twice is refused (3), wherever the object sits; a string that looks like one is not", () => {
  assert.throws(() => parseJson('{"crubal": "2", "crubal": "2", "records": []}'), /member crubal twice in the object at \$:/);
  assert.throws(() => parseJson('{"crubal": "2", "records": [{"id": "P-1", "values": {"title": "a", "title": "b"}}]}'), /member title twice in the object at \$\.records\[0\]\.values/);
  assert.throws(() => parseJson('{"a": 1, "\\u0061": 2}'), /member a twice/); // the same name, escaped
  assert.deepEqual(parseJson('{"a": "{\\"x\\": 1, \\"x\\": 2}", "b": ["x", "x"]}'), { a: '{"x": 1, "x": 2}', b: ["x", "x"] });
  assert.deepEqual(parseJson('[{"a": 1}, {"a": 2}]'), [{ a: 1 }, { a: 2 }]); // the same name in two objects is fine
  assert.throws(() => parseJson('{"a": '), SyntaxError); // malformed text is still JSON.parse's to refuse
});

test("a source address that names nothing in values or parts is refused (3.7)", () => {
  const d = emptyDictionary();
  readDefinitions(`kind: item\n  levels: product\ntitle$\ngenres{Comedy|Drama|...}*\nrating$*\n  region$\ncast*\n  person -> person\n  character$\ntracks*\n  title$\n  language$`, d);
  const r = {
    id: "P-1", kind: "item", level: "product", owner: "test.example",
    values: {
      title: "x",
      genres: ["Comedy", "Drama"],
      rating: [{ $value: "15", region: "UK" }],
      cast: [{ person: { $link: "wd:Q229048" }, character: "Neo" }],
      tracks: [{ $row: "t3", title: "Intro", language: "en" }],
    },
    parts: [{ $row: "disc1", wears: ["Disc"], values: { condition: "good" } }],
  };
  const ok = (address: string) => assert.equal(addressNames(r as never, address, d), true, address);
  const no = (address: string) => assert.equal(addressNames(r as never, address, d), false, address);
  for (const a of ["*", "title", "genres", 'genres["Drama"]', 'rating["15 [region: UK]"]', "cast[wd:Q229048]", "cast[wd:Q229048].character", "tracks[t3].language", "parts[disc1]", "parts[disc1].condition"]) ok(a);
  for (const a of ["runtime", 'genres["Holiday"]', 'rating["15"]', "cast[wd:Q1]", "cast[wd:Q229048].role", "tracks[t9]", "parts", "parts[disc2]", "parts[disc1].title", "title[x]", "unit::condition", "", "genres[", 'genres["x"]y']) no(a);
  // Without the dictionary a quoted selector is matched by the item's core value.
  assert.equal(addressNames(r as never, 'rating["15 [region: UK]"]'), true);
  assert.equal(addressNames(r as never, 'genres["Holiday"]'), false);
  const w = { crubal: "2", records: [{ ...r, sources: { "*": { origin: "declared", via: "L-1" }, title: { origin: "observed", via: "L-2" } } }] };
  checkWrapper(w as never, d);
  assert.throws(() => checkWrapper({ ...w, records: [{ ...r, sources: { runtime: { origin: "observed", via: "L-2" } } }] } as never, d), /records\[0\]\.sources: runtime names nothing in values or parts/);
});
