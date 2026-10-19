// The Postgres store against the memory engine. Skipped without CRUBAL_PG_URL. Every corpus log the
// memory store can rebuild, the Postgres store must give back the same state from the same entries; the
// journaled operations must write the same entries; redaction must hold the chain and forget the value.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyDictionary, readDefinitions } from "@cruba/crubal";
import { archive, attach, merge, type Store } from "@cruba/crubal";
import { type Draft, Journal, rebuild, stateJson, type Entry } from "@cruba/crubal";
import type { Json, JsonObject, Record } from "@cruba/crubal";
import { MemoryRecords, serialize } from "@cruba/crubal";
import { readContracts, sha256, verifyChain } from "@cruba/crubal";
import { foldRecord } from "@cruba/crubal";
import { readText } from "@cruba/crubal";
import { readViews, type StreamEntry, Views } from "@cruba/crubal";
import { connect, testSchema, type Pool } from "../src/db.ts";
import { publish } from "@cruba/crubal";
import { PgBorder } from "../src/border.ts";
import { Needs, WorkingRecords } from "../src/working.ts";
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

test("a working set answers a narrow question from what it loaded for it, never by asking for the catalog", () => {
  // `is unique` asks byKey on every write; through `all()` that meant every record of the deployment per
  // commit (ME: 22k rows, seconds). The map scans its own rows; the question noted is the narrow one.
  const needs = new Needs();
  const set = new WorkingRecords(needs);
  MemoryRecords.prototype.set.call(set, "U-1", { id: "U-1", kind: "item", level: "unit", owner: "x", values: { sku: "A1" } } as Record);
  assert.deepEqual(set.byKey("sku", "A1", "unit").map((r) => r.id), ["U-1"]);
  assert.deepEqual(set.forTarget("unit").map((r) => r.id), ["U-1"]);
  assert.deepEqual([...needs.pending], ['key:unit:sku:"A1"', "for:unit"]);
  assert.ok(!needs.pending.has("all"));
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

test("the border over the store: intake kept, runs idempotent across transactions", { skip: !url }, async () => {
  const dict = emptyDictionary();
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_package.crubal"), "utf8"), dict);
  readDefinitions("title$\nruntime#min\n", dict);
  const text = 'contract: ocr\n  kind: receive\n  origin: observed\n  reads:\n    "Run Time" -> runtime\n\ncontract: label\n  kind: send\n  writes:\n    title -> Title\n';
  readDefinitions(text, dict);
  const owner = "border.example";
  const store = new PgStore(pool, owner);
  await store.commit({ migration: "backfill" }, (d) => { d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner, values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-0" } } }); }, "2026-10-15T17:00:00Z");
  const border = new PgBorder(store, { dict, contracts: readContracts(text) });
  const body = '{"Run Time":"97 min"}';
  const got = await border.receive("ocr", "P-1", body, undefined, "2026-10-15T17:00:01Z");
  assert.equal(got.landed, "value");
  assert.deepEqual((await store.state()).records.get("P-1")?.values.runtime, { $qty: "97", unit: "min" });
  const intake = (await pool.query("select intake, contract, sha256, raw, json from intake where owner = $1", [owner])).rows[0];
  assert.ok(intake, "the intake record is kept");
  assert.equal(Buffer.from(intake.raw).toString("utf8"), body, "its bytes are as received");
  assert.equal(intake.sha256, sha256(body));
  assert.equal(intake.json.outcomes[0].outcome, "absorbed");
  const first = await border.send("label", "P-1", undefined, "2026-10-15T17:00:02Z");
  assert.equal(first.acted, true);
  const again = await border.send("label", "P-1", undefined, "2026-10-15T17:00:03Z");
  assert.equal(again.acted, false, "the same payload is never sent twice, even by a fresh border");
  const entries = await store.entries();
  assert.equal(entries.length, 4, "backfill, the receive, and the one send's started and acted");
  assert.deepEqual(await store.verify(), { valid: true });
});

test("stream contracts read the projection stream and keep the index's cursor; schedules tick once", { skip: !url }, async () => {
  const viewsDir = join(corpus, "..", "views");
  const dict = emptyDictionary();
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_package.crubal"), "utf8"), dict);
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_facets.crubal"), "utf8"), dict);
  const viewText = readFileSync(join(viewsDir, "_views.crubal"), "utf8");
  readDefinitions(viewText, dict);
  const text = "contract: idx\n  kind: send\n  stream: discs\n  to: index.example\n  when: entry\n\ncontract: nightly\n  kind: send\n  when: every hour\n  writes:\n    title -> Title\n";
  readDefinitions(text, dict);
  const set = readViews(viewText);
  const owner = "stream.example";
  const records = readText(readFileSync(join(viewsDir, "_records.crubal"), "utf8"), dict).records.map((r) => ({ ...foldRecord(r, dict), owner }));
  const store = new PgStore(pool, owner, { projecting: { dict, views: set } });
  await store.commit({ migration: "backfill" }, (d) => { for (const r of records) d.records.set(r.id, structuredClone(r)); }, "2026-10-15T18:00:00Z");
  await store.project();
  const border = new PgBorder(store, { dict, contracts: readContracts(text) });
  const push = await border.streamRun("idx", undefined, undefined, "2026-10-15T18:00:01Z");
  const batch = (push.entries as { discs: StreamEntry[] }).discs;
  assert.equal(batch.length, 3);
  assert.deepEqual(push.cursor, { discs: 3 });
  assert.ok(String(push.key).startsWith("idx|discs||1-3"));
  // Until the index acknowledges, the same entries come again; after, nothing.
  assert.equal((await border.streamRun("idx")).entries && ((await border.streamRun("idx")).entries as { discs: StreamEntry[] }).discs.length, 3);
  await border.ack("idx", { discs: 3 });
  assert.deepEqual(((await border.streamRun("idx")).entries as { discs: StreamEntry[] }).discs, []);
  await store.commit({ person: "staff-1" }, (d) => {
    const was = d.records.get("P-2") as Record;
    d.records.set("P-2", { ...was, values: { ...was.values, title: "Home Alone 2" }, sources: { ...was.sources, title: { origin: "declared", via: "L-9" } } });
  }, "2026-10-15T18:00:02Z");
  await store.project();
  const next = ((await border.streamRun("idx")).entries as { discs: StreamEntry[] }).discs;
  assert.equal(next.length, 1);
  assert.equal(next[0]?.seq, 4);
  assert.equal(next[0]?.record, "P-2");

  // The schedule begins at the first reading; two hours later one tick runs (missed: once); a reading
  // before the next tick runs nothing; the tick's key is in the runs table.
  const began = await border.tick("nightly", "2026-10-15T18:00:00Z");
  assert.equal(began.began, "2026-10-15T18:00:00Z");
  const two = await border.tick("nightly", "2026-10-15T20:00:30Z");
  assert.equal((two.ticks as string[]).length, 2);
  assert.equal((two.runs as JsonObject[]).filter((r) => r.acted === true).length, 1, "once: only the latest tick runs");
  const quiet = await border.tick("nightly", "2026-10-15T20:30:00Z");
  assert.deepEqual(quiet.runs, []);
  const keys = (await pool.query("select json->>'key' as key from runs where owner = $1 and json->>'tick' is not null", [owner])).rows.map((r: { key: string }) => r.key);
  assert.deepEqual(keys, ["nightly|2026-10-15T20:00Z"]);
});

test("erase redacts every value write to a record across the log and leaves the shell", { skip: !url }, async () => {
  const owner = "person.example";
  const store = new PgStore(pool, owner);
  await store.commit({ contract: "signup", run: "R-1" }, (d) => {
    d.records.set("C-1", { id: "C-1", kind: "person", level: "person", owner, values: { name: "Pat", email: "pat@example.com" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    d.records.set("K-1", { id: "K-1", kind: "collection", level: "collection", owner, values: { name: "Pat's discs" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  }, "2026-10-15T19:00:00Z");
  await store.commit({ person: "C-1" }, (d) => {
    const r = d.records.get("C-1") as Record;
    d.records.set("C-1", { ...r, values: { ...r.values, note: "Prefers pickup" }, sources: { ...r.sources, note: { origin: "declared", via: "L-2" } } });
  }, "2026-10-15T19:01:00Z");
  const r = await store.erase("C-1");
  assert.equal(r.redacted, 3);
  assert.deepEqual(r.witnessed, []);
  const state = await store.state();
  assert.deepEqual(state.records.get("C-1")?.values, {}, "the shell stays, the values are gone");
  assert.deepEqual(state.records.get("K-1")?.values, { name: "Pat's discs" }, "nothing else is touched");
  assert.deepEqual(await store.verify(), { valid: true });
  const log = await store.entries();
  assert.equal((log[0]?.writes as JsonObject[]).filter((w) => typeof w.redacted === "string").length, 2);
});

test("install: verified bundles in dependency order, definitions from the store, a pin move restamping", { skip: !url }, async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = { d: privateKey.export({ format: "jwk" }).d as string, x: publicKey.export({ format: "jwk" }).x as string };
  const keys = { "shop.example": { alg: "Ed25519", public: key.x } };
  const baseV1 = `package: base /2026-10-01
  owner: shop.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
title$
format{DVD|Blu-ray}

class: Item
  for: item
  facets:
    !title
    format
`;
  const shopV1 = `package: shop /2026-10-01
  owner: shop.example
  crubal: 2
  extends: shop.example/base /2026-10-01
  prefixes:
    base: shop.example/base

price#USD

shape: card
  slots:
    !title -> heading
    format -> format

view: discs
  select:
    level: product
  shape: card
`;
  const base1 = publish(baseV1, { date: "2026-10-01", key }).bundle;
  const shop1 = publish(shopV1, { date: "2026-10-01", key }).bundle;
  const owner = "install.example";
  const store = new PgStore(pool, owner);
  // Refusals: unsigned, tampered, a dependency not installed.
  await assert.rejects(store.install(publish(baseV1, { date: "2026-10-01" }).bundle, keys), /unsigned/);
  await assert.rejects(store.install({ ...base1, label: "x" }, keys), /doesn't verify \(hash\)/);
  await assert.rejects(store.install(shop1, keys), /extends shop.example\/base \/2026-10-01, which isn't installed/);
  await store.install(base1, keys, "2026-10-15T20:00:00Z");
  await store.install(shop1, keys, "2026-10-15T20:00:01Z");
  const defs = await store.definitions();
  assert.ok(defs.dict.facets.has("title") && defs.dict.facets.has("price") && defs.dict.classes.has("Item"));
  assert.ok(defs.views.views.has("discs"));
  assert.deepEqual((await store.state()).installed.map((i) => `${i.package} /${i.version}`), ["shop.example/base /2026-10-01", "shop.example/shop /2026-10-01"]);
  // Records under the installed definitions, projected with no definitions handed in.
  await store.commit({ person: "staff-1" }, (d) => {
    d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner, values: { title: "Christmas Vacation", format: "Blu-ray" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  }, "2026-10-15T20:00:02Z");
  const first = await store.project("discs");
  assert.deepEqual(first.map((e) => e.row), [{ record: "P-1", heading: "Christmas Vacation", format: "Blu-ray" }]);
  // The owner's own definition: a define write, checked with the rest; a bad one is refused and writes nothing.
  await assert.rejects(store.define({ view: "bad", select: { level: "product" }, shape: "nope" }), /nope/);
  await store.define({ shape: "line", slots: [{ from: "title", to: "line" }] }, { person: "staff-1" }, "2026-10-15T20:00:03Z");
  await store.define({ view: "lines", select: { level: "product" }, shape: "line" }, { person: "staff-1" }, "2026-10-15T20:00:04Z");
  assert.ok((await store.definitions()).views.views.has("lines"));
  assert.deepEqual((await store.project("lines")).map((e) => e.row), [{ record: "P-1", line: "Christmas Vacation" }]);
  // A pin move: base v2 merges Blu-ray into DVD with a recipe; installing it restamps P-1 by migration.
  const baseV2 = `${baseV1.replace("base /2026-10-01", "base /2026-11-01").replace("format{DVD|Blu-ray}", "format{DVD}")}
migration: base /2026-10-01 -> base /2026-11-01
  facet: format
    merge: Blu-ray -> DVD
`;
  const base2 = publish(baseV2, { date: "2026-11-01", previous: base1, key }).bundle;
  const entry = await store.install(base2, keys, "2026-10-15T20:00:05Z");
  assert.deepEqual(entry.by, { migration: "base /2026-10-01 -> base /2026-11-01" });
  assert.equal((await store.state()).records.get("P-1")?.values.format, "DVD");
  assert.ok((await store.definitions()).dict.facets.get("format")?.values?.every((v) => v.value === "DVD"));
  // A retired member leaves the package (11.4): the view first, then the shape; the shape can't go while the view reads it (G12).
  await assert.rejects(store.define({ shape: "line", retired: true }, { person: "staff-1" }, "2026-10-15T20:00:08Z"), /line/);
  await store.define({ view: "lines", retired: true }, { person: "staff-1" }, "2026-10-15T20:00:09Z");
  await store.define({ shape: "line", retired: true }, { person: "staff-1" }, "2026-10-15T20:00:10Z");
  assert.equal((await store.definitions(true)).views.views.has("lines"), false);
  assert.equal((await store.definitions(true)).views.shapes.has("line"), false);
  assert.deepEqual(await store.verify(), { valid: true });
  // The border reads its contracts from the store too.
  const border = await PgBorder.over(store);
  assert.equal(border.contracts.size, 0);
});

test("a send over the store: started, the adapter, acted or failed, retry from outtake, a late answer, erasure", { skip: !url }, async () => {
  const dict = emptyDictionary();
  readDefinitions(readFileSync(join(corpus, "..", "reader", "_package.crubal"), "utf8"), dict);
  readDefinitions("title$\nmarket:itemId$\n", dict);
  const text = "contract: label\n  kind: send\n  writes:\n    title -> Title\n  retry: 1 every 10m\n\ncontract: listing\n  kind: send\n  writes:\n    title -> Title\n  reads:\n    itemId -> market:itemId\n  undo: unlist\n\ncontract: unlist\n  kind: send\n  writes:\n    title -> Title\n";
  readDefinitions(text, dict);
  const owner = "send.example";
  const store = new PgStore(pool, owner);
  await store.commit({ migration: "backfill" }, (d) => { d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner, values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-0" } } }); }, "2026-10-15T21:00:00Z");
  let printerUp = false;
  const adapters = {
    label: async () => (printerUp ? { acted: true as const } : { failed: "printer offline" }),
    listing: async () => ({ acted: true as const, body: '{"itemId":"110245563"}' }),
  };
  const border = new PgBorder(store, { dict, contracts: readContracts(text), adapters });
  // Failed once, retried from the kept payload, acted: three run entries and one outtake row.
  const first = await border.send("label", "P-1", undefined, "2026-10-15T21:00:01Z");
  assert.equal(first.failed, true);
  assert.equal(first.attempt, 1);
  const run = String(first.log);
  const out = (await pool.query("select contract, record, sha256, raw from outtake where owner = $1 and run = $2", [owner, run])).rows[0];
  assert.equal(out.contract, "label");
  assert.equal(JSON.parse(Buffer.from(out.raw).toString("utf8")).Title, "Christmas Vacation");
  printerUp = true;
  const again = await border.retry(run, undefined, "2026-10-15T21:10:01Z");
  assert.equal(again.acted, true);
  const states = (await store.state()).runs;
  assert.equal(states.get(run)?.state, "acted");
  const log = await store.entries();
  const runWrites = log.flatMap((e) => (e.writes as JsonObject[]).filter((w) => w.run === run)).map((w) => `${w.state}${w.attempt ? `:${w.attempt}` : ""}`);
  assert.deepEqual(runWrites, ["started", "failed:1", "acted"]);
  assert.ok(!(log.find((e) => (e.writes as JsonObject[]).some((w) => w.run === run && w.state === "started"))?.writes as JsonObject[])[0]?.Title, "the payload itself is not in the log");
  // A fresh border over the same store never starts the same payload twice.
  const fresh = new PgBorder(store, { dict, contracts: readContracts(text), adapters });
  const dup = await fresh.send("label", "P-1", undefined, "2026-10-15T21:20:00Z");
  assert.equal(dup.acted, false);
  // The adapter's answer closes the run as a receive: the value lands with via that run.
  const listed = await border.send("listing", "P-1", undefined, "2026-10-15T21:30:00Z");
  assert.equal(listed.acted, true);
  const lrun = String(listed.log);
  assert.equal((listed.answer as JsonObject).log, lrun);
  assert.equal((await store.state()).runs.get(lrun)?.state, "closed");
  assert.equal((await store.state()).records.get("P-1")?.values["market:itemId"], "110245563");
  assert.equal((await store.state()).records.get("P-1")?.sources?.["market:itemId"]?.via, lrun);
  // Undo names its cause.
  const undone = await border.undo(lrun, undefined, "2026-10-15T21:40:00Z");
  assert.equal(undone.contract, "unlist");
  assert.equal(undone.cause, lrun);
  assert.equal(undone.acted, true);
  // Erasure takes the payloads sent about the record with the values.
  await store.erase("P-1");
  assert.equal((await pool.query("select count(*)::int as n from outtake where owner = $1 and record = 'P-1'", [owner])).rows[0].n, 0);
  assert.deepEqual(await store.verify(), { valid: true });
});

test("review decisions over the store: a vocabulary decision replays the held intake; a unit question; a suggestion; a dead run", { skip: !url }, async () => {
  const owner = "review.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const text = `package: shop /2026-10-01
  owner: review.example
  crubal: 2

kind: item
  levels: product
  base: Item
title$
format{DVD|Blu-ray}
weight#kg accepts: g, lb
class: Item
  for: item
  facets:
    title
    format

contract: catalog
  kind: receive
  origin: reported
  reads:
    Title -> title
    Format -> format
    Weight -> weight
contract: label
  kind: send
  writes:
    title -> Title
`;
  await store.install(publish(text, { date: "2026-10-01" }).bundle, undefined, "2026-10-16T09:00:00Z");
  await store.commit({ person: owner }, (d) => { d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner, values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-1" } } }); }, "2026-10-16T09:00:01Z");
  const border = await PgBorder.over(store);
  // The catalog brings a format the list doesn't hold and a weight in a unit the table doesn't know.
  const got = await border.receive("catalog", "P-1", '{"Title":"Christmas Vacation","Format":"4K","Weight":"2.5 stone"}', undefined, "2026-10-16T09:00:02Z");
  const outcomes = got.outcomes as JsonObject[];
  assert.equal(outcomes.find((o) => o.from === "Format")?.outcome, "new");
  assert.deepEqual(outcomes.find((o) => o.from === "Weight")?.cites, { unit: "stone" });
  assert.equal((await store.state()).records.get("P-1")?.values.format, "4K", "a new value lands, marked new, pending review");
  // Add the value: one entry (review + define), then the kept intake replays and the value is no longer new.
  const added = await store.decide({ key: "facet:format", value: "4K", decision: "add value" }, { person: owner }, "2026-10-16T09:01:00Z");
  assert.ok(added.entry);
  assert.equal(added.replayed.length, 1, "the intake holding the new value replayed");
  const defs = await store.definitions();
  assert.ok(defs.dict.facets.get("format")?.values?.some((v) => v.value === "4K"));
  const replay = (await pool.query("select json from intake where owner = $1", [owner])).rows[0].json as JsonObject;
  assert.equal(((replay.replays as JsonObject[])[0]?.outcomes as JsonObject[]).find((o) => o.from === "Format")?.outcome, "absorbed");
  // The unit question: a new unit under the owner's prefix; the replayed weight converts into kilograms.
  const unit = await store.decide({ key: "unit:stone", decision: "new unit", unit: "shop:stone", dimension: "mass", factor: "6.35029318", accepts: ["weight"] }, { person: owner }, "2026-10-16T09:02:00Z");
  assert.equal(unit.replayed.length, 1);
  const weight = (await store.state()).records.get("P-1")?.values.weight as JsonObject;
  assert.equal(weight.unit, "kg");
  assert.equal(weight.$qty, "15.8757");
  // A suggestion accepted through the decision, with its original source.
  await store.commit({ person: owner }, (d) => {
    const r = d.records.get("P-1") as Record;
    d.records.set("P-1", { ...r, suggestions: { title: [{ value: "Christmas Vacation (Special Edition)", origin: "declared", via: "L-9" }] } } as unknown as Record);
  }, "2026-10-16T09:03:00Z");
  await store.decide({ key: "suggestion", record: "P-1", address: "title", decision: "accept" }, { person: owner }, "2026-10-16T09:03:01Z");
  const p1 = (await store.state()).records.get("P-1") as Record & { suggestions?: unknown };
  assert.equal(p1.values.title, "Christmas Vacation (Special Edition)");
  assert.equal(p1.sources?.title?.via, "L-9");
  assert.equal(p1.suggestions, undefined);
  // A dead run retried: its key released, a new run started by a fresh border.
  const failing = new PgBorder(store, { ...(await (await import("../src/border.ts")).borderOptions(store)), adapters: { label: async () => ({ failed: "printer offline" }) } });
  const dead = await failing.send("label", "P-1", undefined, "2026-10-16T09:04:00Z");
  assert.equal(dead.dead, true);
  assert.equal((await failing.send("label", "P-1", undefined, "2026-10-16T09:04:01Z")).acted, false, "the key is held");
  const again = new PgBorder(store, { ...(await (await import("../src/border.ts")).borderOptions(store)), adapters: { label: async () => ({ acted: true }) } });
  const retried = await again.decideRun(String(dead.log), "retry", owner, "2026-10-16T09:05:00Z");
  assert.equal(retried.retried, dead.log);
  assert.equal(retried.acted, true);
  assert.equal((await store.review()).filter((it) => it.key === "run:label").length, 0, "the item is decided");
  assert.deepEqual(await store.verify(), { valid: true });
});

test("observations over the store: readings land as observations, the first fills the value, the third disagreeing instance proposes a version split, and the decision splits", { skip: !url }, async () => {
  const owner = "evidence.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const text = `package: shop /2026-10-01
  owner: evidence.example
  crubal: 2
  split: 3

kind: item
  levels: product, unit
  base: Item
title$
runtime#min
class: Item
  for: item
  facets:
    title
    runtime

contract: discRead
  kind: receive
  origin: observed
  lands: observation
  evidence: disc-read
  reads:
    minutes -> runtime
`;
  await store.install(publish(text, { date: "2026-10-01" }).bundle, undefined, "2026-10-17T09:00:00Z");
  await store.commit({ person: owner }, (d) => {
    d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner, values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    for (const u of ["U-1", "U-2", "U-3", "U-4"]) d.records.set(u, { id: u, kind: "item", level: "unit", of: "P-1", owner, values: {}, sources: { "*": { origin: "observed", via: "L-1" } } });
  }, "2026-10-17T09:00:01Z");
  const border = await PgBorder.over(store);
  const first = await border.receive("discRead", "U-1", '{"minutes":"97min"}', undefined, "2026-10-17T09:01:00Z");
  assert.equal(first.landed, "observation");
  assert.equal(first.filled, "P-1", "the first observation fills the product's empty value");
  assert.equal(((await store.state()).records.get("P-1")?.values.runtime as JsonObject).$qty, "97");
  assert.equal((await store.state()).observations.length, 1, "the observation is kept in the state");
  await border.receive("discRead", "U-2", '{"minutes":"92min"}', undefined, "2026-10-17T09:02:00Z");
  const third = await border.receive("discRead", "U-3", '{"minutes":"92min"}', undefined, "2026-10-17T09:03:00Z");
  assert.equal(third.proposed, undefined, "two instances are below the threshold");
  const fourth = await border.receive("discRead", "U-4", '{"minutes":"92min"}', undefined, "2026-10-17T09:04:00Z");
  assert.equal((fourth.proposed as JsonObject[])?.length, 1, "three instances agreeing against the value propose a split");
  const open = (await store.review()).filter((it) => it.key === "split:P-1");
  assert.equal(open.length, 1);
  assert.deepEqual(open[0]?.instances, ["U-2", "U-3", "U-4"]);
  assert.equal(((await store.state()).records.get("P-1")?.values.runtime as JsonObject).$qty, "97", "nothing split on its own");
  // The same observation again proposes nothing new.
  await border.receive("discRead", "U-4", '{"minutes":"92min"}', undefined, "2026-10-17T09:05:00Z");
  assert.equal((await store.review()).filter((it) => it.key === "split:P-1").length, 1);
  // The decision splits: P-2 minted with the observed value, the three instances moved under it.
  const item = open[0] as JsonObject;
  await store.decide({ key: "split:P-1", decision: "split", into: "P-2", address: String(item.address), value: item.value as Json, instances: item.instances as Json, via: "O-2" }, { person: owner }, "2026-10-17T09:06:00Z");
  const s = await store.state();
  assert.equal((s.records.get("P-2")?.values.runtime as JsonObject).$qty, "92");
  assert.equal(s.records.get("U-3")?.of, "P-2");
  assert.equal(s.records.get("U-1")?.of, "P-1");
  assert.equal((await store.review()).filter((it) => it.key === "split:P-1").length, 0);
  assert.deepEqual(await store.verify(), { valid: true });
});

test("drain applies pending instructions at a rate, each record one entry", { skip: !url }, async () => {
  const owner = "drain.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const text = `package: shop /2026-10-01
  owner: drain.example
  crubal: 2

kind: item
  levels: product
  base: Item
title$
notes$
class: Item
  for: item
  facets:
    title
    notes
`;
  await store.install(publish(text, { date: "2026-10-01" }).bundle, undefined, "2026-10-18T09:00:00Z");
  await store.commit({ person: owner }, (d) => {
    for (const id of ["P-1", "P-2", "P-3"]) d.records.set(id, { id, kind: "item", level: "product", owner, values: { title: id }, sources: { "*": { origin: "declared", via: "L-1" } } });
    d.instructions.set("kind:item/2026-10-18", [{ issuer: "kind:item/2026-10-18", n: 1, op: "+", key: "notes", map: [] }]);
  }, "2026-10-18T09:00:01Z");
  const first = await store.drain(2, "2026-10-18T09:01:00Z");
  assert.deepEqual(first, { applied: ["P-1", "P-2"], remaining: 1 });
  const second = await store.drain(2, "2026-10-18T09:02:00Z");
  assert.deepEqual(second, { applied: ["P-3"], remaining: 0 });
  assert.deepEqual(await store.drain(2, "2026-10-18T09:03:00Z"), { applied: [], remaining: 0 });
  const s = await store.state();
  assert.deepEqual(s.records.get("P-2")?.values.notes, { $empty: "unknown" });
  assert.equal(s.records.get("P-2")?.applied?.["kind:item/2026-10-18"], 1);
  assert.equal((await store.entries()).filter((e) => (e.by as JsonObject).migration === "drain").length, 3, "one entry per record drained");
  assert.deepEqual(await store.verify(), { valid: true });
});

test("the store refuses what access forbids at the commit (14.12, 5.5): a person owning a product, a class not for the kind, within across owners", { skip: !url }, async () => {
  const owner = "refuse.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const text = `package: shop /2026-10-01
  owner: refuse.example
  crubal: 2

kind: item
  levels: product
  base: Item
kind: collection
  levels: collection
  base: Collection
kind: league
  levels: league
title$
class: Item
  for: item
  facets:
    title
class: Collection
  for: collection
  facets:
    title
class: Venue
  for: league
  facets:
    title

ownership:
  person: collection
`;
  await store.install(publish(text, { date: "2026-10-01" }).bundle, undefined, "2026-10-19T09:00:00Z");
  const put = (r: Record) => store.commit({ person: owner }, (d) => { d.records.set(r.id, { ...r, sources: { "*": { origin: "declared", via: "L-1" } } }); }, "2026-10-19T09:00:01Z");
  await assert.rejects(put({ id: "P-1", kind: "item", level: "product", owner: `${owner}:S-1`, values: { title: "x" } }), /a person may own collection, not a item/);
  await assert.rejects(put({ id: "P-2", kind: "item", level: "product", owner, wears: ["Venue"], values: { title: "x" } }), /wears Venue, which is for league, not item/);
  await put({ id: "L-1", kind: "league", level: "league", owner: "other.example", values: { title: "Northern" } });
  await assert.rejects(put({ id: "P-3", kind: "item", level: "product", owner, within: "L-1", values: { title: "x" } }), /within never crosses owners/);
  await put({ id: "C-1", kind: "collection", level: "collection", owner: `${owner}:S-1`, values: { title: "mine" } });
  assert.equal((await store.state()).records.size, 2, "the refused writes left nothing behind");
});

test("a plain commit runs the productions (6.4): a product counts its units, a unit reads the best of its offers, each landing in the same entry with its rule as source; a later sale follows", { skip: !url }, async () => {
  const owner = "derive.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const text = `package: shop /2026-10-01
  owner: derive.example
  crubal: 2

kind: item
  levels: product, unit, offer
  base: Item
  vary:
    unit: cashierfuId, stock
    offer: availability
title$
unitCount#
cashierfuId$
stock{available|held|sold|withdrawn|none}
availability{available|held|sold|withdrawn}
class: Item
  for: item
  facets:
    title
    unitCount
    unit::cashierfuId
    unit::stock
    offer::availability

rule: unitsCounted
  then: unitCount is count of unit::cashierfuId
  strength: should
rule: unitStock
  for: unit::
  then: stock is best of offer::availability
  strength: should
`;
  await store.install(publish(text, { date: "2026-10-01" }).bundle, undefined, "2026-10-19T09:00:00Z");
  const src = { "*": { origin: "declared", via: "L-1" } };
  const put = (r: Record, at: string) => store.commit({ person: owner }, (d) => { d.records.set(r.id, { ...r, sources: src }); }, at);
  await put({ id: "P-1", kind: "item", level: "product", owner, values: { title: "Die Hard" } }, "2026-10-19T09:01:00Z");
  let st = await store.state();
  assert.equal(st.records.get("P-1")?.values.unitCount, "0", "a product with no units counts none");
  const e1 = await put({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner, values: { cashierfuId: "AAA" } }, "2026-10-19T09:02:00Z");
  st = await store.state();
  assert.equal(st.records.get("P-1")?.values.unitCount, "1", "the product counts the unit a plain write made");
  assert.deepEqual(st.records.get("P-1")?.sources?.unitCount, { origin: "derived", via: "unitsCounted" });
  const writes = (e1?.writes ?? []) as JsonObject[];
  assert.ok(writes.some((w) => w.record === "P-1" && w.address === "unitCount" && w.value === "1" && (w.source as JsonObject | undefined)?.origin === "derived"), "the derived value rides in the same entry");
  await put({ id: "F-1", kind: "item", level: "offer", of: "U-1", owner, values: { availability: "available" } }, "2026-10-19T09:03:00Z");
  st = await store.state();
  assert.equal(st.records.get("U-1")?.values.stock, "available", "the unit reads the best of its offers");
  assert.equal(st.records.get("P-1")?.values.unitCount, "1");
  const offer = st.records.get("F-1") as Record;
  await store.commit({ person: owner }, (d) => { d.records.set("F-1", { ...offer, values: { ...offer.values, availability: "sold" } }); }, "2026-10-19T09:04:00Z");
  st = await store.state();
  assert.equal(st.records.get("U-1")?.values.stock, "sold", "and follows the sale");
  // A person's own value is adopted and left alone.
  const p1 = st.records.get("P-1") as Record;
  await store.commit({ person: owner }, (d) => { d.records.set("P-1", { ...p1, values: { ...p1.values, unitCount: "9" }, sources: { ...(p1.sources ?? {}), unitCount: { origin: "declared", via: "L-9" } } }); }, "2026-10-19T09:05:00Z");
  await put({ id: "U-2", kind: "item", level: "unit", of: "P-1", owner, values: { cashierfuId: "BBB" } }, "2026-10-19T09:06:00Z");
  st = await store.state();
  assert.equal(st.records.get("P-1")?.values.unitCount, "9", "adopted, never overwritten");
  assert.equal(st.records.get("U-2")?.values.stock, undefined, "no offers, nothing produced");
});

test("rederive runs the productions over records written before the rule: one entry with the derived values, nothing else; a second pass writes nothing", { skip: !url }, async () => {
  const owner = "rederive.example";
  const store = new PgStore(pool, owner, { allowUnsigned: true });
  const v1 = `package: shop /2026-10-01
  owner: rederive.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
  vary:
    unit: cashierfuId
title$
unitCount#
cashierfuId$
class: Item
  for: item
  facets:
    title
    unitCount
    unit::cashierfuId
`;
  await store.install(publish(v1, { date: "2026-10-01" }).bundle, undefined, "2026-10-19T09:00:00Z");
  const src = { "*": { origin: "declared", via: "L-1" } };
  const put = (r: Record, at: string) => store.commit({ person: owner }, (d) => { d.records.set(r.id, { ...r, sources: src }); }, at);
  await put({ id: "P-1", kind: "item", level: "product", owner, values: { title: "Die Hard" } }, "2026-10-19T09:01:00Z");
  await put({ id: "U-1", kind: "item", level: "unit", of: "P-1", owner, values: { cashierfuId: "AAA" } }, "2026-10-19T09:02:00Z");
  await put({ id: "U-2", kind: "item", level: "unit", of: "P-1", owner, values: { cashierfuId: "BBB" } }, "2026-10-19T09:03:00Z");
  assert.equal((await store.state()).records.get("P-1")?.values.unitCount, undefined, "no rule yet");
  const v2 = `${v1}
rule: unitsCounted
  for: product::
  then: unitCount is count of unit::cashierfuId
  strength: should
`;
  await store.install(publish(v2.replace("shop /2026-10-01", "shop /2026-10-02"), { date: "2026-10-02" }).bundle, undefined, "2026-10-19T09:04:00Z");
  const e = await store.rederive(["P-1", "U-1", "U-2"], { platform: "rederive" }, "2026-10-19T09:05:00Z");
  assert.ok(e, "one entry");
  const writes = (e?.writes ?? []) as JsonObject[];
  assert.deepEqual(writes.map((w) => [w.record, w.address, w.value]), [["P-1", "unitCount", "2"]], "only the derived value");
  assert.equal((await store.state()).records.get("P-1")?.values.unitCount, "2");
  assert.equal(await store.rederive(["P-1", "U-1", "U-2"], { platform: "rederive" }, "2026-10-19T09:06:00Z"), null, "nothing to write twice");
});
