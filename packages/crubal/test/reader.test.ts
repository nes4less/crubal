import assert from "node:assert/strict";
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
