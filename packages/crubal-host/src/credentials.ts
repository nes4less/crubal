// credentials.ts: what stands behind a contract's `credential` name (docs/design/host.md, "Outbound"). A
// credential is per owner and name, holds scheme-shaped material, is connected by a host flow (OAuth's
// consent, or a pasted key), refreshed and rotated by the host, and never enters a package or the log. The
// reference host keeps the material in its own table; a platform puts a vault behind the same interface.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { JsonObject } from "@cruba/crubal";
import type { Pool } from "@cruba/crubal-postgres";

/** The key material is sealed with (AES-256-GCM); a row that holds this shape is ciphertext. */
type Sealed = { $sealed: 1; iv: string; tag: string; data: string };
const isSealed = (v: unknown): v is Sealed => typeof v === "object" && v !== null && (v as Sealed).$sealed === 1;

/** A 32-byte key from what the environment holds: 64 hex characters, 44 base64 characters, or any text hashed. */
export function secretsKeyFrom(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  if (/^[A-Za-z0-9+/=_-]{43,44}$/.test(t)) return Buffer.from(t.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return createHash("sha256").update(t).digest();
}

export type Connection = { owner: string; name: string; scheme: string; scopes: string[]; status: "connected" | "expired"; expires?: string; connected: string };

export type OAuthProvider = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** The redirect the provider sends the code to; the host's connect route. */
  redirectUri: string;
};

type Row = { [column: string]: unknown };

export class Credentials {
  readonly pool: Pool;
  readonly now: () => string;
  /** The key the material is sealed with at rest; without one no secret is stored. */
  readonly key?: Buffer;

  constructor(pool: Pool, now: () => string, key?: Buffer) {
    this.pool = pool;
    this.now = now;
    const k = key ?? secretsKeyFrom(process.env.CRUBAL_SECRETS_KEY);
    if (k) this.key = k;
  }

