// Cutting a version (docs/design/publishing.md): unchanged members keep their version, changed ones take
// the date, a breaking change needs a recipe, a recipe with nothing broken is refused, and the hash and
// signature hold.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { verifyBundle } from "../src/bundle.ts";
import { classify, publish } from "../src/publish.ts";
import { CrubalError } from "../src/tree.ts";

const base = `package: shop /2026-10-01
  owner: shop.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
title$
format{DVD|Blu-ray}
runtime#min 1..600

class: Item
  for: item
  facets:
    !title
    format
`;

test("the first version dates every member and hashes the bundle", () => {
  const { bundle, changes } = publish(base, { date: "2026-10-01" });
  assert.equal(bundle.version, "2026-10-01");
  assert.deepEqual(bundle.members, { "kind:item": "2026-10-01", "facet:title": "2026-10-01", "facet:format": "2026-10-01", "facet:runtime": "2026-10-01", "class:Item": "2026-10-01" });
  assert.ok(changes.every((c) => c.kind === "new"));
  assert.equal(verifyBundle(bundle).valid, true);
});

test("an unchanged member keeps its version; a safe change takes the date; a second cut that day is .2", () => {
  const { bundle: v1 } = publish(base, { date: "2026-10-01" });
  const { bundle: v2, changes } = publish(base.replace("title$", "title$ ~name"), { previous: v1, date: "2026-11-01" });
  assert.equal(v2.version, "2026-11-01");
  assert.equal((v2.members as { [k: string]: string })["facet:title"], "2026-11-01");
  assert.equal((v2.members as { [k: string]: string })["facet:format"], "2026-10-01");
  assert.equal(changes.find((c) => c.member === "facet:title")?.kind, "safe");
  assert.equal(v2.previous, "2026-10-01");
  const { bundle: v3 } = publish(base.replace("title$", "title$ ~name ~heading"), { previous: v2, date: "2026-11-01" });
  assert.equal(v3.version, "2026-11-01.2");
});

test("a breaking change without a recipe is refused, and lands with one", () => {
  const { bundle: v1 } = publish(base, { date: "2026-10-01" });
  const narrowed = base.replace("format{DVD|Blu-ray}", "format{DVD}");
  assert.throws(() => publish(narrowed, { previous: v1, date: "2026-11-01" }), (e: unknown) => e instanceof CrubalError && /facet:format is a breaking change \(value removed: Blu-ray\)/.test(e.message));
  const withRecipe = `${narrowed}
migration: shop /2026-10-01 -> shop /2026-11-01
  facet: format
    merge: Blu-ray -> DVD
`;
  const { bundle: v2, changes } = publish(withRecipe, { previous: v1, date: "2026-11-01" });
  assert.equal(changes.find((c) => c.member === "facet:format")?.kind, "breaking");
  assert.equal(((v2.recipes as { migration: { to: string } }[])[0] as { migration: { to: string } }).migration.to, "shop /2026-11-01");
});

test("a recipe with nothing broken is refused", () => {
  const { bundle: v1 } = publish(base, { date: "2026-10-01" });
  const pointless = `${base}
migration: shop /2026-10-01 -> shop /2026-11-01
  facet: format
    rename: DVD -> DVD
`;
  assert.throws(() => publish(pointless, { previous: v1, date: "2026-11-01" }), /nothing broke/);
});

test("the classifier follows 4.8 and 5.11", () => {
  const { bundle: v1 } = publish(base, { date: "2026-10-01" });
  const cases: [string, string, string][] = [
    ["runtime#min 1..600", "runtime#min 1..1000", "safe"],
    ["runtime#min 1..600", "runtime#min 1..300", "breaking"],
    ["runtime#min 1..600", "runtime#h 1..600", "breaking"],
    ["format{DVD|Blu-ray}", "format{DVD|Blu-ray|4K}", "safe"],
    ["format{DVD|Blu-ray}", "format{DVD|Blu-ray|...}", "safe"],
    ["format{DVD|Blu-ray}", "format{DVD|Blu-ray} fixed", "breaking"],
    ["title$", "title$80", "breaking"],
    ["    format\n", "    !format\n", "breaking"],
    ["    !title\n    format\n", "    format\n    !title\n", "safe"],
  ];
  for (const [from, to, want] of cases) {
    const { bundle } = publish(base.replace(from, to), { date: "2026-11-01" });
    const changed = classify(v1, bundle).filter((c) => c.kind !== "unchanged" && c.kind !== "new");
    assert.ok(changed.length, `${to}: nothing classified`);
    const worst = changed.some((c) => c.kind === "breaking" || c.kind === "retired") ? "breaking" : changed.some((c) => c.kind === "minor") ? "minor" : "safe";
    assert.equal(worst, want, `${from} → ${to}: ${changed.map((c) => `${c.member} ${c.kind} (${c.why.join("; ")})`).join(", ")}`);
  }
});

test("a signed version verifies and a changed one doesn't", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = privateKey.export({ format: "jwk" }).d as string;
  const x = publicKey.export({ format: "jwk" }).x as string;
  const { bundle } = publish(base, { date: "2026-10-01", key: { d, x } });
  const keys = { "shop.example": { alg: "Ed25519", public: x } };
  assert.deepEqual(verifyBundle(bundle, keys), { valid: true });
  assert.equal(verifyBundle({ ...bundle, version: "2026-10-02" }, keys).valid, false);
});
