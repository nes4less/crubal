// Links to definitions (4.2.2, revision 20): a link's `to` may name a sort of definition, `def:facet`, `def:class`
// and the rest; its values hold `def:<sort>:<name>`, a key into the dictionary, never a record. A value of another
// sort is a contradiction; a name the dictionary doesn't hold is kept and flagged; a facet is found through its
// aliases, so a renamed facet keeps its links; an unknown sort is refused when the package is read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { definitionSortOf, readDefinitions } from "../src/defs.ts";
import { checkRecord, checkScalar, resolveDefinition } from "../src/dictionary.ts";

const pkg = (extra = "") => `package: stations /2026-11-04
  owner: lab.example
  crubal: 2

kind: thing
  levels: thing
  base: Thing

name$
title$ aliases: heading
works&def:class*
titleFrom&def:facet
${extra}
class: Thing
  label: Thing
  for: thing
  facets:
    name
    title
    works
    titleFrom
`;

test("a link may name a sort of definition; an unknown sort is refused", () => {
  const d = readDefinitions(pkg());
  assert.equal(definitionSortOf(d.facets.get("works") as never), "class");
  assert.equal(definitionSortOf(d.facets.get("titleFrom") as never), "facet");
  assert.throws(() => readDefinitions(pkg("bad&def:widget")), /definition link names one of/);
  const block = readDefinitions(pkg("facet: pointer\n  type: link\n  to: def:kind\n"));
  assert.equal(block.facets.get("pointer")?.to, "def:kind");
});

test("a definition link's value holds its own sort's key", () => {
  const f = readDefinitions(pkg()).facets.get("titleFrom") as never;
  assert.equal(checkScalar(f, { $link: "def:facet:title" }).outcome, "absorbed");
  assert.equal(checkScalar(f, { $link: "def:class:Thing" }).outcome, "contradiction");
  assert.equal(checkScalar(f, { $link: "def:facet:" }).outcome, "contradiction");
  assert.equal(checkScalar(f, "title").outcome, "contradiction");
});

test("resolved through the dictionary: a facet by its aliases; a name nobody holds flagged on the record", () => {
  const d = readDefinitions(pkg());
  assert.equal(resolveDefinition(d, "def:facet:heading", "facet"), "title");
  assert.equal(resolveDefinition(d, "def:class:Thing", "class"), "Thing");
  assert.equal(resolveDefinition(d, "def:class:Nothing", "class"), undefined);
  const r = {
    id: "T-1",
    kind: "thing",
    level: "thing",
    owner: "lab.example",
    wears: ["Thing"],
    values: { name: "a", works: [{ $link: "def:class:Thing" }, { $link: "def:class:Nothing" }], titleFrom: { $link: "def:facet:heading" } },
  };
  const out = checkRecord(r as never, d).outcomes;
  const flagged = out.filter((o) => o.flag === "unknown").map((o) => o.address);
  assert.equal(flagged.length, 1, JSON.stringify(out));
  assert.match(flagged[0] as string, /Nothing/);
  assert.ok(!out.some((o) => o.outcome === "contradiction"), JSON.stringify(out));
});

test("the target rides the bundle and back", () => {
  const b = bundleOf(parsePackage(pkg()));
  assert.match(printBundle(b), /def:class/);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
});