  /** Seal material for the table (AES-256-GCM, a fresh nonce each time). */
  seal(material: JsonObject): Sealed {
    if (!this.key) throw new Error("a secrets key is required to store a secret (CRUBAL_SECRETS_KEY); none is set");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(material), "utf8"), cipher.final()]);
    return { $sealed: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  /** The material back from the table: sealed rows opened with the key; a row from before sealing read as it is. */
  open(stored: unknown): JsonObject {
    if (!isSealed(stored)) return (stored ?? {}) as JsonObject;
    if (!this.key) throw new Error("a secrets key is required to read a sealed secret (CRUBAL_SECRETS_KEY); none is set");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8");
    return JSON.parse(text) as JsonObject;
  }

  /** Seal every row stored before sealing existed; run once at migration. Returns how many it sealed. */
  async sealAll(): Promise<number> {
    if (!this.key) return 0;
    const { rows } = await this.pool.query("select owner, name, material from host_credentials");
    let n = 0;
    for (const r of rows as Row[]) {
      if (isSealed(r.material)) continue;
      await this.pool.query("update host_credentials set material = $3 where owner = $1 and name = $2", [r.owner, r.name, this.seal((r.material ?? {}) as JsonObject)]);
      n++;
    }
    return n;
  }

  /** Connect a credential: the material under the name, sealed, with its scheme, scopes and expiry. */
  async connect(owner: string, name: string, scheme: string, material: JsonObject, scopes: string[] = [], expires?: string): Promise<Connection> {
    await this.pool.query(
      `insert into host_credentials (owner, name, scheme, material, scopes, expires, connected) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (owner, name) do update set scheme = excluded.scheme, material = excluded.material, scopes = excluded.scopes, expires = excluded.expires, connected = excluded.connected`,
      [owner, name, scheme, this.seal(material), scopes, expires ?? null, this.now()],
    );
    return (await this.connection(owner, name)) as Connection;
  }

  async disconnect(owner: string, name: string): Promise<void> {
    await this.pool.query("delete from host_credentials where owner = $1 and name = $2", [owner, name]);
  }

  /** The fact of a connection, never its material: what a `system` record carries and a view may show. */
  async connection(owner: string, name: string): Promise<Connection | undefined> {
    const { rows } = await this.pool.query("select owner, name, scheme, scopes, expires, connected from host_credentials where owner = $1 and name = $2", [owner, name]);
    const r = rows[0] as Row | undefined;
    if (!r) return undefined;
    const expires = r.expires ? String(r.expires) : undefined;
    return { owner, name, scheme: String(r.scheme), scopes: (r.scopes as string[]) ?? [], status: expires && expires <= this.now() ? "expired" : "connected", ...(expires ? { expires } : {}), connected: String(r.connected) };
  }

  async connections(owner: string): Promise<Connection[]> {
    const { rows } = await this.pool.query("select name from host_credentials where owner = $1 order by connected", [owner]);
    const out: Connection[] = [];
    for (const r of rows as Row[]) {
      const c = await this.connection(owner, String(r.name));
      if (c) out.push(c);
    }
    return out;
  }

  /**
   * The secret an adapter sends: the key or password as stored, or an OAuth access token, refreshed first
   * when it has expired and a refresh token is held. Undefined when nothing is connected under the name.
   */
  async secret(owner: string, name: string, provider?: OAuthProvider): Promise<string | undefined> {
    const { rows } = await this.pool.query("select scheme, material, expires from host_credentials where owner = $1 and name = $2", [owner, name]);
    const r = rows[0] as Row | undefined;
    if (!r) return undefined;
    const material = this.open(r.material);
    if (r.scheme === "oauth2") {
      const expired = r.expires ? String(r.expires) <= this.now() : false;
      if (expired && typeof material.refresh_token === "string" && provider) {
        const fresh = await this.refresh(owner, name, material.refresh_token, provider);
        return fresh;
      }
      if (expired) return undefined;
      return typeof material.access_token === "string" ? material.access_token : undefined;
    }
    if (r.scheme === "basic") return `${material.username ?? ""}:${material.password ?? ""}`;
    return typeof material.key === "string" ? material.key : typeof material.secret === "string" ? material.secret : undefined;
  }

  /** Where to send a person to connect an OAuth account; the state names the owner and the credential. */
  authorizeUrl(owner: string, name: string, provider: OAuthProvider, scopes: string[]): string {
    const u = new URL(provider.authorizeUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", provider.clientId);
    u.searchParams.set("redirect_uri", provider.redirectUri);
    u.searchParams.set("scope", scopes.join(" "));
    u.searchParams.set("state", Buffer.from(JSON.stringify({ owner, name })).toString("base64url"));
    return u.toString();
  }

  /** The code the provider sent back becomes the connection. */
  async exchangeCode(owner: string, name: string, code: string, provider: OAuthProvider, scopes: string[], fetchFn: typeof fetch = fetch): Promise<Connection> {
    const res = await fetchFn(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: provider.redirectUri }).toString(),
    });
    if (!res.ok) throw new Error(`the token endpoint answered ${res.status}`);
    const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
    const expires = tok.expires_in ? new Date(Date.parse(this.now()) + tok.expires_in * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
    return this.connect(owner, name, "oauth2", { access_token: tok.access_token, ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}) }, tok.scope ? tok.scope.split(" ") : scopes, expires);
  }

  private async refresh(owner: string, name: string, refreshToken: string, provider: OAuthProvider, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
    const res = await fetchFn(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
    });
    if (!res.ok) {
      // A connection that can't be refreshed is expired: the fact is visible, the secret gone.
      await this.pool.query("update host_credentials set expires = $3 where owner = $1 and name = $2", [owner, name, this.now()]);
      return undefined;
    }
    const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const expires = tok.expires_in ? new Date(Date.parse(this.now()) + tok.expires_in * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;
    const { rows } = await this.pool.query("select material, scopes from host_credentials where owner = $1 and name = $2", [owner, name]);
    const was = (rows[0] as Row | undefined) ?? {};
    await this.connect(owner, name, "oauth2", { ...this.open(was.material), access_token: tok.access_token, ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}) }, (was.scopes as string[]) ?? [], expires);
    return tok.access_token;
  }
}
