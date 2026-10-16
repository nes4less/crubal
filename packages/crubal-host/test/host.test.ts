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
const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
let pool: Pool;
let drop: () => Promise<void>;
let base = "";
let host: Host;
let clock = "2026-10-15T22:00:00Z";
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
    now: () => clock,
    fresh: "write",
    resolveKeys: async (domain) => {
      if (domain === "pub.example") return { "pub.example": { alg: "Ed25519", public: key.x } };
      const own = (await host.owners()).find((o) => o.owner === domain);
      return own ? { [domain]: { alg: "Ed25519", public: own.public } } : {};
    },
    hostOf: () => base,
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
kind: collection
  levels: collection
  base: Collection
class: Collection
  for: collection
  facets:
    !title
contract: newCollection
  kind: form
  origin: declared
  needs:
    !title
ownership:
  person: collection

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

test("offer and take between two owners on one host, a link offer, and a stream pushed to the other's inbox", { skip: !url }, async () => {
  // The presenter: a distributor with an offer to the public, one by link, one private, and a stream pushed to the shop.
  await host.createOwner("dist.example");
  const distKey = await host.issueKey("dist.example", "dist.example", "owner");
  const key = (globalThis as { pubKey?: { d: string; x: string } }).pubKey as { d: string; x: string };
  const DIST = `package: dist /2026-10-01
  owner: pub.example
  crubal: 2

kind: item
  levels: product
  base: Item
title$
format{DVD|Blu-ray}
cost#USD
class: Item
  for: item
  facets:
    !title
    format

contract: catalogOffer
  kind: offer
  gives: title, format
  to: public
  mode: gathered
contract: tradeOffer
  kind: offer
  gives: title, cost
  to: link
  mode: controlled
  terms:
    reshare: no
contract: secretOffer
  kind: offer
  gives: cost
  to: private
  mode: dump
contract: toShop
  kind: send
  stream: discs
  to: shop.example
  when: entry

shape: card
  slots:
    !title -> heading
view: discs
  select:
    level: product
  order: title
  shape: card
`;
  const inst = await call("POST", "/o/dist.example/install", distKey, { bundle: publish(DIST, { date: "2026-10-01", key }).bundle });
  assert.equal(inst.status, 200, JSON.stringify(inst.body));
  const dist = await host.storeFor("dist.example");
  const written = await dist.commit({ person: "dist.example" }, (d) => {
    d.records.set("D-1", { id: "D-1", kind: "item", level: "product", owner: "dist.example", values: { title: "Gremlins", format: "DVD", cost: { $money: "3.10", currency: "USD" } }, sources: { "*": { origin: "declared", via: "L-2" } } });
  }, "2026-10-15T22:01:00Z");
  assert.equal(written?.log, "L-2", "the sources name the entry the values were written in");
  // The offers a stranger sees: the public one only; the private one is refused; the link one needs its token.
  const anon = await call("GET", "/o/dist.example/offer");
  assert.deepEqual((anon.body.offers as JsonObject[]).map((o) => o.contract), ["catalogOffer"]);
  assert.equal((await call("GET", "/o/dist.example/offer/secretOffer")).status, 401);
  assert.equal((await call("GET", "/o/dist.example/offer/tradeOffer")).status, 401);
  const link = await call("POST", "/o/dist.example/offer/tradeOffer/link", distKey);
  assert.equal(link.status, 200);
  const token = String(link.body.link);
  const byLink = await call("GET", `/o/dist.example/offer/tradeOffer?link=${token}`);
  assert.equal(byLink.status, 200);
  assert.deepEqual((byLink.body.records as JsonObject[]).map((r) => Object.keys(r.values as JsonObject)), [["title", "cost"]]);
  assert.deepEqual(byLink.body.terms, { reshare: "no" });
  assert.equal((await call("POST", "/o/dist.example/offer/tradeOffer/unpublish", distKey)).status, 200);
  assert.equal((await call("GET", `/o/dist.example/offer/tradeOffer?link=${token}`)).status, 401, "unpublished: the token stops working");
  assert.equal(String((await call("POST", "/o/dist.example/offer/tradeOffer/link", distKey)).body.link), token, "republished: the same token");
  // The public offer is a border wrapper: the records with their sources and the signed entries they came from.
  const offer = await call("GET", "/o/dist.example/offer/catalogOffer");
  assert.equal(offer.status, 200);
  assert.deepEqual((offer.body.records as JsonObject[])[0]?.values, { title: "Gremlins", format: "DVD" }, "only what the offer gives");
  assert.equal((offer.body.log as JsonObject[]).length, 1);
  // The consumer takes: a new version of the shop package carries the take contract.
  const SHOP2 = `${PACKAGE.replace("shop /2026-10-01", "shop /2026-10-02")}
contract: distTake
  kind: take
  from: dist.example
  offer: catalogOffer
  reads:
    title -> title
    format -> format
  mode: gathered
`;
  const ownerKey = await host.issueKey("shop.example", "shop.example", "owner2");
  const up = await call("POST", "/o/shop.example/install", ownerKey, { bundle: publish(SHOP2, { date: "2026-10-02", key }).bundle });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const took = await call("POST", "/o/shop.example/take/distTake", ownerKey);
  assert.equal(took.status, 200, JSON.stringify(took.body));
  const taken = took.body.taken as JsonObject[];
  assert.equal(taken.length, 1, JSON.stringify(took.body));
  assert.equal(taken[0]?.presenter, "D-1");
  assert.deepEqual(taken[0]?.flows, ["title", "format"]);
  const mine = await call("GET", `/o/shop.example/records/${taken[0]?.record}?full=1`, ownerKey);
  assert.equal((mine.body.values as JsonObject).title, "Gremlins");
  assert.equal(((mine.body.sources as JsonObject).title as JsonObject).owner, "dist.example", "the value keeps the presenter as its owner");
  const shop = await host.storeFor("shop.example");
  const entry = (await shop.entries()).find((e) => isObj(e.by) && e.by.take === "distTake" && (e.writes as JsonObject[]).some((w) => w.address === "title"));
  assert.equal((entry?.by as JsonObject).from, "dist.example/L-2", "the consumer's entry names the presenter's (8.5.1)");
  // Taking again: the same record, bound by the presenter's id; nothing new flows.
  const again = await call("POST", "/o/shop.example/take/distTake", ownerKey);
  assert.equal((again.body.taken as JsonObject[])[0]?.record, taken[0]?.record);
  assert.deepEqual((again.body.taken as JsonObject[])[0]?.flows, []);
  // The stream pushed: the loop POSTs the distributor's entries to the shop's inbox, signed; the cursor moves.
  const pushed = await call("POST", "/push", undefined, { owner: "dist.example" }, { "x-host-key": "hk" });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
  assert.deepEqual(pushed.body, [{ owner: "dist.example", contract: "toShop", acted: true, cursor: { discs: 1 } }]);
  const rows = (await pool.query("select record, row from index_rows where owner = $1 and view = 'discs'", ["dist.example"])).rows as { record: string; row: JsonObject }[];
  assert.deepEqual(rows.map((r) => [r.record, r.row.heading]), [["D-1", "Gremlins"]], "the inbox put the presenter's rows in the index under its name");
  assert.deepEqual((await call("POST", "/push", undefined, { owner: "dist.example" }, { "x-host-key": "hk" })).body, [], "nothing new since the acknowledged cursor");
});

