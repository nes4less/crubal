// The reference host over the Postgres store, end to end through HTTP. Skipped without CRUBAL_PG_URL.

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { publish, STANDARD_PACKAGES } from "@cruba/crubal";
import { verifyChain } from "@cruba/crubal";
import type { JsonObject } from "@cruba/crubal";
import { Index } from "../src/indexer.ts";
import { connect, PgStore, testSchema, type Pool } from "@cruba/crubal-postgres";
import { Host } from "../src/host.ts";
import { serve } from "../src/server.ts";

process.env.CRUBAL_SECRETS_KEY = process.env.CRUBAL_SECRETS_KEY ?? "a test secrets key, hashed to 32 bytes";
const url = process.env.CRUBAL_PG_URL;
const isObj = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
let pool: Pool;
let drop: () => Promise<void>;
let base = "";
let host: Host;
let clock = "2026-10-15T22:00:00Z";
/** Documents the test host fetches by URL: well-known files and bundles a publisher would serve. */
const docs = new Map<string, JsonObject>();
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
    secretsKey: "a test secrets key, hashed to 32 bytes",
    now: () => clock,
    fresh: "write",
    resolveKeys: async (domain) => {
      if (domain === "pub.example") return { "pub.example": { alg: "Ed25519", public: key.x } };
      const own = (await host.owners()).find((o) => o.owner === domain);
      return own ? { [domain]: { alg: "Ed25519", public: own.public } } : {};
    },
    hostOf: () => base,
    fetchJson: async (url) => { const d = docs.get(url); if (!d) throw new Error(`no document at ${url}`); return d; },
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
categoryPath&gpc*
soldAt@ymd
amount#currency
condition{NM|VG|G} ranked
itemId$

class: Item
  for: item
  facets:
    !title
    format
    categoryPath
    soldAt
    amount
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
    amount -> amount
filter: format
  facet: format
filter: branch
  facet: categoryPath
filter: month
  facet: soldAt
  buckets: by month
  sum: amount
view: discs
  select:
    level: product
  order: title
  shape: card
  filters: format, branch, month
  index: format
