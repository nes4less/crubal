// host.ts: the reference host (docs/design/host.md). It does what the spec hands the host and nothing a
// business requires: who a caller is, secrets by name, acting through adapters, the clock, signing, package
// install, the loops. It owns no model: everything goes through PgStore and PgBorder.

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Json, JsonObject } from "../../crubal/src/model.ts";
import type { Contract, Keys } from "../../crubal/src/store.ts";
import { type Adapter, PgBorder, borderOptions } from "../../crubal-postgres/src/border.ts";
import { type Client, migrate as migrateStore, type Pool, transaction } from "../../crubal-postgres/src/db.ts";
import { PgStore } from "../../crubal-postgres/src/store.ts";

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
  /** Emergency terms for the well-known file (14.13), when the platform has them. */
  emergency?: JsonObject;
};

const envName = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export class Host {
  readonly pool: Pool;
  readonly o: HostOptions;

  constructor(pool: Pool, o: HostOptions) {
    this.pool = pool;
    this.o = o;
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
    return { owner, public: pub };
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

  secret(owner: string, name: string): string | undefined {
    return this.o.secrets?.(owner, name) ?? process.env[`CRUBAL_SECRET_${envName(owner)}_${envName(name)}`];
  }

  // ─── Stores and borders ────────────────────────────────────────────────────

  /** An owner's store, signing with the owner's key when the host holds one. */
  async storeFor(owner: string): Promise<PgStore> {
    const key = await this.keyOf(owner);
    const signer = key ? (hash: string) => edSign(null, Buffer.from(hash, "hex"), createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: key.public, d: key.private }, format: "jwk" })).toString("base64url") : undefined;
    return new PgStore(this.pool, owner, { ...(signer ? { signer } : {}), ...(this.o.fresh ? { fresh: this.o.fresh } : {}), ...(this.o.allowUnsigned ? { allowUnsigned: true } : {}) });
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
      const credential = c.parts.credential ? this.secret(owner, c.parts.credential) : undefined;
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
    for (const o of await this.owners()) keys[o.owner] = { alg: "Ed25519", public: o.public };
    return { crubal: "2", owner: this.o.domain, keys, packages: [], ...(this.o.emergency ? { emergency: this.o.emergency } : {}) };
  }

  // ─── The loops ─────────────────────────────────────────────────────────────

  /** Publish every owner's stale rows. */
  async project(owner?: string): Promise<{ [owner: string]: number }> {
    const out: { [owner: string]: number } = {};
    for (const o of owner ? [{ owner }] : await this.owners()) {
      const store = await this.storeFor(o.owner);
      const p = await store.projecting();
      out[o.owner] = p?.views.views.size ? (await store.project()).length : 0;
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