test("a hosted person owns their collection in their own chain, exports and erases it as its owner; the key rotates", { skip: !url }, async () => {
  const staffKey = await host.issueKey("shop.example", "S-1", "staff2");
  const ownerKey = await host.issueKey("shop.example", "shop.example", "owner3");
  // The person's form run mints a collection: the package lets a person own one, so it is theirs.
  const made = await call("POST", "/o/shop.example/run/newCollection", staffKey, { level: "collection", answers: { title: "My shelf" } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = String((made.body.arrival as JsonObject)?.record ?? made.body.record);
  const rec = await call("GET", `/o/shop.example/records/${id}`, staffKey);
  assert.equal(rec.body.owner, "shop.example:S-1", JSON.stringify(rec.body));
  assert.equal((rec.body.values as JsonObject).title, "My shelf");
  // Their chain holds the write, signed with the key the host made for them; the shop's chain holds none of it.
  const mine = await call("GET", "/o/shop.example:S-1/export", staffKey);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const myLog = mine.body.log as JsonObject[];
  assert.equal(myLog.length, 1);
  assert.equal(myLog[0]?.owner, "shop.example:S-1");
  assert.ok((myLog[0]?.writes as JsonObject[]).some((w) => w.record === id && w.address === "title"));
  const wk = await call("GET", "/.well-known/crubal.json");
  assert.ok((wk.body.keys as JsonObject)["shop.example:S-1"], "the host lists the person's key by their id");
  assert.deepEqual(verifyChain(myLog, wk.body.keys as never), { valid: true });
  const shops = await call("GET", "/o/shop.example/export", ownerKey);
  assert.ok(!(shops.body.log as JsonObject[]).some((e) => (e.writes as JsonObject[]).some((w) => w.record === id && w.address === "title")), "nothing of the collection's values in the shop's chain");
  assert.equal((await call("GET", "/o/shop.example:S-1/export", ownerKey)).status, 403, "the shop isn't the person");
  // The person erases their own record and no one else's; the shop's state follows.
  assert.equal((await call("POST", "/o/shop.example:S-1/erase/P-2", staffKey)).status, 403);
  const erased = await call("POST", `/o/shop.example:S-1/erase/${id}`, staffKey);
  assert.equal(erased.status, 200, JSON.stringify(erased.body));
  assert.equal(erased.body.redacted, 1);
  assert.deepEqual(((await call("GET", `/o/shop.example/records/${id}`, staffKey)).body.values as JsonObject), {});
  // Rotation: the old key keeps its span, the new one signs from now, and the chain verifies across it.
  clock = "2026-10-15T23:00:00Z";
  const rotated = await call("POST", "/o/shop.example/rotate", ownerKey);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  clock = "2026-10-15T23:01:00Z";
  const store = await host.storeFor("shop.example");
  await store.commit({ person: "shop.example" }, (d) => {
    d.records.set("P-3", { id: "P-3", kind: "item", level: "product", owner: "shop.example", values: { title: "Elf", format: "DVD" }, sources: { "*": { origin: "declared", via: "L-9" } } });
  }, clock);
  const wk2 = await call("GET", "/.well-known/crubal.json");
  const keys = (wk2.body.keys as JsonObject)["shop.example"] as JsonObject[];
  assert.equal(keys.length, 2);
  assert.equal(keys[0]?.until, "2026-10-15T23:00:00Z");
  assert.equal(keys[1]?.from, "2026-10-15T23:00:00Z");
  assert.equal(keys[1]?.public, rotated.body.public);
  const exp = await call("GET", "/o/shop.example/export", ownerKey);
  assert.deepEqual(verifyChain(exp.body.log as JsonObject[], wk2.body.keys as never), { valid: true }, "entries before and after the rotation verify");
});
