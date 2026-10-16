// oidc.ts: a verifier for bearer tokens an identity provider issued (docs/design/host.md, "Inbound"). A JWT
// is checked against the issuer's keys (its JWKS, or a shared secret for HS256), its issuer, audience and
// expiry; the subject is then looked up in the host's identity links, and the store sees only the caller.
// Supabase Auth is one such issuer; so is any OIDC provider.

import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { Caller } from "./host.ts";

export type Jwk = { kty: string; kid?: string; alg?: string; [k: string]: unknown };
export type OidcOptions = {
  /** The token's `iss`. */
  issuer: string;
  /** The token's `aud`, when the provider sets one (Supabase: `authenticated`). */
  audience?: string;
  /** The issuer's JWKS, or how to fetch it; `${issuer}/.well-known/jwks.json` otherwise. */
  jwks?: Jwk[] | (() => Promise<Jwk[]>);
  /** A shared secret for HS256 tokens (a legacy Supabase project). */
  secret?: string;
  /** The provider's name in the host's identity links. */
  provider: string;
  /** The clock, for `exp`. */
  now?: () => number;
  /** The subject → caller link; the host's identities table. */
  identity: (provider: string, subject: string) => Promise<Caller | null>;
};

const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Verify a compact JWS and return its claims, or null. */
export async function verifyJwt(token: string, o: Omit<OidcOptions, "provider" | "identity">): Promise<{ [claim: string]: unknown } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: { [claim: string]: unknown };
  try {
    header = JSON.parse(b64(h).toString("utf8")) as { alg?: string; kid?: string };
    claims = JSON.parse(b64(p).toString("utf8")) as { [claim: string]: unknown };
  } catch {
    return null;
  }
  const signed = Buffer.from(`${h}.${p}`);
  const sig = b64(s);
  let ok = false;
  if (header.alg === "HS256") {
    if (!o.secret) return null;
    const mac = createHmac("sha256", o.secret).update(signed).digest();
    ok = mac.length === sig.length && timingSafeEqual(mac, sig);
  } else {
    const keys = typeof o.jwks === "function" ? await o.jwks() : o.jwks ?? (await (await fetch(`${o.issuer.replace(/\/$/, "")}/.well-known/jwks.json`)).json() as { keys: Jwk[] }).keys;
    const candidates = keys.filter((k) => !header.kid || k.kid === header.kid);
    for (const jwk of candidates) {
      try {
        const key = createPublicKey({ key: jwk as never, format: "jwk" });
        const algo = header.alg === "EdDSA" ? null : header.alg === "ES256" || header.alg === "RS256" ? "sha256" : header.alg === "ES384" || header.alg === "RS384" ? "sha384" : "sha512";
        ok = cryptoVerify(algo, signed, header.alg?.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
      } catch {
        ok = false;
      }
      if (ok) break;
    }
  }
  if (!ok) return null;
  const now = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (typeof claims.exp === "number" && claims.exp <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now) return null;
  if (claims.iss !== o.issuer) return null;
  if (o.audience) {
    const aud = claims.aud;
    if (!(aud === o.audience || (Array.isArray(aud) && aud.includes(o.audience)))) return null;
  }
  return claims;
}

/** A verifier for `HostOptions.verifiers`: a valid token's subject becomes the caller its link names. */
export function oidcVerifier(o: OidcOptions): (token: string) => Promise<Caller | null> {
  return async (token) => {
    if (token.split(".").length !== 3) return null;
    const claims = await verifyJwt(token, o);
    if (!claims || typeof claims.sub !== "string") return null;
    return o.identity(o.provider, claims.sub);
  };
}
