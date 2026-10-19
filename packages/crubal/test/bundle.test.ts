// A bundle round-trips: text → JSON → text → JSON gives the same document, for every standard package and
// every shared definition file of the corpus; and a signed bundle verifies, a tampered one doesn't.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleOf, emptyParsed, parsePackage, printBundle, readBundle, readBundleOnto, signBundle, verifyBundle } from "../src/bundle.ts";
import { serialize } from "../src/canonical.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

const roundTrip = (source: string, label: string) => {
  const first = bundleOf(parsePackage(source));
  const text = printBundle(first);
  let again: ReturnType<typeof readBundle>;
  try {
    again = readBundle(first);
  } catch (e) {
    throw new Error(`${label}: the printed text doesn't read back: ${e instanceof Error ? e.message : e}\n${text}`);
  }
  const second = bundleOf(again);
  if (serialize(first) !== serialize(second)) {
    const a = serialize(first);
    const b = serialize(second);
    let i = 0;
    while (a[i] === b[i]) i++;
    throw new Error(`${label}: round trip differs at ${i}:\n  first  …${a.slice(Math.max(0, i - 120), i + 160)}\n  second …${b.slice(Math.max(0, i - 120), i + 160)}`);
  }
  return first;
};

for (const name of ["core", "units", "party"]) {
  test(`the standard package ${name} round-trips through its bundle`, () => {
    const b = roundTrip(read(`std/${name}/package.crubal`), name);
    assert.equal(b.id, `crubal.com/${name}`);
  });
}

test("the corpus's shared definitions round-trip, under one header", () => {
  const dir = join(root, "corpus");
  const shared = readdirSync(dir).flatMap((folder) => {
    const f = join(dir, folder);
    return existsSync(f) && statSync(f).isDirectory() ? readdirSync(f).filter((n) => n.startsWith("_") && n.endsWith(".crubal") && n !== "_records.crubal" && n !== "_keys.json").map((n) => join(folder, n)) : [];
  });
  assert.ok(shared.length > 5);
  for (const rel of shared) {
    const text = read(join("corpus", rel));
    const source = text.startsWith("package:") || /^package: /m.test(text) ? text : `package: test /2026-10-14\n  owner: test.example\n  crubal: 2\n\n${text}`;
    roundTrip(source, rel);
  }
});

test("a bundle verifies with its key and fails when tampered", () => {
  const b = bundleOf(parsePackage(read("std/units/package.crubal")));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = privateKey.export({ format: "jwk" }).d as string;
  const x = publicKey.export({ format: "jwk" }).x as string;
  const signed = signBundle(b, d, x);
  const keys = { "crubal.com": { alg: "Ed25519", public: x } };
  assert.deepEqual(verifyBundle(signed, keys), { valid: true });
  assert.deepEqual(verifyBundle({ ...signed, label: "Tampered" }, keys), { valid: false, reason: "hash" });
  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x as string;
  assert.deepEqual(verifyBundle(signed, { "crubal.com": { alg: "Ed25519", public: other } }), { valid: false, reason: "signature" });
  assert.deepEqual(verifyBundle(signed, {}), { valid: false, reason: "no key" });
});

test("a menu item two packages name is one item with both packages' verbs; a preset of the same name is the later one", () => {
  const a = `package: a.test/a /2026-01-01
permissions: a
  menu:
    people: grant one
    one: edit Thing
  presets:
    helper: one                                      audience: staff
`;
  const b = `package: a.test/b /2026-01-02
permissions: b
  menu:
    people: grant two
    two: run thing
  presets:
    helper: two                                      audience: staff
`;
  const base = emptyParsed();
  readBundleOnto(bundleOf(parsePackage(a)), base);
  readBundleOnto(bundleOf(parsePackage(b)), base);
  assert.deepEqual(base.perms.menu.get("people")?.verbs, { grant: ["one", "two"] });
  assert.deepEqual(base.perms.menu.get("one")?.verbs, { edit: ["Thing"] });
  assert.deepEqual(base.perms.presets.get("helper")?.items, ["two"]);
});
