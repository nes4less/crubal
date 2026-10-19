import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkRecipe, readRecipes, restamp } from "../src/migrate.ts";
import { entryHash, fieldPath, land, readContracts, receive, verifyChain } from "../src/store.ts";
import { CrubalError } from "../src/tree.ts";
import { applyEntry, emptyState } from "../src/log.ts";

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
  assert.deepEqual(verifyChain([{ ...a, writes: [{ x: "1" }] }, b]), { valid: false, "breaks-at": "L-2", reason: "link" });
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

import { generateKeyPairSync, sign } from "node:crypto";
import { rawOf, reviewByKey, verifySig } from "../src/store.ts";

test("an Ed25519 signature over the hash bytes verifies; any other doesn't", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = { "a.example": { alg: "Ed25519", public: publicKey.export({ format: "jwk" }).x as string } };
  const entry: { [k: string]: string } = { log: "L-1", owner: "a.example" };
  entry.sig = sign(null, Buffer.from(entryHash(entry), "hex"), privateKey).toString("base64url");
  assert.ok(verifySig(entry, "a.example", keys));
  assert.ok(!verifySig({ ...entry, log: "L-2" }, "a.example", keys));
  assert.deepEqual(verifyChain([{ log: "L-1", owner: "a.example" }], keys), { valid: false, "breaks-at": "L-1", reason: "signature" });
});

test("raw bytes: UTF-8 stays text, anything else is base64, hashed as bytes", () => {
  assert.equal(rawOf(new TextEncoder().encode("été"), "text/plain").body, "été");
  const latin1 = rawOf(Uint8Array.from([0xe9, 0x74, 0xe9]), "text/plain");
  assert.equal(latin1.base64, "6XTp");
  assert.equal(latin1.body, undefined);
});

test("review by key proposes only unknown keys over the threshold", () => {
  const intakes = [1, 2, 3].map((n) => ({ for: `P-${n}`, outcomes: [{ from: "S", to: "m:S", outcome: "unknown", value: "x" }, { from: "F", to: "format", outcome: "new", value: "LP" }] }));
  const r = reviewByKey(intakes, 3);
  assert.deepEqual(r.proposals, [{ key: "m:S", objects: 3, state: "candidate" }]);
});

test("a define of a filter is filed as a filter, never as the facet it names (G11)", () => {
  const state = emptyState();
  applyEntry(state, { log: "L-1", writes: [{ define: { facet: "shelf", type: "choice", values: [{ value: "A" }] } }, { define: { filter: "byShelf", facet: "shelf" } }] } as never);
  assert.deepEqual([...state.definitions.keys()].sort(), ["facet:shelf", "filter:byShelf"]);
});

test("transitions: a state facet takes a later value of equal trust as a move, not a conflict; without the setting it conflicts (4.2)", () => {
  const r = { id: "O-1", kind: "order", level: "order", owner: "o", values: { orderState: "paid" }, sources: { orderState: { origin: "declared", via: "L-1" } } } as never;
  const outcomes = [{ from: "orderState", to: "orderState", outcome: "conflict", value: "shipped" }] as never;
  const moved = land(r, { outcomes, person: true }, { origin: "declared", via: "L-2" }, undefined, undefined, new Set(["orderState"])) as { values: { orderState: string }; alternatives?: object };
  assert.equal(moved.values.orderState, "shipped");
  assert.equal(moved.alternatives, undefined);
  const disputed = land(r, { outcomes, person: true }, { origin: "declared", via: "L-2" }) as { values: { orderState: string }; alternatives?: { orderState?: unknown[] } };
  assert.equal(disputed.values.orderState, "paid", "equal trust keeps the current value");
  assert.equal(disputed.alternatives?.orderState?.length, 1, "and the later one is an alternative");
});
