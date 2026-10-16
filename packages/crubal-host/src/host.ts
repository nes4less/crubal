// host.ts: the reference host (docs/design/host.md). It does what the spec hands the host and nothing a
// business requires: who a caller is, secrets by name, acting through adapters, the clock, signing, package
// install, the loops. It owns no model: everything goes through PgStore and PgBorder.

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { ChainedSecrets, EnvSecrets, FunctionSecrets, type SecretStore } from "./secrets.ts";
import { type Offer, verifyBorder } from "../../crubal/src/exchange.ts";
import type { StreamEntry } from "../../crubal/src/views.ts";
import { readFileSync } from "node:fs";
import type { Json, JsonObject } from "../../crubal/src/model.ts";
import { type Contract, type Keys, keyFor } from "../../crubal/src/store.ts";
import { type Adapter, PgBorder, borderOptions } from "../../crubal-postgres/src/border.ts";
import { type Client, migrate as migrateStore, type Pool, transaction } from "../../crubal-postgres/src/db.ts";
import { PgStore } from "../../crubal-postgres/src/store.ts";
import { Credentials, type OAuthProvider } from "./credentials.ts";
import type { EmergencyTerms } from "./emergency.ts";
import { verifyRequest, signRequest } from "./signatures.ts";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

export type Caller = { owner: string; caller: string };

