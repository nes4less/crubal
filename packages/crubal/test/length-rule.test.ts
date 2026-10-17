// The `length` shortcut (4.4) is a should rule over the text's length in characters: a value within it is
// never flagged, one over it is. Found by a three-letter name flagged "length" against a limit of 200.

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parseCondition } from "../src/conditions.ts";
import { readDefinitions } from "../src/defs.ts";
import { Exchange } from "../src/exchange.ts";
import { readContracts } from "../src/store.ts";

test("over and under on text compare its length in characters; on numbers, the number", () => {
  assert.equal(evaluate(parseCondition("name under 201"), { name: "Pat" }), true);
  assert.equal(evaluate(parseCondition("name over 5"), { name: "Pat" }), false);
  assert.equal(evaluate(parseCondition("name over 5"), { name: "Patrick" }), true);
  assert.equal(evaluate(parseCondition("runtime under 100"), { runtime: "97" }), true);
  assert.equal(evaluate(parseCondition("runtime over 100"), { runtime: "97" }), false);
});

test("a form write within a facet's length is not flagged; one over it is", () => {
  const dict = readDefinitions("kind: person\n  levels: person\nname$200\nhandle$5\n");
  const ex = new Exchange(dict, readContracts("contract: profile\n  kind: form\n  origin: declared\n  needs:\n    name\n    handle\n"), [], []);
  ex.put({ id: "P-1", kind: "person", level: "person", owner: "t", values: {}, sources: {} });
  const ok = ex.receiveRun("profile", "P-1", JSON.stringify({ name: "Pat", handle: "pat" }), "P-1");
  assert.equal((ok.rules as { flagged?: string[] } | undefined)?.flagged, undefined, JSON.stringify(ok.rules));
  const long = ex.receiveRun("profile", "P-1", JSON.stringify({ handle: "patricia" }), "P-1");
  assert.deepEqual((long.rules as { flagged?: string[] }).flagged, ["handle: length"]);
});
