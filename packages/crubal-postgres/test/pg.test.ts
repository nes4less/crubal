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
import { foldRecord } from "../../crubal/src/dictionary.ts";
import { readText } from "../../crubal/src/read-text.ts";
import { readViews, Views } from "../../crubal/src/views.ts";
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

test("an operation loads only what it touches", { skip: !url }, async () => {
  const dict = emptyDictionary();
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_package.crubal"), "utf8"), dict);
  readDefinitions("title$\nkind: item\n  levels: group, product, unit\n", dict);
  const store = new PgStore(pool, "many.example");
  const owner = "many.example";
  await store.commit({ migration: "backfill" }, (d) => {
    for (let i = 1; i <= 60; i++) d.records.set(`P-${i}`, { id: `P-${i}`, kind: "item", level: "product", owner, values: { title: `Title ${i}` }, sources: { "*": { origin: "declared", via: "L-0" } } });
    d.records.set("U-1", { id: "U-1", kind: "item", level: "unit", owner, values: { title: "Title 7" }, sources: { "*": { origin: "observed", via: "L-0" } } });
  }, "2026-10-15T15:00:00Z");
  await store.commit({ person: "staff-1" }, (d) => attach(d as unknown as Store, "U-1", "P-7", dict), "2026-10-15T15:00:01Z");
  const loaded = [...(store.trace?.loaded ?? [])];
  assert.ok(loaded.length < 10, `attach loaded ${loaded.length} records: ${loaded.join(", ")}`);
  assert.ok(loaded.includes("U-1") && loaded.includes("P-7"));
  assert.equal((await store.state()).records.get("U-1")?.of, "P-7");
  assert.deepEqual((await store.state()).records.get("U-1")?.values, {}, "the shared title folded up and is read through");
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

test("projections and the stream match the memory views, rebuilding only stale rows", { skip: !url }, async () => {
  const viewsDir = join(corpus, "..", "views");
  const dict = emptyDictionary();
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_package.crubal"), "utf8"), dict);
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_facets.crubal"), "utf8"), dict);
  const viewText = readFileSync(join(viewsDir, "_views.crubal"), "utf8");
  readDefinitions(viewText, dict);
  const set = readViews(viewText);
  const records = readText(readFileSync(join(viewsDir, "_records.crubal"), "utf8"), dict).records.map((r) => foldRecord(r, dict));
  const owner = "views.example";
  const own = (r: Record): Record => ({ ...r, owner });
  const store = new PgStore(pool, owner, { projecting: { dict, views: set } });
  await store.commit({ migration: "backfill" }, (d) => { for (const r of records) d.records.set(r.id, own(structuredClone(r))); }, "2026-10-15T16:00:00Z");
  const memory = new Views(dict, set);
  for (const r of records) memory.put(own(r));

  const first = await store.project("discs");
  assert.ok(same(first, memory.stream("discs")), `first publish differs:\n pg  ${serialize(first as unknown as JsonObject)}\n mem ${serialize(memory.stream("discs") as unknown as JsonObject)}`);

  // The write of views/010-stream: a new title for P-1, and P-5 gets the title that puts it in the view.
  const write = readText(readFileSync(join(viewsDir, "010-stream", "write.crubal"), "utf8"), dict).records;
  await store.commit({ person: "staff-1" }, (d) => {
    for (const w of write) {
      const was = d.records.get(w.id) as Record;
      d.records.set(w.id, { ...was, values: { ...was.values, ...w.values }, sources: { ...was.sources, ...Object.fromEntries(Object.keys(w.values).map((k) => [k, { origin: "declared", via: "L-9" }])) } });
    }
  }, "2026-10-15T16:00:01Z");
  const stale = (await pool.query("select record from stale where owner = $1 and view = 'discs' order by record", [owner])).rows.map((r: { record: string }) => r.record);
  assert.deepEqual(stale, ["P-1", "P-5"], "only the written records are marked stale");
  for (const w of write) {
    const was = records.find((r) => r.id === w.id) as Record;
    memory.put(own({ ...was, values: { ...was.values, ...w.values } }));
  }
  const second = await store.project("discs");
  const wantSecond = memory.stream("discs");
  assert.ok(same(second, wantSecond), `second publish differs:\n pg  ${serialize(second as unknown as JsonObject)}\n mem ${serialize(wantSecond as unknown as JsonObject)}`);
  assert.equal((await pool.query("select count(*)::int as n from stale where owner = $1", [owner])).rows[0].n, 0, "the marks are cleared");
  assert.ok(same(await store.entriesSince("discs", first.length), second), "an index resuming from its cursor gets the second batch");

  // Erasure (views/013): P-1 loses its title, the required slot, so its row leaves the view.
  await store.commit({ person: "staff-1" }, (d) => {
    const was = d.records.get("P-1") as Record;
    d.records.set("P-1", { ...was, values: { ...was.values, title: { $empty: "unknown" } } });
  }, "2026-10-15T16:00:02Z");
  const third = await store.project("discs");
  assert.deepEqual(third, [{ projection: "discs", audience: "public", seq: first.length + second.length + 1, record: "P-1", removed: true }]);
  assert.equal((await pool.query("select count(*)::int as n from projections where owner = $1 and record = 'P-1'", [owner])).rows[0].n, 0);
});
