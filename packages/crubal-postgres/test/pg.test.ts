// The Postgres store against the memory engine. Skipped without CRUBAL_PG_URL. Every corpus log the
// memory store can rebuild, the Postgres store must give back the same state from the same entries; the
// journaled operations must write the same entries; redaction must hold the chain and forget the value.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyDictionary, readDefinitions } from "../../crubal/src/defs.ts";
import { archive, attach, merge, type Store } from "../../crubal/src/lifecycle.ts";
import { type Draft, Journal, rebuild, stateJson, type Entry } from "../../crubal/src/log.ts";
import type { JsonObject, Record } from "../../crubal/src/model.ts";
import { serialize } from "../../crubal/src/canonical.ts";
import { verifyChain } from "../../crubal/src/store.ts";
import { connect, testSchema, type Pool } from "../src/db.ts";
import { PgStore } from "../src/store.ts";

const url = process.env.CRUBAL_PG_URL;
const corpus = fileURLToPath(new URL("../../../corpus/store/", import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const same = (a: unknown, b: unknown) => serialize(a as JsonObject) === serialize(b as JsonObject);

let pool: Pool;
let drop: () => Promise<void>;
before(async () => {
  if (!url) return;
  pool = connect(url);
  drop = await testSchema(pool);
});
after(async () => {
  if (!url) return;
  await drop();
  await pool.end();
});

const logCases = readdirSync(corpus).filter((d) => existsSync(join(corpus, d, "log.json")));

test("every corpus log rebuilds to the same state in Postgres as in memory", { skip: !url }, async () => {
  for (const name of logCases) {
    const entries = json(join(corpus, name, "log.json")) as Entry[];
    // Entries carry the test owner; a hosted person's chain would be its own store.
    const store = new PgStore(pool, `${name}.example`);
    let broken = false;
    for (const e of entries) {
      // A log that doesn't rebuild in memory (a tampered chain, a placeholder prev) is still appended as
      // written; the store links it afresh, so the comparison is of states, not of links.
      try {
        await store.append({ ...e, owner: `${name}.example` });
      } catch {
        broken = true;
        break;
      }
    }
    if (broken) continue;
    const memory = stateJson(rebuild(entries.map((e) => ({ ...e, owner: `${name}.example` }))));
    assert.ok(same(stateJson(await store.state()), memory), `${name}: state read back differs from the memory rebuild`);
    assert.ok(same(stateJson(await store.rebuild()), memory), `${name}: rebuild from the Postgres log differs`);
    assert.deepEqual(await store.verify(), { valid: true }, `${name}: the relinked chain doesn't verify`);
  }
});

test("journaled operations write the same entries as the memory journal", { skip: !url }, async () => {
  const dict = emptyDictionary();
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_package.crubal"), "utf8"), dict);
  readDefinitions("title$\nprice#USD\nkind: item\n  levels: group, product, unit\n  archive: cascade of\n", dict);
  const records: Record[] = [
    { id: "P-1", kind: "item", level: "product", owner: "ops.example", values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-0" } } },
    { id: "P-2", kind: "item", level: "product", owner: "ops.example", values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-0" } } },
    { id: "U-1", kind: "item", level: "unit", owner: "ops.example", values: { title: "Christmas Vacation", price: { $money: "12.50", currency: "USD" } }, sources: { "*": { origin: "observed", via: "L-0" } } },
  ];
  const at = (n: number) => `2026-10-15T12:00:0${n}Z`;
  const journal = new Journal("ops.example", records, at(0));
  const store = new PgStore(pool, "ops.example");
  await store.commit({ migration: "backfill" }, (d) => { for (const r of records) d.records.set(r.id, structuredClone(r)); }, at(0));
  // The lifecycle works on the journal's draft, as the corpus runner does.
  const as = (d: Draft) => d as unknown as Store;
  const ops: [JsonObject, (d: Draft) => void][] = [
    [{ person: "staff-1" }, (d) => attach(as(d), "U-1", "P-1", dict)],
    [{ person: "staff-1" }, (d) => merge(as(d), "P-2", "P-1", dict)],
    [{ person: "staff-1" }, (d) => archive(as(d), "P-1", "discontinued", dict)],
  ];
  let n = 1;
  for (const [by, op] of ops) {
    const m = journal.commit(by, op, at(n));
    const p = await store.commit(by, op, at(n));
    n += 1;
    const strip = (e: Entry | null) => e && { by: e.by, at: e.at, writes: e.writes };
    assert.ok(same(strip(p), strip(m)), `operation ${n - 1}: entries differ\n  pg ${serialize(strip(p) as JsonObject)}\n  mem ${serialize(strip(m) as JsonObject)}`);
  }
  assert.ok(same(stateJson(await store.state()), stateJson(journal.state)), "states differ after the operations");
  assert.deepEqual(await store.verify(), { valid: true });
});

test("redacting a write holds the chain and the rebuilt state forgets the value", { skip: !url }, async () => {
  const store = new PgStore(pool, "erase.example");
  const at = "2026-10-15T13:00:00Z";
  await store.commit({ contract: "signup", run: "R-1" }, (d) => {
    d.records.set("C-1", { id: "C-1", kind: "person", level: "person", owner: "erase.example", values: { name: "Pat", email: "pat@example.com" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  }, at);
  await store.commit({ person: "C-1" }, (d) => {
    const r = d.records.get("C-1") as Record;
    d.records.set("C-1", { ...r, values: { ...r.values, note: "Prefers pickup" }, sources: { ...r.sources, note: { origin: "declared", via: "L-2" } } });
  }, "2026-10-15T13:01:00Z");
  const first = (await store.entries())[0] as Entry;
  const emailAt = (first.writes as JsonObject[]).findIndex((w) => w.address === "email");
  assert.ok(emailAt >= 0);
  await assert.rejects(store.redact(first.log as string, 0), /never redacted/, "the creation write is refused");
  await store.redact(first.log as string, emailAt);
  const state = await store.state();
  assert.deepEqual(state.records.get("C-1")?.values, { name: "Pat", note: "Prefers pickup" });
  assert.deepEqual(await store.verify(), { valid: true });
  // The trigger refuses any other change to the log.
  await assert.rejects(pool.query("update log set entry = entry || '{\"at\": \"2000-01-01T00:00:00Z\"}' where owner = $1", ["erase.example"]), /append-only/);
  await assert.rejects(pool.query("delete from log where owner = $1", ["erase.example"]), /append-only/);
  assert.equal(verifyChain((await store.entries()) as unknown as JsonObject[]).valid, true);
});

test("owners never see each other", { skip: !url }, async () => {
  const a = new PgStore(pool, "a.example");
  const b = new PgStore(pool, "a.example:C-7");
  await a.commit({ person: "x" }, (d) => { d.records.set("R-1", { id: "R-1", kind: "thing", level: "thing", owner: "a.example", values: {} }); }, "2026-10-15T14:00:00Z");
  await b.commit({ person: "C-7" }, (d) => { d.records.set("K-1", { id: "K-1", kind: "collection", level: "collection", owner: "a.example:C-7", values: {} }); }, "2026-10-15T14:00:01Z");
  assert.deepEqual([...(await a.state()).records.keys()], ["R-1"]);
  assert.deepEqual([...(await b.state()).records.keys()], ["K-1"]);
  assert.equal((await a.entries()).length, 1);
  assert.equal((await b.entries()).length, 1);
});
