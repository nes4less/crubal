// The host's remaining pieces: the OIDC verifier, signed requests between owners, credentials with the
// OAuth flow, terms as robots rules and headers, the retry loop, and emergency access. Pure pieces run
// anywhere; the ones over the store skip without CRUBAL_PG_URL.

import assert from "node:assert/strict";
import { entryHash, keyFor, verifySig } from "@cruba/crubal";
import { createHmac, createPrivateKey, createSign, generateKeyPairSync, sign as edSign } from "node:crypto";
import { after, before, test } from "node:test";
import type { JsonObject } from "@cruba/crubal";
import { connect, testSchema, type Pool } from "@cruba/crubal-postgres";
import { PgBorder } from "@cruba/crubal-postgres";
import { readContracts } from "@cruba/crubal";
import { emptyDictionary, readDefinitions } from "@cruba/crubal";
import { checkEmergency, edgeHash, endEmergencyEdge, logEmergencyRead, makeEmergencyEdge, type EmergencyRequest } from "../src/emergency.ts";
import { Host } from "../src/host.ts";
import { oidcVerifier, verifyJwt } from "../src/oidc.ts";
import { signRequest, verifyRequest } from "../src/signatures.ts";
import { readTerms, robotsTxt, termsHeaders } from "../src/terms.ts";

