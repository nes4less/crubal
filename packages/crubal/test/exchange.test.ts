import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { checkContracts, Exchange } from "../src/exchange.ts";
import { checkPackages } from "../src/packages.ts";
import { readContracts } from "../src/store.ts";
import { CrubalError } from "../src/tree.ts";

const dict = readDefinitions(`
kind: item
  levels: product, unit
title$
format{DVD|Blu-ray~BD}
`);
const rec = { id: "P-1", kind: "item", level: "product", owner: "t", values: { title: "A", format: "Blu-ray" } };

test("map out builds nested payloads, applies value maps and literals", () => {
  const cs = readContracts(`
contract: send1
  kind: send
  writes:
    title -> item."Full Title"
    format -> item.fmt
      Blu-ray -> BD-50
    "USD" -> currency
`);
  checkContracts(cs, dict);
  const ex = new Exchange(dict, cs);
  ex.put(rec);
  const r = ex.run("send1", "P-1");
  assert.deepEqual(r.payload, { item: { "Full Title": "A", fmt: "BD-50" }, currency: "USD" });
});

test("a credential is a name, never a secret", () => {
  const cs = readContracts("contract: s\n  kind: send\n  credential: sk_live 4f9a=+/\n");
  assert.throws(() => checkContracts(cs, dict), (e: unknown) => e instanceof CrubalError && e.line === 3);
});

test("a part a contract's kind doesn't allow is refused", () => {
  const cs = readContracts("contract: s\n  kind: send\n  keep-raw: X\n  prefix: m\n");
  assert.throws(() => checkContracts(cs, dict), CrubalError);
});

test("a receive answer that disagrees with the record is a conflict, and lands by trust", () => {
  const cs = readContracts("contract: look\n  kind: receive\n  reads:\n    T -> title\n");
  const ex = new Exchange(dict, cs);
  ex.put({ ...rec, sources: { "*": { origin: "declared", via: "L-1" } } });
  const r = ex.receiveRun("look", "P-1", '{"T":"B"}');
  assert.equal((r.outcomes as { outcome: string }[])[0]?.outcome, "conflict");
  assert.equal(ex.get("P-1")?.values.title, "A");
});

test("an extending package may add values but not change a type", () => {
  checkPackages("package: base /1\n  owner: b.example\nformat{DVD}\n\npackage: mine /1\n  owner: m.example\n  extends: base /1\nfacet: base:format\n  type: choice\n  values: DVD, LP\n");
  assert.throws(
    () => checkPackages("package: base /1\n  owner: b.example\nformat{DVD}\n\npackage: mine /1\n  owner: m.example\n  extends: base /1\nfacet: base:format\n  type: text\n"),
    (e: unknown) => e instanceof CrubalError && e.line === 8,
  );
});