view: slow
  select:
    level: product
  order: title
  shape: card
  fresh: 5m

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
    d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner: "shop.example", values: { title: "Christmas Vacation", format: "DVD", categoryPath: [{ $link: "gpc:1" }, { $link: "gpc:3" }], soldAt: "2026-10-03", amount: { $money: "24.00", currency: "USD" } }, sources: { "*": { origin: "declared", via: "L-1" } } });
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
  { const r = await call("GET", "/o/shop.example/review", staffKey); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  assert.equal((await call("POST", "/o/shop.example/erase/U-1", staffKey)).status, 403);
  const erased = await call("POST", "/o/shop.example/erase/U-1", ownerKey);
  assert.equal(erased.status, 200);
  assert.deepEqual(((await call("GET", "/o/shop.example/records/U-1", ownerKey)).body.values as JsonObject), {});
  // The reference index: the view's page from the stream, counts over the other picks, search, noindex past page 1.
  await store.commit({ person: "shop.example" }, (d) => {
    d.records.set("P-2", { id: "P-2", kind: "item", level: "product", owner: "shop.example", values: { title: "Home Alone", format: "Blu-ray", categoryPath: [{ $link: "gpc:1" }, { $link: "gpc:4" }], soldAt: "2026-10-21", amount: { $money: "9.00", currency: "USD" } }, sources: { "*": { origin: "declared", via: "L-2" } } });
  }, "2026-10-15T22:00:05Z");
  const pageRes = await fetch(`${base}/o/shop.example/v/discs`);
  assert.equal(pageRes.headers.get("x-robots-tag"), "all");
  const page = (await pageRes.json()) as JsonObject;
  assert.deepEqual((page.rows as JsonObject[]).map((r) => r.heading), ["Christmas Vacation", "Home Alone"]);
  assert.deepEqual(page.counts, { format: { DVD: 1, "Blu-ray": 1 } });
  // The tally is kept in the host's table: a fresh index over the same pool, with nothing in memory, answers it.
  const fresh = new Index(pool);
  const again = await fresh.serve(store, "discs", {});
  assert.deepEqual(again.counts, page.counts, "the same counts from the table");
  assert.ok(Number((await pool.query("select count(*)::int as n from index_tallies where owner = $1 and view = $2", ["shop.example", "discs"])).rows[0].n) >= 1, "a tally row kept");
  const picked = await call("GET", "/o/shop.example/v/discs?format=Blu-ray");
  assert.deepEqual((picked.body.rows as JsonObject[]).map((r) => r.heading), ["Home Alone"]);
  assert.deepEqual(picked.body.counts, { format: { DVD: 1, "Blu-ray": 1 } }, "a filter's counts ignore its own pick");
  assert.equal(picked.body.indexable, true, "one index filter, one bucket");
  // A filter with no bucket list (12.3): counted only for the buckets asked for; a pick on one selects.
  const asked = await call("GET", "/o/shop.example/v/discs?count=branch:%26gpc:1,%26gpc:3,%26gpc:9");
  assert.deepEqual(asked.body.counts, { format: { DVD: 1, "Blu-ray": 1 }, branch: { "&gpc:1": 2, "&gpc:3": 1, "&gpc:9": 0 } });
  const branch = await call("GET", "/o/shop.example/v/discs?branch=%26gpc:3");
  assert.deepEqual((branch.body.rows as JsonObject[]).map((r) => r.heading), ["Christmas Vacation"]);
  // Buckets by period with a sum (12.3): the months asked for, counted and totalled; a pick on a month selects.
  const months = await call("GET", "/o/shop.example/v/discs?count=month:2026-10,2026-09");
  assert.deepEqual((months.body.counts as JsonObject).month, { "2026-10": 2, "2026-09": 0 });
  assert.deepEqual(months.body.sums, { month: { "2026-10": { amount: 33 }, "2026-09": { amount: 0 } } });
  const october = await call("GET", "/o/shop.example/v/discs?month=2026-10&format=DVD");
  assert.deepEqual((october.body.rows as JsonObject[]).map((r) => r.heading), ["Christmas Vacation"]);
  const searched = await call("GET", "/o/shop.example/v/discs?q=alone");
  assert.deepEqual((searched.body.rows as JsonObject[]).map((r) => r.heading), ["Home Alone"]);
  assert.equal(searched.body.indexable, false);
  const p2 = await fetch(`${base}/o/shop.example/v/discs?page=2`);
  assert.equal(p2.headers.get("x-robots-tag"), "noindex");

  // The loops, with the host key.
  { const r = await call("POST", "/project", undefined, {}, { "x-host-key": "hk" }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  { const r = await call("POST", "/tick", undefined, {}, { "x-host-key": "hk" }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
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
  { const r = await call("POST", "/o/dist.example/offer/tradeOffer/unpublish", distKey); assert.equal(r.status, 200, JSON.stringify(r.body)); }
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
  assert.deepEqual(pushed.body, [{ owner: "dist.example", contract: "toShop", pages: 1, acted: true, cursor: { discs: 1 } }]);
  const rows = (await pool.query("select record, row from index_rows where owner = $1 and view = 'discs'", ["dist.example"])).rows as { record: string; row: JsonObject }[];
  assert.deepEqual(rows.map((r) => [r.record, r.row.heading]), [["D-1", "Gremlins"]], "the inbox put the presenter's rows in the index under its name");
  assert.deepEqual((await call("POST", "/push", undefined, { owner: "dist.example" }, { "x-host-key": "hk" })).body, [], "nothing new since the acknowledged cursor");
  // The offer names the package version its records were written under (3.8, 10.1).
  assert.equal(offer.body.package, "pub.example/dist /2026-10-01");
  // The version gate: the shop holds dist's package at v1; dist moves to v2 and offers under it; the take is held.
  const distV1 = publish(DIST, { date: "2026-10-01", key }).bundle;
  { const r = await call("POST", "/o/shop.example/install", ownerKey, { bundle: distV1 }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  const distV2 = publish(DIST.replace("dist /2026-10-01", "dist /2026-10-02").replace("cost#USD", "cost#USD\nnotes$"), { date: "2026-10-02", previous: distV1, key }).bundle;
  { const r = await call("POST", "/o/dist.example/install", distKey, { bundle: distV2 }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  const held = await call("POST", "/o/shop.example/take/distTake", ownerKey);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal((held.body.taken as JsonObject[])[0]?.stopped, "version", JSON.stringify(held.body));
  const shopReview = await (await host.storeFor("shop.example")).review();
  assert.ok(shopReview.some((it) => it.key === "version:pub.example/dist" && it.theirs === "2026-10-02" && it.ours === "2026-10-01"), JSON.stringify(shopReview));
  // The shop upgrades to v2: the take goes through again.
  { const r = await call("POST", "/o/shop.example/install", ownerKey, { bundle: distV2 }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  const after = await call("POST", "/o/shop.example/take/distTake", ownerKey);
  assert.equal((after.body.taken as JsonObject[])[0]?.stopped, undefined, JSON.stringify(after.body));
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

test("operations: health, the body limit, CORS for an allowlisted origin, a log line per request, a delayed view published by the loop, and drain", { skip: !url }, async () => {
  const ownerKey = await host.issueKey("shop.example", "shop.example", "owner4");
  const health = await call("GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(Number((health.body.chains as JsonObject)["shop.example"]) > 0, JSON.stringify(health.body));
  assert.ok((health.body.chains as JsonObject)["shop.example:S-1"], "a hosted person's chain is a chain");
  // Bodies over the limit are refused before anything reads them.
  host.o.bodyLimit = 64;
  assert.equal((await call("POST", "/o/shop.example/run/bench", ownerKey, { record: "U-1", answers: { condition: "x".repeat(200) } })).status, 413);
  host.o.bodyLimit = undefined;
  // CORS: an allowlisted origin gets the headers and its preflight; another gets nothing.
  host.o.cors = ["https://app.example"];
  const pre = await fetch(`${base}/o/shop.example/v/discs`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example");
  const other = await fetch(`${base}/o/shop.example/v/discs`, { headers: { origin: "https://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  host.o.cors = undefined;
  // One structured line per request.
  const lines: JsonObject[] = [];
  host.o.log = (l) => lines.push(l);
  await call("GET", "/o/shop.example/records/P-1", ownerKey);
  host.o.log = undefined;
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.route, "o/shop.example/records");
  assert.equal(lines[0]?.status, 200);
  assert.equal(lines[0]?.owner, "shop.example");
  assert.equal(lines[0]?.caller, "shop.example");
  assert.equal(typeof lines[0]?.ms, "number");
  // A view with fresh: 5m isn't published at the write; the loop publishes it when the delay has passed.
  clock = "2026-10-16T10:00:00Z";
  await call("POST", "/project", undefined, { owner: "shop.example", now: clock }, { "x-host-key": "hk" });
  const store = await host.storeFor("shop.example");
  clock = "2026-10-16T10:01:00Z";
  await store.commit({ person: "shop.example" }, (d) => {
    d.records.set("P-9", { id: "P-9", kind: "item", level: "product", owner: "shop.example", values: { title: "Scrooged", format: "DVD" }, sources: { "*": { origin: "declared", via: "L-9" } } });
  }, clock);
  const slowRows = async () => ((await pool.query("select record from projections where owner = $1 and view = 'slow'", ["shop.example"])).rows as { record: string }[]).map((r) => r.record);
  const discRows = async () => ((await pool.query("select record from projections where owner = $1 and view = 'discs'", ["shop.example"])).rows as { record: string }[]).map((r) => r.record);
  assert.ok((await discRows()).includes("P-9"), "fresh: write published at the write");
  assert.ok(!(await slowRows()).includes("P-9"), "fresh: 5m waits for the loop");
  await call("POST", "/project", undefined, { owner: "shop.example", now: "2026-10-16T10:02:00Z" }, { "x-host-key": "hk" });
  assert.ok(!(await slowRows()).includes("P-9"), "two minutes in, still waiting");
  await call("POST", "/project", undefined, { owner: "shop.example", now: "2026-10-16T10:06:00Z" }, { "x-host-key": "hk" });
  assert.ok((await slowRows()).includes("P-9"), "after the delay, published");
  // Drain through the loop.
  await store.commit({ person: "shop.example" }, (d) => {
    d.instructions.set("kind:item/2026-10-16", [{ issuer: "kind:item/2026-10-16", n: 1, op: "+", key: "itemId", map: [] }]);
  }, "2026-10-16T10:07:00Z");
  const drained = await call("POST", "/drain", undefined, { owner: "shop.example", rate: 2 }, { "x-host-key": "hk" });
  assert.equal(drained.status, 200, JSON.stringify(drained.body));
  const d0 = (drained.body as unknown as JsonObject[])[0] as JsonObject;
  assert.equal((d0.applied as string[]).length, 2);
  assert.ok(Number(d0.remaining) >= 1);
});

test("install by name from the publisher's well-known file: the bundle fetched where the file says, what it extends installed first, each verified", { skip: !url }, async () => {
  const key = (globalThis as { pubKey?: { d: string; x: string } }).pubKey as { d: string; x: string };
  const BASE = `package: base /2026-10-01
  owner: pub.example
  crubal: 2
notes$
`;
  const EXT = `package: ext /2026-10-01
  owner: pub.example
  crubal: 2
  extends: base /2026-10-01
kind: thing
  levels: thing
class: Noted
  for: thing
  facets:
    notes
`;
  const baseBundle = publish(BASE, { date: "2026-10-01", key }).bundle;
  const extBundle = publish(EXT, { date: "2026-10-01", key }).bundle;
  docs.set(`${base}/.well-known/crubal.json`, {
    crubal: "2", owner: "pub.example",
    keys: { "pub.example": { alg: "Ed25519", public: key.x } },
    packages: [
      { package: "pub.example/base", latest: "2026-10-01", versions: { "2026-10-01": `${base}/base/2026-10-01/package.json` } },
      { package: "pub.example/ext", latest: "2026-10-01", versions: { "2026-10-01": `${base}/ext/2026-10-01/package.json` } },
    ],
  });
  docs.set(`${base}/base/2026-10-01/package.json`, baseBundle);
  docs.set(`${base}/ext/2026-10-01/package.json`, extBundle);
  await host.createOwner("adopter.example");
  const ownerKey = await host.issueKey("adopter.example", "adopter.example", "owner");
  const r = await call("POST", "/o/adopter.example/install", ownerKey, { package: "pub.example/ext" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const done = r.body.installed as JsonObject[];
  assert.deepEqual(done.map((d) => d.installed), ["pub.example/base", "pub.example/ext"], "the dependency first");
  assert.equal(done[1]?.from, `${base}/ext/2026-10-01/package.json`);
  const store = await host.storeFor("adopter.example");
  assert.deepEqual((await store.installed()).map((i) => `${i.package} /${i.version}`), ["pub.example/base /2026-10-01", "pub.example/ext /2026-10-01"]);
  // Again: nothing to do.
  assert.deepEqual((await call("POST", "/o/adopter.example/install", ownerKey, { package: "pub.example/ext" })).body.installed, []);
  // A tampered bundle is refused: the file's key doesn't sign it.
  docs.set(`${base}/ext/2026-10-01/package.json`, { ...extBundle, label: "tampered" });
  await host.createOwner("other.example");
  const otherKey = await host.issueKey("other.example", "other.example", "owner");
  const bad = await call("POST", "/o/other.example/install", otherKey, { package: "pub.example/ext" });
  assert.notEqual(bad.status, 200);
  assert.match(String(bad.body.error), /doesn't verify/);
});

test("platform-hosted callers (14.8): a person proven by identity is vouched for at every owner on the host, unsigned; an admin grants them within the chain; a caller hosted elsewhere is nobody", { skip: !url }, async () => {
  const key = (globalThis as { pubKey?: { d: string; x: string } }).pubKey as { d: string; x: string };
  // Identity: the provider's subject maps to the person S-1 of shop.example; a stranger maps to a domain this host doesn't hold.
  host.o.verifiers = [async (t) => (t === "tok-S1" ? { owner: "shop.example", caller: "S-1" } : t === "tok-stranger" ? { owner: "elsewhere.example", caller: "Z-1" } : null)];
  const DIST2 = `package: dist /2026-10-03
  owner: pub.example
  crubal: 2

kind: item
  levels: product
  base: Item
kind: person
  levels: person
  base: Person
title$
format{DVD|Blu-ray}
cost#USD
notes$
class: Item
  for: item
  facets:
    !title
    format
    notes
class: Person
  for: person

contract: fix
  kind: form
  origin: declared
  needs:
    !title
    notes

rule: costIsForStaff
  for: everywhere
  strength: must
  then: cost shown to staff

permissions: dist
  menu:
    read: see title, see cost
    fix: run fix, edit title, edit notes
    people: grant read, fix
  presets:
    helper: read, fix    audience: staff
  relations: helper, follower only
`;
  const distKey = await host.issueKey("dist.example", "dist.example", "owner2");
  const inst = await call("POST", "/o/dist.example/install", distKey, { bundle: publish(DIST2, { date: "2026-10-03", key }).bundle });
  assert.equal(inst.status, 200, JSON.stringify(inst.body));
  // Before any edge: the person reaches the owner as a caller (vouched), but sees nothing a member can't.
  const before = await call("GET", "/o/dist.example/records/D-1", "tok-S1");
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body.values, {}, "no edge, no facet shown");
  assert.equal((await call("GET", "/o/dist.example/records/D-1", "tok-stranger")).status, 401, "a person hosted elsewhere is nobody without a signature");
  // An admin of the distributor (not the owner) grants the hosted person the helper preset, within the chain (14.5).
  const dist = await host.storeFor("dist.example");
  await dist.commit({ person: "dist.example" }, (d) => {
    d.records.set("A-1", { id: "A-1", kind: "person", level: "person", owner: "dist.example", values: {} });
    d.edges.set("E-A", { edge: "E-A", who: "A-1", relation: "helper", mode: "admin", on: "D-1", grants: [], by: "owner" });
    d.edges.set("E-P", { edge: "E-P", who: "person:shop.example:S-1", relation: "helper", mode: "control", on: "D-1", grants: ["helper"], by: "E-A" });
  }, "2026-10-16T12:00:00Z");
  const after1 = await call("GET", "/o/dist.example/records/D-1", "tok-S1");
  assert.equal(after1.status, 200, JSON.stringify(after1.body));
  assert.deepEqual(Object.keys(after1.body.values as JsonObject).sort(), ["cost", "format", "title"], "the helper sees what a member sees (title, format) and what read grants above it (cost, staff-only by rule) (12.4, 14.4, 14.6)");
  // The person runs a form the preset opens, unsigned, from another owner's identity.
  const ran = await call("POST", "/o/dist.example/run/fix", "tok-S1", { record: "D-1", answers: { title: "Gremlins 2" } });
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  assert.equal(ran.body.landed, "value", JSON.stringify(ran.body));
  assert.equal(ran.body.caller, "person:shop.example:S-1");
  // A grant beyond the grantor's reach is refused as for any caller (14.12 item 9).
  await assert.rejects(dist.commit({ person: "dist.example" }, (d) => {
    d.edges.set("E-Q", { edge: "E-Q", who: "person:shop.example:S-1", relation: "helper", mode: "admin", on: "D-1", grants: [], by: "E-P" });
  }, "2026-10-16T12:01:00Z"), /E-P holds control, so it can't grant admin/);
  // The log line names the vouched caller.
  const lines: JsonObject[] = [];
  host.o.log = (l) => lines.push(l);
  await call("GET", "/o/dist.example/records/D-1", "tok-S1");
  host.o.log = undefined;
  assert.equal(lines[0]?.caller, "person:shop.example:S-1");
});

test("the platform index: whoami across owners, and the rows a caller stands in a relation to", { skip: !url }, async () => {
  const me = await call("GET", "/whoami", "tok-S1");
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.home, "shop.example");
  const owners = me.body.owners as JsonObject;
  assert.deepEqual(Object.keys(owners).sort(), ["dist.example", "shop.example"]);
  assert.equal((owners["shop.example"] as JsonObject).mode, "control", "the staff edge at home, by bare id");
  assert.deepEqual((owners["dist.example"] as JsonObject).relations, ["helper"]);
  assert.deepEqual((owners["dist.example"] as JsonObject).grants, ["helper"]);
  assert.equal((await call("GET", "/whoami")).status, 401);
  // Rows: the distributor's index rows for D-1 reach the helper through their edge on it.
  const rows = await call("GET", "/whoami/rows?relation=helper", "tok-S1");
  assert.equal(rows.status, 200, JSON.stringify(rows.body));
  assert.deepEqual((rows.body.rows as JsonObject[]).map((r) => [r.owner, r.view, r.record]), [["dist.example", "discs", "D-1"]]);
  assert.deepEqual((await call("GET", "/whoami/rows?relation=follower", "tok-S1")).body.rows, []);
});

test("acting for a person (14.9): a system runs as the person it is allowed to act for, capped to their items, gated until lifted, every entry naming both; without the permission, or beyond it, nothing lands", { skip: !url }, async () => {
  const sysKey = await host.issueKey("shop.example", "S-9", "agent");
  const ownerKey = await host.issueKey("shop.example", "shop.example", "owner5");
  // The system alone reaches nothing at the distributor; a `for` it hasn't been allowed is refused.
  assert.equal((await call("POST", "/o/dist.example/run/fix", sysKey, { record: "D-1", answers: { title: "x" } })).status, 401, "a system doesn't cross owners by itself");
  const notAllowed = await call("POST", "/o/dist.example/run/fix", sysKey, { record: "D-1", for: "shop.example:S-1", answers: { title: "x" } });
  assert.equal(notAllowed.status, 403, JSON.stringify(notAllowed.body));
  // The person allows it, narrowed to `read` only: a run needs `fix`, so it stops at permission.
  const staffKey = await host.issueKey("shop.example", "S-1", "staff3");
  assert.equal((await call("POST", "/o/shop.example:S-1/acting-for", ownerKey, { system: "shop.example:S-9" })).status, 403, "only the person allows");
  const narrow = await call("POST", "/o/shop.example:S-1/acting-for", staffKey, { system: "shop.example:S-9", items: ["read"], gated: false });
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
  const stopped = await call("POST", "/o/dist.example/run/fix", sysKey, { record: "D-1", for: "shop.example:S-1", answers: { title: "x" } });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(stopped.body.stopped, "permission", JSON.stringify(stopped.body));
  // Widened to the whole of what the person holds, still gated: the write lands as a suggestion for the person.
  await call("DELETE", `/o/shop.example:S-1/acting-for/${narrow.body.id}`, staffKey);
  const gated = await call("POST", "/o/shop.example:S-1/acting-for", staffKey, { system: "shop.example:S-9" });
  assert.equal(gated.status, 200);
  const suggested = await call("POST", "/o/dist.example/run/fix", sysKey, { record: "D-1", for: "shop.example:S-1", answers: { notes: "Mogwai, do not feed after midnight" } });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  assert.equal(suggested.body.landed, "suggestion", JSON.stringify(suggested.body));
  assert.equal(suggested.body.gated, "acting-for");
  assert.equal(suggested.body.reviewer, "person:shop.example:S-1");
  const distKey = await host.issueKey("dist.example", "dist.example", "owner3");
  assert.equal(((await call("GET", "/o/dist.example/records/D-1", distKey)).body.values as JsonObject).notes, undefined, "a suggestion isn't the value");
  // The gate lifted: the write lands, and the entry names the system as caller and the person as for.
  await call("DELETE", `/o/shop.example:S-1/acting-for/${gated.body.id}`, staffKey);
  const lifted = await call("POST", "/o/shop.example:S-1/acting-for", staffKey, { system: "shop.example:S-9", gated: false, until: "2026-12-31T00:00:00Z" });
  const landed = await call("POST", "/o/dist.example/run/fix", sysKey, { record: "D-1", for: "shop.example:S-1", answers: { notes: "Mogwai, do not feed after midnight" } });
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.landed, "value", JSON.stringify(landed.body));
  const dist = await host.storeFor("dist.example");
  // The entry sits in the distributor's log (the run's own id is the border's); found by what it says.
  const entry = (await dist.entries()).filter((e) => isObj(e.by) && e.by.for === "person:shop.example:S-1" && (e.writes as JsonObject[]).some((w) => w.record === "D-1" && w.address === "notes" && w.as === undefined)).at(-1);
  assert.ok(entry, "the entry is in the distributor's log");
  assert.equal((entry?.by as JsonObject).caller, "shop.example:S-9");
  assert.equal((entry?.by as JsonObject).for, "person:shop.example:S-1");
  const rec = await call("GET", "/o/dist.example/records/D-1", distKey);
  assert.equal((rec.body.values as JsonObject).notes, "Mogwai, do not feed after midnight");
  // Revoked: the next run is refused; the row keeps when.
  assert.deepEqual((await call("DELETE", `/o/shop.example:S-1/acting-for/${lifted.body.id}`, staffKey)).body, { revoked: true });
  assert.equal((await call("POST", "/o/dist.example/run/fix", sysKey, { record: "D-1", for: "shop.example:S-1", answers: { title: "x" } })).status, 403);
  const listed = await call("GET", "/o/shop.example:S-1/acting-for", staffKey);
  assert.equal((listed.body.allowed as JsonObject[]).length, 3);
  assert.ok((listed.body.allowed as JsonObject[]).every((a) => typeof a.revoked === "string"));
  // At home the person is their bare id: the same system acting for them on the shop's own form.
  const home = await call("POST", "/o/shop.example:S-1/acting-for", staffKey, { system: "shop.example:S-9", gated: false });
  const atHome = await call("POST", "/o/shop.example/run/bench", sysKey, { record: "U-1", for: "shop.example:S-1", answers: { condition: "NM" } });
  assert.equal(atHome.status, 200, JSON.stringify(atHome.body));
  assert.equal(atHome.body.caller, "S-1");
  assert.equal(atHome.body.landed, "value", JSON.stringify(atHome.body));
  await call("DELETE", `/o/shop.example:S-1/acting-for/${home.body.id}`, staffKey);
});

test("a hosted person's chain takes a package of its own (14.1): installed there, its definitions are theirs", { skip: !url }, async () => {
  const key = (globalThis as { pubKey?: { d: string; x: string } }).pubKey as { d: string; x: string };
  const PERSON = `package: mine /2026-10-16
  owner: pub.example
  crubal: 2
kind: cart
  levels: cart
  base: Cart
cartState{open|ordered}
class: Cart
  for: cart
  facets:
    cartState
ownership:
  person: cart
`;
  const r = await host.install("shop.example:S-1", publish(PERSON, { date: "2026-10-16", key }).bundle);
  assert.equal(r.installed, "pub.example/mine");
  const mine = await host.storeFor("shop.example:S-1");
  const p = await mine.definitions();
  assert.equal(p.dict.levels.get("cart"), "cart");
  assert.deepEqual(p.perms.ownership.get("person"), ["cart"]);
  const shop = await host.storeFor("shop.example");
  assert.equal((await shop.definitions()).dict.levels.get("cart"), undefined, "the shop's definitions are untouched");
  const health = await call("GET", "/health");
  assert.ok(Number((health.body.chains as JsonObject)["shop.example:S-1"]) >= 2, "the install is an entry in the person's chain");
});

test("installFromOwner copies a package and what it extends from one owner's log into another's; a persistent border mints an arrival's id as the owner's next number", { skip: !url }, async () => {
  const key = (globalThis as { pubKey?: { d: string; x: string } }).pubKey as { d: string; x: string };
  const BASE = `package: ground /2026-10-16
  owner: pub.example
  crubal: 2
kind: person
  levels: person
  base: Person
name$
class: Person
  for: person
  facets:
    !name
contract: join
  kind: form
  origin: declared
  needs:
    !name
`;
  const TOP = `package: top /2026-10-16
  owner: pub.example
  crubal: 2
  extends: ground /2026-10-16
kind: note
  levels: note
body$
class: Note
  for: note
  facets:
    body
ownership:
  person: note
`;
  await host.createOwner("platform.example");
  const platform = await host.storeFor("platform.example");
  await platform.install(publish(BASE, { date: "2026-10-16", key }).bundle, { "pub.example": { alg: "Ed25519", public: key.x } }, "2026-10-16T12:00:00Z");
  await platform.install(publish(TOP, { date: "2026-10-16", key }).bundle, { "pub.example": { alg: "Ed25519", public: key.x } }, "2026-10-16T12:00:01Z");
  // Two arrivals through the border: the second is P-2, not a second P-NEW1.
  const border = await host.borderFor("platform.example", platform);
  const first = await border.arrive("join", JSON.stringify({ name: "One" }), "person", undefined, undefined, "2026-10-16T12:00:02Z");
  const second = await border.arrive("join", JSON.stringify({ name: "Two" }), "person", undefined, undefined, "2026-10-16T12:00:03Z");
  const idOf = (r: JsonObject) => String((r.arrival as JsonObject).record);
  assert.equal(idOf(first), "P-1");
  assert.equal(idOf(second), "P-2");
  assert.equal((await platform.get("P-2"))?.values.name, "Two");
  // The person's chain takes `top` from the platform: `ground` first, then `top`; again, nothing.
  await host.createOwner("platform.example:P-2");
  const done = await host.installFromOwner("platform.example:P-2", "platform.example", "pub.example/top");
  assert.deepEqual(done.map((d) => d.installed), ["pub.example/ground", "pub.example/top"]);
  assert.deepEqual(await host.installFromOwner("platform.example:P-2", "platform.example", "pub.example/top"), []);
  const chain = await host.storeFor("platform.example:P-2");
  assert.equal((await chain.definitions()).dict.levels.get("note"), "note");
  await assert.rejects(host.installFromOwner("platform.example:P-2", "platform.example", "pub.example/nothing"), /holds no pub.example\/nothing/);
});

test("publishing (11.5, 11.7): a package the host signs with the owner's key is listed in the well-known file, served, installed by name from it with its dependency first, and refused when tampered", { skip: !url }, async () => {
  host.o.publicBase = base;
  const GROUND = `package: ground /2026-10-17
  owner: shop.example
  crubal: 2
notes$
`;
  const TOWER = `package: tower /2026-10-17
  owner: shop.example
  crubal: 2
  extends: ground /2026-10-17
kind: thing
  levels: thing
class: Noted
  for: thing
  facets:
    notes
`;
  const g = await host.publishPackage("shop.example", GROUND);
  const t = await host.publishPackage("shop.example", TOWER);
  assert.equal(g.already, false);
  assert.equal(typeof t.bundle.sig, "string", "signed with the owner's host-held key");
  assert.deepEqual((await host.publishPackage("shop.example", TOWER)).already, true, "a version publishes once");
  const wk = await call("GET", "/.well-known/crubal.json");
  const listed = (wk.body.packages as JsonObject[]).find((p) => p.package === "shop.example/tower");
  assert.ok(listed, JSON.stringify(wk.body.packages));
  assert.equal(listed?.latest, "2026-10-17");
  const where = String((listed?.versions as JsonObject)["2026-10-17"]);
  assert.equal(where, `${base}/packages/shop.example/tower/2026-10-17/package.json`);
  const served = await fetch(where);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(((await served.json()) as JsonObject).hash, t.bundle.hash);
  const text = await fetch(where.replace("package.json", "package.crubal"));
  assert.equal(await text.text(), TOWER);
  // Install by name into a fresh owner, reading this host's own well-known file and bundles over HTTP.
  const was = host.o.fetchJson;
  host.o.fetchJson = async (u) => (u.startsWith(base) ? ((await (await fetch(u)).json()) as JsonObject) : (was as (u: string) => Promise<JsonObject>)(u));
  try {
    await host.createOwner("fresh.example");
    const freshKey = await host.issueKey("fresh.example", "fresh.example", "owner");
    const r = await call("POST", "/o/fresh.example/install", freshKey, { package: "shop.example/tower" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((r.body.installed as JsonObject[]).map((d) => d.installed), ["shop.example/ground", "shop.example/tower"], "the dependency first");
    const defs = await (await host.storeFor("fresh.example")).definitions();
    assert.equal(defs.dict.levels.get("thing"), "thing");
    // Tampered on the wire: the signature doesn't verify against the published key, nothing installs.
    const inner = host.o.fetchJson;
    host.o.fetchJson = async (u) => { const d = await (inner as (u: string) => Promise<JsonObject>)(u); return u.endsWith("tower/2026-10-17/package.json") ? { ...d, label: "tampered" } : d; };
    await host.createOwner("fresh2.example");
    const k2 = await host.issueKey("fresh2.example", "fresh2.example", "owner");
    const bad = await call("POST", "/o/fresh2.example/install", k2, { package: "shop.example/tower" });
    assert.notEqual(bad.status, 200);
    assert.match(String(bad.body.error), /doesn't verify/);
  } finally {
    host.o.fetchJson = was;
    host.o.publicBase = undefined;
  }
});

test("connections (brief 4): material is sealed at rest and never stored without a key; connect writes the system record within ROOT naming the person; revoke marks it and the adapter's secret is gone; the item or admin is required", { skip: !url }, async () => {
  await host.createOwner("conn.example");
  // The packages go in unsigned through a development store; the host's own store reads the same log.
  const dev = new PgStore(pool, "conn.example", { allowUnsigned: true });
  const store = await host.storeFor("conn.example");
  for (const text of [STANDARD_PACKAGES.core, STANDARD_PACKAGES.units, STANDARD_PACKAGES.party])
    await dev.install(publish(text, { date: text.match(/^package: \S+ \/(\S+)/m)?.[1] ?? "2026-10-16" }).bundle, undefined, clock);
  const perms = `package: shopperms /2026-10-01
  owner: conn.example
  label: Perms
  crubal: 2
  extends: crubal.com/party /2026-10-16

kind: shop
  levels: shop
  base: Shop

shopName$

class: Shop
  for: shop
  facets:
    shopName

permissions: shopperms
  menu:
    connections: run connect, edit System
  presets:
    keeper: connections   audience: staff
  relations: operator, staff, customer
`;
  await dev.install(publish(perms, { date: "2026-10-01" }).bundle, undefined, clock);
  await store.commit({ person: "conn.example" }, (d) => {
    d.records.set("ROOT", { id: "ROOT", kind: "shop", level: "shop", owner: "conn.example", values: { shopName: "Conn" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    d.edges.set("E-a", { edge: "E-a", who: "person:cashierfu.com:P-1", relation: "operator", mode: "admin", on: "ROOT", grants: [], by: "owner" });
    d.edges.set("E-k", { edge: "E-k", who: "person:cashierfu.com:P-2", relation: "staff", mode: "control", on: "ROOT", grants: ["keeper"], by: "E-a" });
    d.edges.set("E-m", { edge: "E-m", who: "person:cashierfu.com:P-3", relation: "customer", mode: "consume", on: "ROOT", grants: [], by: "E-a" });
  }, clock);
  // The admin connects; the row is ciphertext; the record names the person and sits within ROOT.
  const r = await host.connect("conn.example", "stripe", { scheme: "apikey", material: { key: "sk_test_SECRET123" }, person: "person:cashierfu.com:P-1", values: { accountLabel: "Conn Test" } });
  assert.equal(r.record, "S-1");
  const row = (await pool.query("select material from host_credentials where owner = $1 and name = $2", ["conn.example", "stripe"])).rows[0] as { material: JsonObject };
  assert.equal(row.material.$sealed, 1);
  assert.ok(!JSON.stringify(row.material).includes("SECRET123"), "the stored row holds no key material");
  assert.equal(await host.secret("conn.example", "stripe"), "sk_test_SECRET123", "the host opens it for an adapter");
  const rec = await store.get("S-1");
  assert.equal(rec?.within, "ROOT");
  assert.equal(rec?.values.connection, "connected");
  assert.equal(rec?.values.scheme, "apikey");
  assert.equal(rec?.values.accountLabel, "Conn Test");
  const entries = (await store.entries()) as { by?: { platform?: string; person?: string } }[];
  assert.ok(entries.some((e) => e.by?.platform === "connection" && e.by?.person === "person:cashierfu.com:P-1"));
  assert.ok(!JSON.stringify(await store.entries()).includes("SECRET123"), "no secret in the log");
  assert.equal(await host.connected("conn.example", "stripe"), true);
  // The keeper may; the member may not.
  await host.connect("conn.example", "shippo", { scheme: "apikey", material: { key: "shippo_test_1" }, person: "person:cashierfu.com:P-2" });
  await assert.rejects(host.connect("conn.example", "resend", { scheme: "apikey", material: { key: "re_1" }, person: "person:cashierfu.com:P-3" }), /may not manage/);
  await assert.rejects(host.disconnect("conn.example", "stripe", "person:cashierfu.com:P-3"), /may not manage/);
  // Revoke: the material gone, the record marked, connected false.
  await host.disconnect("conn.example", "stripe", "person:cashierfu.com:P-1");
  assert.equal(await host.secret("conn.example", "stripe"), undefined);
  assert.equal((await store.get("S-1"))?.values.connection, "revoked");
  assert.equal(await host.connected("conn.example", "stripe"), false);
  // Without a key nothing is stored; a row from before sealing is sealed by migrate.
  const saved = process.env.CRUBAL_SECRETS_KEY;
  process.env.CRUBAL_SECRETS_KEY = "";
  const bare = new Host(pool, { domain: "cashierfu.com", hostKey: "hk", now: () => clock, log: false });
  process.env.CRUBAL_SECRETS_KEY = saved;
  await assert.rejects(bare.credentials.connect("conn.example", "resend", "apikey", { key: "re_2" }), /secrets key is required/);
  await pool.query("insert into host_credentials (owner, name, scheme, material, scopes, expires, connected) values ($1, $2, $3, $4, $5, null, $6)", ["conn.example", "legacy", "apikey", { key: "plain_old_key" }, [], clock]);
  await host.migrate();
  const sealed = (await pool.query("select material from host_credentials where owner = $1 and name = $2", ["conn.example", "legacy"])).rows[0] as { material: JsonObject };
  assert.equal(sealed.material.$sealed, 1);
  assert.equal(await host.secret("conn.example", "legacy"), "plain_old_key");
});

test("the root is the last ancestor (14.2, 12.6): a staff view served to a caller whose edge is on ROOT lists the records that name no within, as it lists those within ROOT; a member is still refused the view", async () => {
  await host.createOwner("root.example");
  const dev = new PgStore(pool, "root.example", { allowUnsigned: true });
  const store = await host.storeFor("root.example");
  for (const text of [STANDARD_PACKAGES.core, STANDARD_PACKAGES.units, STANDARD_PACKAGES.party])
    await dev.install(publish(text, { date: text.match(/^package: \S+ \/(\S+)/m)?.[1] ?? "2026-10-16" }).bundle, undefined, clock);
  const pkg = `package: rootshelf /2026-10-01
  owner: root.example
  label: Shelf
  crubal: 2
  extends: crubal.com/party /2026-10-16

kind: shop
  levels: shop
  base: Shop
kind: item
  levels: product
  base: Item

shopName$
title$

class: Shop
  for: shop
  facets:
    shopName
class: Item
  for: item
  facets:
    !title

shape: card
  slots:
    !title -> heading
view: shelf
  select:
    level: product
  order: title
  shape: card
  show: staff

permissions: rootshelf
  menu:
    keep: edit title
  presets:
    keeper: keep   audience: staff
  relations: operator, staff, customer
`;
  await dev.install(publish(pkg, { date: "2026-10-01" }).bundle, undefined, clock);
  await store.commit({ person: "root.example" }, (d) => {
    d.records.set("ROOT", { id: "ROOT", kind: "shop", level: "shop", owner: "root.example", values: { shopName: "Root" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    d.edges.set("E-a", { edge: "E-a", who: "person:cashierfu.com:P-1", relation: "operator", mode: "admin", on: "ROOT", grants: [], by: "owner" });
    d.edges.set("E-k", { edge: "E-k", who: "person:cashierfu.com:P-2", relation: "staff", mode: "control", on: "ROOT", grants: ["keeper"], by: "E-a" });
    d.edges.set("E-m", { edge: "E-m", who: "person:cashierfu.com:P-3", relation: "customer", mode: "consume", on: "ROOT", grants: [], by: "E-a" });
    // P-1 names no within, as a converted catalog's records do; P-2 was made within ROOT, as the app makes them.
    d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner: "root.example", values: { title: "Gremlins" }, sources: { "*": { origin: "declared", via: "L-1" } } });
    d.records.set("P-2", { id: "P-2", kind: "item", level: "product", owner: "root.example", within: "ROOT", values: { title: "Home Alone" }, sources: { "*": { origin: "declared", via: "L-1" } } });
  }, clock);
  const index = new Index(pool);
  await index.apply(store, "shelf");
  const headings = async (caller: string) => ((await index.serve(store, "shelf", { caller })).rows as JsonObject[]).map((r) => r.heading);
  assert.deepEqual(await headings("root.example"), ["Gremlins", "Home Alone"], "the owner reads everything");
  assert.deepEqual(await headings("person:cashierfu.com:P-1"), ["Gremlins", "Home Alone"], "the admin on ROOT sees the record that names no within");
  assert.deepEqual(await headings("person:cashierfu.com:P-2"), ["Gremlins", "Home Alone"], "staff with control on ROOT too");
  await assert.rejects(headings("person:cashierfu.com:P-3"), /shelf is for staff/, "a member is below the view");
  // The row written for P-1 carries ROOT as its ancestor, so a fresh index over the rows matches it as well.
  const row = (await pool.query("select ancestors from index_rows where owner = $1 and view = 'shelf' and record = 'P-1'", ["root.example"])).rows[0] as { ancestors: string[] } | undefined;
  assert.deepEqual(row?.ancestors, ["ROOT"]);
});


test("brief 40: a request that declines a backlog leaves a cursor at 0 for a view never built; `behind` lists the views behind their stream, most behind first; a budgeted apply catches a view up a page at a time and nothing is behind after", { skip: !url }, async () => {
  const store = await host.storeFor("root.example");
  const index = new Index(pool);
  await store.commit({ person: "root.example" }, (d) => {
    for (const [id, title] of [["P-3", "Jaws"], ["P-4", "Alien"], ["P-5", "Heat"]] as const)
      d.records.set(id, { id, kind: "item", level: "product", owner: "root.example", within: "ROOT", values: { title }, sources: { "*": { origin: "declared", via: "L-1" } } });
  }, clock);
  // A cursor past the stream (the view was built): a request past the limit serves what stands and the cursor stays.
  const before = Number(((await pool.query("select seq from index_cursors where owner = 'root.example' and view = 'shelf'")).rows[0] as { seq: string }).seq);
  assert.equal(await index.apply(store, "shelf", { unlessBehind: 0 }), before, "declined: the cursor as it stood");
  const behind = await index.behind(store);
  assert.deepEqual(behind.map((b) => [b.view, b.audience, b.seq > 0, b.head > b.seq]), [["shelf", "staff", true, true]]);
  // No cursor at all (a view never asked for): a declining request writes the want marker at 0.
  await pool.query("delete from index_cursors where owner = 'root.example' and view = 'shelf'");
  assert.equal(await index.apply(store, "shelf", { unlessBehind: 0 }), 0);
  const marked = await index.behind(store);
  assert.equal(marked.length, 1);
  assert.equal(marked[0]?.seq, 0, "the marker: asked for, never built");
  // The loop's apply, within a budget: a page lands even when the budget is already spent, and the view is caught up.
  const seq = await index.apply(store, "shelf", { budgetMs: 0 });
  assert.equal(seq, marked[0]?.head);
  assert.deepEqual(await index.behind(store), [], "nothing behind");
  const rows = (await pool.query("select record from index_rows where owner = 'root.example' and view = 'shelf' order by record")).rows as { record: string }[];
  assert.deepEqual(rows.map((r) => r.record), ["P-1", "P-2", "P-3", "P-4", "P-5"]);
});