const url = process.env.CRUBAL_PG_URL;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const jwt = (header: object, claims: object, signer: (signed: Buffer) => Buffer) => {
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(signer(Buffer.from(`${h}.${p}`)))}`;
};

test("the OIDC verifier: ES256 by JWKS and HS256 by secret, with issuer, audience and expiry", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", alg: "ES256" } as never;
  const now = 1_800_000_000;
  const es = jwt({ alg: "ES256", kid: "k1", typ: "JWT" }, { iss: "https://id.example", aud: "authenticated", sub: "user-1", exp: now + 60 }, (signed) => {
    const s = createSign("sha256").update(signed).sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
    return s;
  });
  const o = { issuer: "https://id.example", audience: "authenticated", jwks: [jwk], now: () => now };
  assert.equal((await verifyJwt(es, o))?.sub, "user-1");
  assert.equal(await verifyJwt(es, { ...o, now: () => now + 120 }), null, "expired");
  assert.equal(await verifyJwt(es, { ...o, issuer: "https://other.example" }), null, "another issuer");
  assert.equal(await verifyJwt(es, { ...o, audience: "service" }), null, "another audience");
  const hs = jwt({ alg: "HS256", typ: "JWT" }, { iss: "https://id.example", sub: "user-2", exp: now + 60 }, (signed) => createHmac("sha256", "shared").update(signed).digest());
  assert.equal((await verifyJwt(hs, { issuer: "https://id.example", secret: "shared", now: () => now }))?.sub, "user-2");
  assert.equal(await verifyJwt(hs, { issuer: "https://id.example", secret: "wrong", now: () => now }), null);
  const verifier = oidcVerifier({ ...o, provider: "id", identity: async (_p, sub) => (sub === "user-1" ? { owner: "shop.example", caller: "C-1" } : null) });
  assert.deepEqual(await verifier(es), { owner: "shop.example", caller: "C-1" });
  assert.equal(await verifier("ck_notajwt"), null);
});

test("signed requests between owners: made with the domain key, verified with the published half", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = privateKey.export({ format: "jwk" }).d as string;
  const x = publicKey.export({ format: "jwk" }).x as string;
  const body = '{"take":"catalogOffer"}';
  const headers = signRequest({ method: "POST", url: "https://a.example/o/a.example/receive/catalogTake", body, keyid: "b.example", privateD: d, publicX: x, created: 1_800_000_000 });
  const publicX = async (keyid: string) => (keyid === "b.example" ? x : undefined);
  const ok = await verifyRequest({ method: "POST", url: "https://a.example/o/a.example/receive/catalogTake", body, headers, publicX, now: 1_800_000_010 });
  assert.deepEqual(ok, { keyid: "b.example", created: 1_800_000_000 });
  assert.equal(await verifyRequest({ method: "POST", url: "https://a.example/o/a.example/receive/catalogTake", body: '{"take":"other"}', headers, publicX, now: 1_800_000_010 }), null, "another body");
  assert.equal(await verifyRequest({ method: "POST", url: "https://a.example/o/a.example/receive/other", body, headers, publicX, now: 1_800_000_010 }), null, "another target");
  assert.equal(await verifyRequest({ method: "POST", url: "https://a.example/o/a.example/receive/catalogTake", body, headers, publicX, now: 1_800_001_000 }), null, "too old");
  assert.equal(await verifyRequest({ method: "POST", url: "https://a.example/o/a.example/receive/catalogTake", body, headers, publicX: async () => undefined, now: 1_800_000_010 }), null, "no key");
});

test("terms become robots rules and headers", () => {
  const t = readTerms({ public: "search yes, answer yes, train no" });
  assert.deepEqual(t, { public: { search: true, answer: true, train: false } });
  const robots = robotsTxt(t, "/o/shop.example/");
  assert.match(robots, /User-agent: GPTBot\nDisallow: \/o\/shop.example\//);
  assert.match(robots, /User-agent: \*\nAllow: \//);
  assert.equal(termsHeaders(t)["x-robots-tag"], "noai, noimageai");
  assert.equal(termsHeaders(readTerms({ public: "search no" }))["x-robots-tag"], "noindex");
  assert.match(robotsTxt(readTerms({ public: "search no" })), /User-agent: \*\nDisallow: \//);
  assert.equal(termsHeaders(readTerms({}))["x-robots-tag"], undefined);
});

test("emergency access is checked against the terms", () => {
  const a1 = generateKeyPairSync("ed25519");
  const a2 = generateKeyPairSync("ed25519");
  const pub = (k: typeof a1) => ({ alg: "Ed25519", public: k.publicKey.export({ format: "jwk" }).x as string });
  const terms = { approvers: 2, longest: "PT24H", keys: { "platform.example:S-02": pub(a1), "platform.example:S-31": pub(a2) } };
  const base: EmergencyRequest = { edge: "E-9001", who: "platform.example:S-14", mode: "view", on: "R-ROOT", until: "2026-10-16T12:00:00Z", kind: "incident", reason: "Card-skimming script reported", reference: "INC-2026-114", approvals: [] };
  const approve = (r: EmergencyRequest, who: string, k: typeof a1) => ({ by: who, sig: edSign(null, Buffer.from(edgeHash(r), "hex"), k.privateKey).toString("base64url") });
  const now = "2026-10-15T18:00:00Z";
  const good = { ...base, approvals: [approve(base, "platform.example:S-02", a1), approve(base, "platform.example:S-31", a2)] };
  assert.deepEqual(checkEmergency(good, terms, now), []);
  assert.ok(checkEmergency({ ...good, approvals: good.approvals.slice(0, 1) }, terms, now).some((w) => /2 approvers/.test(w)));
  assert.ok(checkEmergency({ ...good, approvals: [good.approvals[0] as never, approve(base, "platform.example:S-14", a1)] }, terms, now).some((w) => /requester/.test(w)));
  assert.ok(checkEmergency({ ...good, mode: "admin" as never }, terms, now).some((w) => /never admin/.test(w)));
  assert.ok(checkEmergency({ ...good, until: "2026-10-18T12:00:00Z" }, terms, now).some((w) => /later than the terms/.test(w)));
  assert.ok(checkEmergency(good, undefined, now).some((w) => /no emergency terms/.test(w)));
  const tampered = { ...good, reason: "Something else" };
  assert.ok(checkEmergency(tampered, terms, now).some((w) => /doesn't verify/.test(w)), "approvals are over the edge as made");
});

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

test("credentials: connected, expired, refreshed through the provider; the retry loop; emergency edges in the log", { skip: !url }, async () => {
  const clock = { now: "2026-10-15T23:00:00Z" };
  const notices: JsonObject[] = [];
  let tokenCalls = 0;
  const fetchFake = (async (_u: string | URL | Request, init?: RequestInit) => {
    tokenCalls += 1;
    const p = new URLSearchParams(String(init?.body));
    return new Response(JSON.stringify({ access_token: `tok-${p.get("grant_type")}-${tokenCalls}`, refresh_token: "r-2", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const host = new Host(pool, { domain: "host.example", now: () => clock.now, notify: (_o, n) => { notices.push(n); }, oauth: { market: { authorizeUrl: "https://auth.example/authorize", tokenUrl: "https://auth.example/token", clientId: "cid", clientSecret: "csec", redirectUri: "https://host.example/oauth/callback" } } });
  await host.migrate();
  await host.createOwner("shop.example");
  // A pasted key, then an OAuth connection: the fact is visible, the secret resolves, expiry is honoured.
  await host.credentials.connect("shop.example", "printer", "apikey", { key: "pk-1" });
  assert.equal(await host.secret("shop.example", "printer"), "pk-1");
  const c = await host.credentials.exchangeCode("shop.example", "market", "code-1", host.o.oauth?.market as never, ["sell"], fetchFake);
  assert.equal(c.status, "connected");
  assert.equal(await host.secret("shop.example", "market"), "tok-authorization_code-1");
  assert.deepEqual((await host.credentials.connections("shop.example")).map((x) => `${x.name}:${x.scheme}:${x.status}`), ["printer:apikey:connected", "market:oauth2:connected"]);
  clock.now = "2026-10-16T01:00:00Z";
  assert.equal((await host.credentials.connection("shop.example", "market"))?.status, "expired");
  // Refresh goes through the provider; the fake fetch stands in for it here.
  const { Credentials } = await import("../src/credentials.ts");
  const creds = new Credentials(pool, () => clock.now);
  const refreshed = await (creds as unknown as { refresh: (o: string, n: string, r: string, p: unknown, f: typeof fetch) => Promise<string | undefined> }).refresh("shop.example", "market", "r-1", host.o.oauth?.market, fetchFake);
  assert.equal(refreshed, "tok-refresh_token-2");
  assert.equal((await host.credentials.connection("shop.example", "market"))?.status, "connected");
  assert.match(host.credentials.authorizeUrl("shop.example", "market", host.o.oauth?.market as never, ["sell"]), /^https:\/\/auth\.example\/authorize\?response_type=code&client_id=cid/);

  // The retry loop: a failing adapter, retry: 1 every 10m, retried only when the interval has passed; dead runs noticed.
  const dict = emptyDictionary();
  readDefinitions("kind: item\n  levels: product\n  base: Item\ntitle$\nclass: Item\n  for: item\n  facets:\n    title\n", dict);
  const text = "contract: label\n  kind: send\n  writes:\n    title -> Title\n  retry: 1 every 10m\n";
  readDefinitions(text, dict);
  const store = await host.storeFor("shop.example");
  await store.commit({ person: "shop.example" }, (d) => { d.records.set("P-1", { id: "P-1", kind: "item", level: "product", owner: "shop.example", values: { title: "Christmas Vacation" }, sources: { "*": { origin: "declared", via: "L-1" } } }); }, clock.now);
  const failing = new PgBorder(store, { dict, contracts: readContracts(text), adapters: { label: async () => ({ failed: "printer offline" }) } });
  const first = await failing.send("label", "P-1", undefined, clock.now);
  assert.equal(first.failed, true);
  // The host's loop builds its border from the store's definitions, which hold no contracts here, so give it the adapter through options.
  host.o.adapters = { label: async () => ({ failed: "printer offline" }) };
  const soon = await host.retry("2026-10-16T01:05:00Z", "shop.example");
  assert.deepEqual(soon, [], "not yet: the interval hasn't passed");
  // definitions from the store know no contract `label`; the host's loop needs it there, so define it (and its facet).
  await store.define({ facet: "title", type: "text" }, { person: "shop.example" }, clock.now);
  await store.define({ contract: "label", kind: "send", writes: [{ from: "title", to: "Title" }], retry: { times: "1", every: "10m" } }, { person: "shop.example" }, clock.now);
  const later = await host.retry("2026-10-16T01:20:00Z", "shop.example");
  assert.equal(later.length, 1);
  assert.equal(later[0]?.dead, true);
  assert.ok(notices.some((n) => n.dead === first.log), "the owner is told of a dead run");

  // Emergency: made under the terms into the owner's log, witnessed; a read under it is logged; the owner ends it.
  const a1 = generateKeyPairSync("ed25519");
  const a2 = generateKeyPairSync("ed25519");
  const pub = (k: typeof a1) => ({ alg: "Ed25519", public: k.publicKey.export({ format: "jwk" }).x as string });
  host.o.emergency = { approvers: 2, longest: "PT24H", keys: { "platform.example:S-02": pub(a1), "platform.example:S-31": pub(a2) } };
  const req: EmergencyRequest = { edge: "E-9001", who: "platform.example:S-14", mode: "view", on: "P-1", until: "2026-10-16T20:00:00Z", kind: "incident", reason: "Card-skimming script reported", reference: "INC-2026-114", approvals: [] };
  const approve = (who: string, k: typeof a1) => ({ by: who, sig: edSign(null, Buffer.from(edgeHash(req), "hex"), k.privateKey).toString("base64url") });
  req.approvals = [approve("platform.example:S-02", a1), approve("platform.example:S-31", a2)];
  const made = await makeEmergencyEdge(store, req, host.o.emergency, "2026-10-16T02:00:00Z");
  const entries = await store.entries();
  const edgeEntry = entries.find((e) => e.log === made.entry) as JsonObject;
  assert.equal(edgeEntry.witnessed, true);
  await logEmergencyRead(store, "platform.example:S-14", "P-1", "E-9001", "2026-10-16T02:01:00Z");
  const state = await store.state();
  assert.deepEqual(state.reads.map((r) => r.record), ["P-1"]);
  assert.ok((await store.entries()).at(-1)?.witnessed, "the read is witnessed");
  const ended = await endEmergencyEdge(store, "E-9001", "shop.example", "2026-10-16T02:02:00Z", true);
  assert.deepEqual(ended, { ended: true });
  assert.equal((await store.state()).edges.has("E-9001"), false);
  await assert.rejects(store.redact(String(made.entry)), /witnessed/, "a witnessed entry is never redacted");
  void createPrivateKey;
});

test("a rotated key verifies only inside its span: an entry signed with the retired key after until is refused", () => {
  const pair = () => { const { privateKey, publicKey } = generateKeyPairSync("ed25519"); return { priv: privateKey, x: publicKey.export({ format: "jwk" }).x as string }; };
  const a = pair();
  const b = pair();
  const keys = { "o.example": [{ alg: "Ed25519", public: a.x, until: "2026-06-01T00:00:00Z" }, { alg: "Ed25519", public: b.x, from: "2026-06-01T00:00:00Z" }] };
  const signed = (at: string, k: typeof a) => { const e: { [k: string]: unknown } = { log: "L-1", owner: "o.example", at, by: { person: "x" }, writes: [] }; e.sig = edSign(null, Buffer.from(entryHash(e as never), "hex"), k.priv).toString("base64url"); return e; };
  assert.equal(keyFor(keys, "o.example", "2026-01-01T00:00:00Z")?.public, a.x);
  assert.equal(keyFor(keys, "o.example", "2026-07-01T00:00:00Z")?.public, b.x);
  assert.equal(verifySig(signed("2026-01-01T00:00:00Z", a) as never, "o.example", keys), true, "the retired key, inside its span");
  assert.equal(verifySig(signed("2026-07-01T00:00:00Z", a) as never, "o.example", keys), false, "the retired key, after until");
  assert.equal(verifySig(signed("2026-07-01T00:00:00Z", b) as never, "o.example", keys), true, "the new key, from its start");
  assert.equal(verifySig(signed("2026-01-01T00:00:00Z", b) as never, "o.example", keys), false, "the new key, before it existed");
});
