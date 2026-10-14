import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCorpus } from "../src/index.ts";

const corpus = fileURLToPath(new URL("../../../corpus", import.meta.url));

for (const level of ["reader", "dictionary", "rules", "store", "exchange"]) {
  test(`the implementation passes the ${level} corpus`, () => {
    const results = runCorpus(corpus, level);
    const failed = results.filter((r) => !r.pass);
    assert.equal(failed.length, 0, failed.map((r) => `${r.folder}/${r.name}: ${r.detail}`).join("\n"));
    assert.ok(results.length > 0);
  });
}
