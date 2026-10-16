// The reference host over the Postgres store, end to end through HTTP. Skipped without CRUBAL_PG_URL.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { publish } from "../../crubal/src/publish.ts";
import { verifyChain } from "../../crubal/src/store.ts";
import type { JsonObject } from "../../crubal/src/model.ts";
import { connect, testSchema, type Pool } from "../../crubal-postgres/src/db.ts";
import { Host } from "../src/host.ts";
import { serve } from "../src/server.ts";

const url = process.env.CRUBAL_PG_URL;
let pool: Pool;
let drop: () => Promise<void>;
let base = "";
let host: Host;
let server: ReturnType<typeof serve>;
const acted: JsonObject[] = [];

before(async () => {
  if (!url) return;
  pool = connect(url);
  drop = await testSchema(pool);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = { d: privateKey.export({ format: "jwk" }).d as string, x: publicKey.export({ format: "jwk" }).x as string };
  host = new Host(pool, {
    domain: "host.example",
    hostKey: "hk",
    now: () => "2026-10-15T22:00:00Z",
    fresh: "write",
    resolveKeys: async (domain) => (domain === "pub.example" ? { "pub.example": { alg: "Ed25519", public: key.x } } : ({} as { [o: string]: { alg: string; public: string } })),
    adapters: { label: async (_c, payload, run) => { acted.push({ payload, run }); return { acted: true, body: '{"itemId":"L-77"}' }; } },
  });
  await host.migrate();
  server = serve(host).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as { pubKey?: typeof key }).pubKey = key;
});
after(async () => {
  if (!url) return;
  server.close();
  await drop();
  await pool.end();
});

const call = async (method: string, path: string, token?: string, body?: unknown, headers: { [k: string]: string } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  return { status: res.status, body: (await res.json()) as JsonObject };
};

const PACKAGE = `package: shop /2026-10-01
  owner: pub.example
  crubal: 2

kind: item
  levels: product, unit
  base: Item
kind: person
  levels: person
  base: Person
title$
format{DVD|Blu-ray}
condition{NM|VG|G} ranked
itemId$

class: Item
  for: item
  facets:
    !title
    format
class: Person
  for: person

contract: bench
  kind: form
  origin: observed
  needs:
    !condition
contract: label
  kind: send
  writes:
    title -> Title
  reads:
    itemId -> itemId
  host:url: https://printer.example/labels

shape: card
  slots:
    !title -> heading
filter: format
  facet: format
view: discs
  select:
    level: product
  order: title
  shape: card
  filters: format
  index: format

permissions: shop
  menu:
    grade: see condition, edit condition, run bench
    print: run label, see itemId
  presets:
    staff: grade, print audience: staff
  relations: staff
`;

test("owners, keys and the well-known file", { skip: !url }, async () => {
  const o = await host.createOwner("shop.example");
  assert.ok(o.public);
  const wk = await call("GET", "/.well-known/crubal.json");
  assert.equal(wk.status, 200);
  assert.deepEqual((wk.body.keys as JsonObject)["shop.example"], { alg: "Ed25519", public: o.public });
  assert.equal((await call("GET", "/o/shop.example/records/P-1")).status, 401, "nobody is signed in");
  assert.equal((await call("POST", "/project")).status, 403, "the loops need the host key");
});