export type HostOptions = {
  /** The host's own domain, for its well-known file. */
  domain: string;
  /** A key the loops' routes (`/project`, `/tick`) require. */
  hostKey?: string;
  /** Verifiers for bearer tokens that aren't API keys (an OIDC-shaped adapter); each answers a caller or null. */
  verifiers?: ((token: string) => Promise<Caller | null> | Caller | null)[];
  /** Secrets by (owner, name); the environment (`CRUBAL_SECRET_<OWNER>_<NAME>`) otherwise. */
  secrets?: (owner: string, name: string) => string | undefined;
  /** Where credentials' secrets live beyond the connected table: a vault, a file; the environment otherwise. */
  secretStore?: SecretStore;
  /** Request bodies larger than this are refused with 413 (default 1 MiB). */
  bodyLimit?: number;
  /** Origins allowed to call from a browser; none otherwise. */
  cors?: string[];
  /** One structured line per request; the console as JSON otherwise, nothing when `false`. */
  log?: ((line: JsonObject) => void) | false;
  /** Adapters by contract name, beyond the built-in `http` one. */
  adapters?: { [contract: string]: Adapter };
  /** A publisher's keys from its well-known file; `fetch` of `https://<domain>/.well-known/crubal.json` otherwise. */
  resolveKeys?: (domain: string) => Promise<Keys>;
  /** The clock (6.3). */
  now?: () => string;
  /** `write` publishes views right after each commit; else the loops do. */
  fresh?: "write" | "asked";
  /** Install unsigned bundles (development only). */
  allowUnsigned?: boolean;
  /** Emergency terms (14.13), published in the well-known file, when the platform has them. */
  emergency?: EmergencyTerms;
  /** OAuth providers by credential name, for the connect flow and refresh. */
  oauth?: { [name: string]: OAuthProvider };
  /** The owner's notice of an emergency edge or a dead run; the console otherwise. */
  notify?: (owner: string, notice: JsonObject) => void | Promise<void>;
  /** Another owner's host by domain: its base URL; `https://<domain>` otherwise. */
  hostOf?: (domain: string) => string;
};

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export class Host {
  readonly pool: Pool;
  readonly o: HostOptions;
  readonly credentials: Credentials;

  constructor(pool: Pool, o: HostOptions) {
    this.pool = pool;
    this.o = o;
    this.credentials = new Credentials(pool, () => this.now());
  }

  now(): string {
    return this.o.now ? this.o.now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /** The store's tables and the host's. */
  async migrate(): Promise<void> {
    await transaction(this.pool, async (c: Client) => {
      await migrateStore(c);
      await c.query(SCHEMA_SQL);
    });
  }

  // ─── Owners and keys ───────────────────────────────────────────────────────

  /** Make an owner: a domain or a hosted person, with an Ed25519 key the host signs its chain with. */
  async createOwner(owner: string): Promise<{ owner: string; public: string }> {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "jwk" }).x as string;
    const priv = privateKey.export({ format: "jwk" }).d as string;
    await this.pool.query("insert into host_owners (owner, public, private, created) values ($1, $2, $3, $4) on conflict (owner) do nothing", [owner, pub, priv, this.now()]);
    const { rows } = await this.pool.query("select public from host_owners where owner = $1", [owner]);
    return { owner, public: String((rows[0] as { public: string }).public) };
  }

  /**
   * Rotate an owner's key (8.5, 11.7): a new key signs from now; the well-known file lists the old with
   * `until` and the new with `from`, so the chain verifies across the rotation.
   */
  async rotateKey(owner: string, now = this.now()): Promise<{ owner: string; public: string; retired: string }> {
    const old = await this.keyOf(owner);
    if (!old) throw new Error(`${owner} has no key to rotate`);
    const { rows } = await this.pool.query("select created from host_owners where owner = $1", [owner]);
    const since = (await this.pool.query("select max(until) as until from host_keys where owner = $1", [owner])).rows[0] as { until: string | null };
    await this.pool.query("insert into host_keys (owner, public, \"from\", until) values ($1, $2, $3, $4) on conflict do nothing", [owner, old.public, since.until ?? String((rows[0] as { created: string }).created), now]);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "jwk" }).x as string;
    const priv = privateKey.export({ format: "jwk" }).d as string;
    await this.pool.query("update host_owners set public = $2, private = $3, created = $4 where owner = $1", [owner, pub, priv, now]);
    return { owner, public: pub, retired: old.public };
  }

  /** The signer for a hosted person (14.1): their key, made on first use. */
  private async hostedSigner(owner: string): Promise<((hash: string) => string) | undefined> {
    await this.createOwner(owner);
    const key = await this.keyOf(owner);
    return key ? (hash: string) => edSign(null, Buffer.from(hash, "hex"), createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.public, d: key.private }, format: "jwk" })).toString("base64url") : undefined;
  }

  async owners(): Promise<{ owner: string; public: string }[]> {
    return (await this.pool.query("select owner, public from host_owners order by created")).rows as { owner: string; public: string }[];
  }

  private async keyOf(owner: string): Promise<{ public: string; private: string } | undefined> {
    const { rows } = await this.pool.query("select public, private from host_owners where owner = $1", [owner]);
    const r = rows[0] as { public: string; private: string | null } | undefined;
    return r?.private ? { public: r.public, private: r.private } : undefined;
  }

  /** Issue an API key for a caller of an owner; the raw key is returned once and only its hash is kept. */
  async issueKey(owner: string, caller: string, label?: string): Promise<string> {
    const raw = `ck_${randomBytes(24).toString("base64url")}`;
    await this.pool.query("insert into host_api_keys (key_hash, owner, caller, label, created) values ($1, $2, $3, $4, $5)", [hashKey(raw), owner, caller, label ?? null, this.now()]);
    return raw;
  }

  async revokeKey(raw: string): Promise<void> {
    await this.pool.query("delete from host_api_keys where key_hash = $1", [hashKey(raw)]);
  }

  /** Link an identity provider's subject to a caller, for the OIDC verifier. */
  async linkIdentity(provider: string, subject: string, owner: string, caller: string): Promise<void> {
    await this.pool.query("insert into host_identities (provider, subject, owner, caller) values ($1, $2, $3, $4) on conflict (provider, subject) do update set owner = excluded.owner, caller = excluded.caller", [provider, subject, owner, caller]);
  }

  async identity(provider: string, subject: string): Promise<Caller | null> {
    const { rows } = await this.pool.query("select owner, caller from host_identities where provider = $1 and subject = $2", [provider, subject]);
    return (rows[0] as Caller | undefined) ?? null;
  }

  /**
   * Who is calling when the request is signed by another owner (RFC 9421 with its domain key): the signer's
   * domain, as a caller of the owner addressed. The signer's key comes from its well-known file.
   */
  async whoSigned(owner: string, req: { method: string; url: string; body?: string; headers: { [h: string]: string | string[] | undefined } }): Promise<Caller | null> {
    const v = await verifyRequest({ ...req, publicX: async (keyid) => keyFor(await this.resolveKeys(keyid), keyid, this.now())?.public, now: Math.floor(Date.parse(this.now()) / 1000) });
    // The signing owner acts as the caller `domain:owner`: a caller of that domain (14.1), never a bare ID here.
    return v ? { owner, caller: `${v.keyid}:owner` } : null;
  }

  /** Who is calling: an API key, a token a verifier knows, or nobody. The store sees only the caller ID. */
  async whoIs(authorization: string | undefined): Promise<Caller | null> {
    if (!authorization) return null;
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (token.startsWith("ck_")) {
      const { rows } = await this.pool.query("select owner, caller from host_api_keys where key_hash = $1", [hashKey(token)]);
      return (rows[0] as Caller | undefined) ?? null;
    }
    for (const v of this.o.verifiers ?? []) {
      const c = await v(token);
      if (c) return c;
    }
    return null;
  }

  // ─── Secrets ───────────────────────────────────────────────────────────────

  /** A credential's secret: connected under the name (refreshed when OAuth and expired), a configured source, or the environment. */
  async secret(owner: string, name: string): Promise<string | undefined> {
    const connected = await this.credentials.secret(owner, name, this.o.oauth?.[name]);
    if (connected !== undefined) return connected;
    const store = this.o.secretStore ?? new ChainedSecrets([...(this.o.secrets ? [new FunctionSecrets(this.o.secrets)] : []), new EnvSecrets()]);
    return store.get(owner, name);
  }

  /** Health (docs/design/completion.md O): the database reachable, and every owner's chain head. */
  async health(): Promise<JsonObject> {
    try {
      await this.pool.query("select 1");
    } catch (e) {
      return { ok: false, database: e instanceof Error ? e.message : String(e) };
    }
    const chains = (await this.pool.query("select owner, chain, head_seq from chains order by owner, chain")).rows as { owner: string; chain: string; head_seq: number | string }[];
    const heads: JsonObject = {};
    for (const c of chains) heads[c.chain === "main" ? c.owner : `${c.owner}/${c.chain}`] = Number(c.head_seq);
    return { ok: true, domain: this.o.domain, now: this.now(), chains: heads };
  }

  // ─── Stores and borders ────────────────────────────────────────────────────

  /** An owner's store, signing with the owner's key when the host holds one. */
  async storeFor(owner: string): Promise<PgStore> {
    const key = await this.keyOf(owner);
    const signer = key ? (hash: string) => edSign(null, Buffer.from(hash, "hex"), createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.public, d: key.private }, format: "jwk" })).toString("base64url") : undefined;
    return new PgStore(this.pool, owner, { ...(signer ? { signer } : {}), hostedSigner: (o) => this.hostedSigner(o), ...(this.o.fresh ? { fresh: this.o.fresh } : {}), ...(this.o.allowUnsigned ? { allowUnsigned: true } : {}) });
  }

  /**
   * The built-in `http` adapter: a contract with the host's part `host:url` is POSTed its payload as JSON,
   * with the credential the contract names resolved to a secret and sent as its `auth` scheme says.
   */
  httpAdapter(owner: string): Adapter {
    return async (c: Contract, payload: JsonObject) => {
      const url = c.parts["host:url"];
      if (!url) return { acted: true };
      const headers: { [k: string]: string } = { "content-type": "application/json" };
      const credential = c.parts.credential ? await this.secret(owner, c.parts.credential) : undefined;
      if (c.parts.credential && credential === undefined) return { failed: `credential: no secret for ${c.parts.credential}` };
      if (credential && (c.parts.auth === "apikey" || c.parts.auth === "oauth2")) headers.authorization = `Bearer ${credential}`;
      if (credential && c.parts.auth === "basic") headers.authorization = `Basic ${Buffer.from(credential).toString("base64")}`;
      const res = await fetch(url, { method: c.parts["host:method"] ?? "POST", headers, body: JSON.stringify(payload) });
      if (res.status === 401 || res.status === 403) return { failed: `credential: ${res.status}` };
      if (!res.ok) return { failed: `http ${res.status}` };
      const body = await res.text();
      return { acted: true, ...(body ? { body } : {}) };
    };
  }

  // ─── Between owners (7.8, 12.6.2) ─────────────────────────────────────────

  /** Another owner's host, by domain. */
  hostOf(domain: string): string {
    return this.o.hostOf ? this.o.hostOf(domain) : `https://${domain}`;
  }

  /** A request to another owner's host, signed with this owner's domain key (RFC 9421). */
  async signedFetch(owner: string, method: string, url: string, body?: string): Promise<Response> {
    const key = await this.keyOf(owner);
    if (!key) throw new Error(`${owner} has no key to sign with`);
    const headers = signRequest({ method, url, ...(body !== undefined ? { body } : {}), keyid: owner, privateD: key.private, publicX: key.public, created: Math.floor(Date.parse(this.now()) / 1000) });
    return fetch(url, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body } : {}) });
  }

  /** May this caller read an offer (7.8 `to`)? Public to anyone; link by token; followers and named parties by edge or signature. */
  async mayTake(owner: string, c: Contract, callerId: string | undefined, link: string | undefined): Promise<boolean> {
    const to = (c.to ?? "private").split(",").map((s) => s.trim()).filter(Boolean);
    if (callerId === owner) return true;
    if (to.includes("public")) return true;
    if (to.includes("link") && link) {
      const { rows } = await this.pool.query("select 1 from host_offer_links where owner = $1 and contract = $2 and token = $3 and not revoked", [owner, c.name, link]);
      return rows.length > 0;
    }
    if (!callerId) return false;
    const domain = callerId.replace(/:owner$/, "");
    if (to.some((p) => p !== "public" && p !== "link" && p !== "followers" && p !== "private" && (p === domain || p === callerId))) return true;
    if (to.includes("followers")) {
      const store = await this.storeFor(owner);
      const edges = [...(await store.state()).edges.values()];
      return edges.some((e) => (e.who === callerId || e.who === domain) && /^follow/.test(String(e.relation)));
    }
    return false;
  }

  /** Publish an offer by link (7.8): the token, minted once and kept across republishing. */
  async offerLink(owner: string, contract: string): Promise<string> {
    const { rows } = await this.pool.query("select token from host_offer_links where owner = $1 and contract = $2", [owner, contract]);
    if (rows[0]) {
      await this.pool.query("update host_offer_links set revoked = false where owner = $1 and contract = $2", [owner, contract]);
      return String((rows[0] as { token: string }).token);
    }
    const token = randomBytes(24).toString("base64url");
    await this.pool.query("insert into host_offer_links (owner, contract, token) values ($1, $2, $3)", [owner, contract, token]);
    return token;
  }

  /** Unpublish a link offer: the token stops working, nothing is deleted. */
  async unpublishOffer(owner: string, contract: string): Promise<void> {
    await this.pool.query("update host_offer_links set revoked = true where owner = $1 and contract = $2", [owner, contract]);
  }

  /**
   * A take across hosts (7.8, 8.5.1): fetch the presenter's offer with a signed request, verify the wrapper
   * against the presenter's keys, then take each offered record into ours: the one bound to it, or a new
   * record bound from now on. Each take is one entry naming the presenter's.
   */
  async take(owner: string, takeName: string, at = this.now()): Promise<JsonObject> {
    const store = await this.storeFor(owner);
    const border = await this.borderFor(owner, store);
    const t = border.contracts.get(takeName);
    if (!t || t.kind !== "take") throw new Error(`no take contract ${takeName}`);
    const from = t.from;
    if (!from) throw new Error(`${takeName} names no presenter (from)`);
    const offerName = t.parts.offer;
    const names = offerName ? [offerName] : ((await (await this.signedFetch(owner, "GET", `${this.hostOf(from)}/o/${from}/offer`)).json()) as { offers?: JsonObject[] }).offers?.filter((o) => (o.gives as string[]).some((g) => t.reads.some((m) => m.from === g))).map((o) => String(o.contract)) ?? [];
    const taken: JsonObject[] = [];
    for (const name of names) {
      const res = await this.signedFetch(owner, "GET", `${this.hostOf(from)}/o/${from}/offer/${name}`);
      if (!res.ok) { taken.push({ offer: name, stopped: `http ${res.status}` }); continue; }
      const offer = (await res.json()) as Offer;
      const verified = verifyBorder({ records: offer.records, ...(offer.log ? { log: offer.log } : {}) }, await this.resolveKeys(from));
      if (verified.verified !== true) { taken.push({ offer: name, stopped: "unverified", ...verified }); continue; }
      for (const presenter of offer.records) {
        const key = `take|${from}|${presenter.id}`;
        let recordId = (await store.state()).bindings.get(key);
        if (!recordId) {
          // A record of ours for theirs: minted empty, bound by the presenter's id from now on.
          const n = (await this.pool.query("select count(*) as n from bindings where owner = $1 and key like 'take|%'", [owner])).rows[0] as { n: string };
          recordId = `T-${Number(n.n) + 1}`;
          const id = recordId;
          await store.commit({ take: takeName, from }, (d) => {
            d.records.set(id, { id, kind: presenter.kind, level: presenter.level, owner, values: {}, sources: {} });
            d.bindings.set(key, id);
          }, at);
        }
        const r = await border.take(takeName, offer, recordId, presenter, undefined, at);
        taken.push({ offer: name, presenter: presenter.id, record: recordId, ...r });
      }
    }
    return { contract: takeName, from, taken };
  }

  /**
   * Push streams (12.6.2): every stream contract with `when: entry` sends its entries since the cursor to
   * the party it names (its adapter, else a signed POST to that host's inbox), and the acknowledgement
   * moves the cursor.
   */
  async push(now = this.now(), owner?: string): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const store = await this.storeFor(o.owner);
      const border = await this.borderFor(o.owner, store);
      for (const c of border.contracts.values()) {
        if (!c.stream.length || c.when !== "entry") continue;
        const r = await border.streamRun(c.name, undefined, undefined, now);
        const entries = (r.entries ?? {}) as { [view: string]: StreamEntry[] };
        if (!Object.values(entries).some((l) => l.length)) continue;
        const adapter = this.o.adapters?.[c.name];
        const payload: JsonObject = { contract: c.name, from: o.owner, entries: entries as unknown as Json };
        let acted = false;
        let failed: string | undefined;
        if (adapter) {
          const a = await adapter(c, payload, String(r.log ?? ""));
          acted = "acted" in a && a.acted === true;
          if ("failed" in a) failed = a.failed;
        } else {
          const url = c.parts["host:url"] ?? (c.to ? `${this.hostOf(c.to)}/o/${c.to}/inbox/${c.name}` : undefined);
          if (!url) { failed = "nowhere to push: no to and no host:url"; }
          else {
            const res = await this.signedFetch(o.owner, "POST", url, JSON.stringify(payload));
            acted = res.ok;
            if (!res.ok) failed = `http ${res.status}`;
          }
        }
        if (acted) await border.ack(c.name, r.cursor as { [view: string]: number });
        out.push({ owner: o.owner, contract: c.name, ...(acted ? { acted: true, cursor: r.cursor as Json } : { failed: failed ?? "not acted" }) });
      }
    }
    return out;
  }

  /** Taken values past their terms (7.8), for every owner or one. */
  async expire(now = this.now(), owner?: string): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const border = await this.borderFor(o.owner);
      const ids = await border.expire(now, now);
      if (ids.length) out.push({ owner: o.owner, expired: ids });
    }
    return out;
  }

  /** An owner's border over its own definitions, with the adapters. */
  async borderFor(owner: string, store?: PgStore): Promise<PgBorder> {
    const s = store ?? (await this.storeFor(owner));
    const o = await borderOptions(s);
    const http = this.httpAdapter(owner);
    const adapters: { [contract: string]: Adapter } = {};
    for (const c of o.contracts) if (c.kind === "send" || c.kind === "form") adapters[c.name] = this.o.adapters?.[c.name] ?? http;
    return new PgBorder(s, { ...o, adapters });
  }

  // ─── Packages ──────────────────────────────────────────────────────────────

  async resolveKeys(domain: string): Promise<Keys> {
    if (this.o.resolveKeys) return this.o.resolveKeys(domain);
    const res = await fetch(`https://${domain}/.well-known/crubal.json`);
    if (!res.ok) throw new Error(`${domain}: no well-known file (${res.status})`);
    const j = (await res.json()) as { keys?: Keys };
    return j.keys ?? {};
  }

  /** Install a published version for an owner: the publisher's keys from its well-known file, then the store. */
  async install(owner: string, bundle: JsonObject): Promise<JsonObject> {
    const store = await this.storeFor(owner);
    const keys = bundle.sig ? await this.resolveKeys(String(bundle.owner)) : undefined;
    const entry = await store.install(bundle, keys, this.now());
    return { installed: String(bundle.id), version: String(bundle.version), entry: String(entry.log) };
  }

  // ─── The well-known file ───────────────────────────────────────────────────

  async wellKnown(): Promise<JsonObject> {
    const keys: JsonObject = {};
    const retired = (await this.pool.query("select owner, public, \"from\", until from host_keys order by until")).rows as { owner: string; public: string; from: string | null; until: string }[];
    for (const o of await this.owners()) {
      const old = retired.filter((k) => k.owner === o.owner).map((k): JsonObject => ({ alg: "Ed25519", public: k.public, ...(k.from ? { from: k.from } : {}), until: k.until }));
      if (!old.length) keys[o.owner] = { alg: "Ed25519", public: o.public };
      else keys[o.owner] = [...old, { alg: "Ed25519", public: o.public, from: (old.at(-1) as JsonObject).until as Json }];
    }
    return { crubal: "2", owner: this.o.domain, keys, packages: [], ...(this.o.emergency ? { emergency: this.o.emergency as unknown as JsonObject } : {}) };
  }

  async notice(owner: string, notice: JsonObject): Promise<void> {
    if (this.o.notify) await this.o.notify(owner, notice);
    else console.warn(`[notice ${owner}] ${JSON.stringify(notice)}`);
  }

  // ─── The loops ─────────────────────────────────────────────────────────────

  /** Publish every owner's stale rows. */
  async project(owner?: string, now = this.now()): Promise<{ [owner: string]: number }> {
    const out: { [owner: string]: number } = {};
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const store = await this.storeFor(o.owner);
      const p = await store.projecting();
      if (!p?.views.views.size) { out[o.owner] = 0; continue; }
      // A view with a delay (12.6 `fresh: 5m`) publishes when that much has passed since its last publish.
      const last = new Map(((await this.pool.query("select view, at from host_publish where owner = $1", [o.owner])).rows as { view: string; at: string }[]).map((r) => [r.view, r.at]));
      let n = 0;
      for (const v of p.views.views.values()) {
        const delay = v.fresh === "write" ? 0 : durationMs(v.fresh);
        const was = last.get(v.name);
        if (delay && was && Date.parse(was) + delay > Date.parse(now)) continue;
        n += (await store.project(v.name)).length;
        if (delay) await this.pool.query("insert into host_publish (owner, view, at) values ($1, $2, $3) on conflict (owner, view) do update set at = excluded.at", [o.owner, v.name, now]);
      }
      out[o.owner] = n;
    }
    return out;
  }

  /** Drain pending instructions (completion.md P) for every owner or one, at a rate per owner. */
  async drain(rate = 100, owner?: string, now = this.now()): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const r = await (await this.storeFor(o.owner)).drain(rate, now);
      if (r.applied.length || r.remaining) out.push({ owner: o.owner, applied: r.applied, remaining: r.remaining });
    }
    return out;
  }

  /**
   * Try failed runs again when their contract's retry interval has passed (7.5): a run still open after a
   * failure, whose last attempt is `every` behind `now`. A run dead after its last attempt is noticed.
   */
  async retry(now = this.now(), owner?: string): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const store = await this.storeFor(o.owner);
      const border = await this.borderFor(o.owner, store);
      const { rows } = await this.pool.query("select run, json from runs where owner = $1 and json->>'state' = 'failed'", [o.owner]);
      for (const r of rows as { run: string; json: JsonObject }[]) {
        const c = border.contracts.get(String(r.json.contract));
        const m = (c?.parts.retry ?? "").match(/^(\d+)\s+every\s+(\d+)(m|h|d)$/);
        if (!c || !m) continue;
        const allowed = 1 + Number(m[1]);
        if (Number(r.json.attempt ?? 0) >= allowed) continue;
        const every = Number(m[2]) * (m[3] === "m" ? 60_000 : m[3] === "h" ? 3_600_000 : 86_400_000);
        const last = (await this.pool.query("select max(at) as at from log where owner = $1 and entry->'writes' @> $2::jsonb", [o.owner, JSON.stringify([{ run: r.run, state: "failed" }])])).rows[0] as { at: string | null };
        if (last.at && Date.parse(last.at) + every > Date.parse(now)) continue;
        const result = await border.retry(r.run, undefined, now);
        out.push({ owner: o.owner, run: r.run, ...result });
        if (result.dead) await this.notice(o.owner, { dead: r.run, contract: c.name, review: String(result.review ?? "") });
      }
    }
    return out;
  }

  /** Run every scheduled contract's due ticks, for one owner or all. */
  async tick(now = this.now(), owner?: string): Promise<JsonObject[]> {
    const out: JsonObject[] = [];
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const store = await this.storeFor(o.owner);
      const border = await this.borderFor(o.owner, store);
      for (const c of border.contracts.values()) {
        if (!c.when || !/^every /.test(c.when)) continue;
        out.push({ owner: o.owner, ...(await border.tick(c.name, now)) });
      }
    }
    return out;
  }
}

/** A delay such as `5m`, `2h`, `1d` or `30s` in milliseconds; 0 when it isn't one. */
function durationMs(s: string): number {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)$/);
  if (!m) return 0;
  return Number(m[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"] as number);
}
