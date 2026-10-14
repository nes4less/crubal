import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkRecipe, readRecipes, restamp } from "../src/migrate.ts";
import { entryHash, fieldPath, land, readContracts, receive, verifyChain } from "../src/store.ts";
import { CrubalError } from "../src/tree.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
title$
format{DVD|Blu-ray}
runtime#min accepts: h
`);
const rec = { id: "P-1", kind: "item", level: "product", owner: "t", values: {}, sources: { "*": { origin: "declared", via: "L-1" } } };

test("a chain verifies, and a changed entry breaks the next link", () => {
  const a = { log: "L-1", writes: [] };
  const b = { log: "L-2", prev: `sha256:${entryHash(a)}`, writes: [] };
  assert.deepEqual(verifyChain([a, b]), { valid: true });
  assert.deepEqual(verifyChain([{ ...a, writes: [{ x: "1" }] }, b]), { valid: false, "breaks-at": "L-2" });
});

test("a signature is not part of an entry's hash", () => {
  assert.equal(entryHash({ log: "L-1", sig: "abc" }), entryHash({ log: "L-1" }));
});

test("field paths split on dots outside quotes", () => {
  assert.deepEqual(fieldPath('aspects."Run Time"'), ["aspects", "Run Time"]);
});

test("receive: maps, value maps, ignore, keep-raw and unknowns, and the bytes are kept", () => {
  const [c] = readContracts(`
contract: look
  kind: receive
  prefix: m
  reads:
    Fmt -> format
      "Blu-ray Disc" -> Blu-ray
    Len -> runtime
  ignore: Junk
  keep-raw: Studio
`);
  const body = '{"Fmt":"Blu-ray Disc","Len":"2 hours","Junk":1,"Studio":"W","Other":"x"}';
  const i = receive(c!, body, "P-1", dict);
  const by = Object.fromEntries(i.outcomes.map((o) => [o.from, o]));
  assert.equal(by.Fmt?.value, "Blu-ray");
  assert.equal(by.Fmt?.outcome, "absorbed");
  assert.deepEqual(by.Len?.value, { $qty: "120", unit: "min" });
  assert.equal(by.Junk?.outcome, "ignored");
  assert.equal(by.Studio?.to, "m:Studio");
  assert.equal(by.Other?.outcome, "unknown");
  assert.equal(i.raw.body, body);
});

test("the trust order keeps a person's value and keeps the loser", () => {
  const withTitle = { ...rec, values: { title: "Mine" } };
  const out = land(withTitle, { outcomes: [{ from: "T", to: "title", outcome: "absorbed", value: "Theirs" }] }, { origin: "reported", via: "L-2" });
  assert.equal(out.values.title, "Mine");
  assert.deepEqual((out as unknown as { alternatives: unknown }).alternatives, { title: [{ value: "Theirs", origin: "reported", via: "L-2" }] });
});

test("a recipe into a value the new version lacks is refused at its line", () => {
  const [r] = readRecipes("migration: t /1 -> t /2\n  facet: format\n    merge: DVD9 -> HD-DVD\n");
  assert.throws(() => checkRecipe(r!, dict), (e: unknown) => e instanceof CrubalError && e.line === 3);
});

test("a split with no deciding branch and no else goes to review, held", () => {
  const [r] = readRecipes("migration: t /1 -> t /2\n  facet: format\n    split: DVD\n      when: title is X -> Blu-ray\n");
  const out = restamp([{ ...rec, values: { format: "DVD" } }], r!, dict);
  assert.equal(out.records[0]?.values.format, "DVD");
  assert.equal(out.review.length, 1);
});