test("install through the host, then a form run, a send with an adapter and an answer, a record read", { skip: !url }, async () => {
  const key = (globalThis as { pubKey?: { d: string; x: string } }).pubKey as { d: string; x: string };
  const ownerKey = await host.issueKey("shop.example", "shop.example", "owner");
  const staffKey = await host.issueKey("shop.example", "S-1", "staff");
  const { bundle } = publish(PACKAGE, { date: "2026-10-01", key });
  const inst = await call("POST", "/o/shop.example/install", ownerKey, { bundle });
  assert.equal(inst.status, 200, JSON.stringify(inst.body));
  assert.equal(inst.body.installed, "pub.example/shop");
  assert.equal((await call("POST", "/o/shop.example/install", staffKey, { bundle })).status, 403, "only the owner installs");
  // Records and the staff edge, written as the owner.
  const store = await host.storeFor("shop.example");
  await store.commit({ person: "shop.example" }, (d) => {
    d.records.set("S-1", { id: "S-1", kind: "person", level: "person", owner: "shop.example", values: {} });
    d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner: "shop.example", values: { title: "Christmas Vacation", format: "DVD" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    d.records.set("U-1", { id: "U-1", kind: "item", level: "unit", of: "P-1", owner: "shop.example", values: {}, sources: { "*": { origin: "observed", via: "L-1" } } });
    d.edges.set("E-1", { edge: "E-1", who: "S-1", relation: "staff", mode: "control", on: "U-1", grants: ["staff"], by: "owner" });
  }, "2026-10-15T22:00:01Z");
  // The form, as data, for the staff caller: condition editable.
  const form = await call("GET", "/o/shop.example/forms/bench?record=U-1", staffKey);
  assert.equal(form.status, 200);
  const field = ((form.body.sections as JsonObject[])[0]?.fields as JsonObject[])[0] as JsonObject;
  assert.equal(field.key, "condition");
  assert.equal(field.editable, true);
  // The form run lands the answer with origin observed.
  const ran = await call("POST", "/o/shop.example/run/bench", staffKey, { record: "U-1", answers: { condition: "VG" } });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.landed, "value", JSON.stringify(ran.body));
  const rec = await call("GET", "/o/shop.example/records/U-1?full=1", staffKey);
  assert.equal((rec.body.values as JsonObject).condition, "VG", `${JSON.stringify(ran.body)}\n${JSON.stringify(rec.body)}`);
  assert.equal(((rec.body.sources as JsonObject).condition as JsonObject).origin, "observed");
  // A send: the adapter acts, its answer closes the run, the record gains the item id.
  const sent = await call("POST", "/o/shop.example/run/label", staffKey, { record: "U-1" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.acted, true);
  assert.equal(acted.length, 1);
  assert.equal((acted[0]?.payload as JsonObject).Title, "Christmas Vacation");
  const after1 = await call("GET", "/o/shop.example/records/U-1", staffKey);
  assert.equal((after1.body.values as JsonObject).itemId, "L-77");
  // The view published on write (fresh: write); the stream reads from it.
  const rows = (await pool.query("select record from projections where owner = $1 and view = 'discs'", ["shop.example"])).rows;
  assert.deepEqual(rows.map((r: { record: string }) => r.record), ["P-1"]);
  // The log is signed with the owner's key and verifies against the well-known file.
  const exp = await call("GET", "/o/shop.example/export", ownerKey);
  assert.equal(exp.status, 200);
  const wk = await call("GET", "/.well-known/crubal.json");
  const v = verifyChain(exp.body.log as JsonObject[], wk.body.keys as never);
  assert.deepEqual(v, { valid: true });
  assert.ok((exp.body.log as JsonObject[]).every((e) => typeof e.sig === "string"), "every entry carries a signature");
  // The review queue reads by key; erasure is the owner's.
  assert.equal((await call("GET", "/o/shop.example/review", staffKey)).status, 200);
  assert.equal((await call("POST", "/o/shop.example/erase/U-1", staffKey)).status, 403);
  const erased = await call("POST", "/o/shop.example/erase/U-1", ownerKey);
  assert.equal(erased.status, 200);
  assert.deepEqual(((await call("GET", "/o/shop.example/records/U-1", ownerKey)).body.values as JsonObject), {});
  // The reference index: the view's page from the stream, counts over the other picks, search, noindex past page 1.
  await store.commit({ person: "shop.example" }, (d) => {
    d.records.set("P-2", { id: "P-2", kind: "item", level: "product", owner: "shop.example", values: { title: "Home Alone", format: "Blu-ray" }, sources: { "*": { origin: "declared", via: "L-2" } } });
  }, "2026-10-15T22:00:05Z");
  const pageRes = await fetch(`${base}/o/shop.example/v/discs`);
  assert.equal(pageRes.headers.get("x-robots-tag"), "all");
  const page = (await pageRes.json()) as JsonObject;
  assert.deepEqual((page.rows as JsonObject[]).map((r) => r.heading), ["Christmas Vacation", "Home Alone"]);
  assert.deepEqual(page.counts, { format: { DVD: 1, "Blu-ray": 1 } });
  const picked = await call("GET", "/o/shop.example/v/discs?format=Blu-ray");
  assert.deepEqual((picked.body.rows as JsonObject[]).map((r) => r.heading), ["Home Alone"]);
  assert.deepEqual(picked.body.counts, { format: { DVD: 1, "Blu-ray": 1 } }, "a filter's counts ignore its own pick");
  assert.equal(picked.body.indexable, true, "one index filter, one bucket");
  const searched = await call("GET", "/o/shop.example/v/discs?q=alone");
  assert.deepEqual((searched.body.rows as JsonObject[]).map((r) => r.heading), ["Home Alone"]);
  assert.equal(searched.body.indexable, false);
  const p2 = await fetch(`${base}/o/shop.example/v/discs?page=2`);
  assert.equal(p2.headers.get("x-robots-tag"), "noindex");

  // The loops, with the host key.
  assert.equal((await call("POST", "/project", undefined, {}, { "x-host-key": "hk" })).status, 200);
  assert.equal((await call("POST", "/tick", undefined, {}, { "x-host-key": "hk" })).status, 200);
});
