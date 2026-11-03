// The photo slots an image facet fills (5.3.3, revision 19): one or several on a class line, in order, read and
// carried through the bundle and back; a single slot reads as before; a frame on a non-image facet is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleOf, parsePackage, printBundle, readBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";
import { readDefinitions } from "../src/defs.ts";
import { checkPackage } from "../src/dictionary.ts";

const pkg = (line: string) => `package: shots /2026-11-03
  owner: lab.example
  crubal: 2

kind: thing
  levels: thing
  base: Thing

name$
images^*

class: Thing
  label: Thing
  for: thing
  facets:
    name
    ${line}
`;

test("an image line names its slots in order; one slot reads as before", () => {
  const many = readDefinitions(pkg("images frame: front, back, spine")).classes.get("Thing");
  assert.equal(many?.lines.find((l) => l.facet === "images")?.frame, "front, back, spine");
  const one = readDefinitions(pkg("images frame: front")).classes.get("Thing");
  assert.equal(one?.lines.find((l) => l.facet === "images")?.frame, "front");
});

test("the slots ride the bundle and back", () => {
  const b = bundleOf(parsePackage(pkg("images frame: front, back, spine")));
  assert.match(printBundle(b), /images frame: front, back, spine/);
  assert.equal(serialize(bundleOf(readBundle(b))), serialize(b));
});

test("a frame on a facet that isn't an image is refused", () => {
  assert.throws(() => checkPackage(readDefinitions(pkg("name frame: front"))), /isn't an image/);
});
