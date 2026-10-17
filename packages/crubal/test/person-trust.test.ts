// A person's write through a form ranks as `person` in the trust order (11.3): it replaces a value an
// earlier declaration or a contract left, instead of landing as a conflict beside it. A receive contract's
// value of equal origin still keeps the current value.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

const DEFS = `kind: person
  levels: person
name$
timezone$
`;
const CONTRACTS = `contract: profile
  kind: form
  origin: declared
  needs:
    !name
    timezone
contract: directory
  kind: receive
  origin: declared
  reads:
    Name -> name
`;

const fresh = () => {
  const dict = readDefinitions(DEFS);
  const ex = new Exchange(dict, readContracts(CONTRACTS), [], []);
  ex.put({ id: "P-1", kind: "person", level: "person", owner: "test.example", values: { name: "Sam" }, sources: { name: { origin: "declared", via: "L-1" } } });
  return ex;
};

test("a person's form write replaces an earlier declared value", () => {
  const ex = fresh();
  const r = ex.receiveRun("profile", "P-1", JSON.stringify({ name: "Sam Ortiz", timezone: "America/Chicago" }), "P-1");
  assert.equal(r.landed, "value");
  assert.equal(ex.get("P-1")?.values.name, "Sam Ortiz");
  assert.equal(ex.get("P-1")?.values.timezone, "America/Chicago");
});

test("a receive of equal origin keeps the current value as a conflict, as before", () => {
  const ex = fresh();
  ex.receiveRun("directory", "P-1", JSON.stringify({ Name: "Samuel" }));
  assert.equal(ex.get("P-1")?.values.name, "Sam");
  const alts = (ex.get("P-1") as unknown as { alternatives?: { name?: { value: string }[] } }).alternatives?.name ?? [];
  assert.deepEqual(alts.map((a) => a.value), ["Samuel"]);
});

test("a form run with no caller is not a person's write", () => {
  const ex = fresh();
  ex.receiveRun("profile", "P-1", JSON.stringify({ name: "Nobody" }));
  assert.equal(ex.get("P-1")?.values.name, "Sam");
});
