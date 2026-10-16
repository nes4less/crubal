// signatures.ts: signed requests between owners (docs/design/host.md, "Between owners"): HTTP message
// signatures (RFC 9421) over the method, the target, the body's digest and the date, made with the domain's
// Ed25519 key and verified against the key its well-known file publishes. The subset here is what two
// hosts need to prove who is calling; nothing more.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

export const COMPONENTS = ["@method", "@target-uri", "content-digest", "date"] as const;

export function contentDigest(body: string): string {
  return `sha-256=:${createHash("sha256").update(body, "utf8").digest("base64")}:`;
}

function base(method: string, target: string, digest: string, date: string, params: string): string {
  return [`"@method": ${method.toUpperCase()}`, `"@target-uri": ${target}`, `"content-digest": ${digest}`, `"date": ${date}`, `"@signature-params": ${params}`].join("\n");
}

/** The headers a signed request carries: Content-Digest, Date, Signature-Input and Signature. */
export function signRequest(o: { method: string; url: string; body?: string; keyid: string; privateD: string; publicX: string; created?: number }): { [header: string]: string } {
  const body = o.body ?? "";
  const digest = contentDigest(body);
  const created = o.created ?? Math.floor(Date.now() / 1000);
  const date = new Date(created * 1000).toUTCString();
  const params = `(${COMPONENTS.map((c) => `"${c}"`).join(" ")});created=${created};keyid="${o.keyid}";alg="ed25519"`;
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: o.publicX, d: o.privateD }, format: "jwk" });
  const sig = edSign(null, Buffer.from(base(o.method, o.url, digest, date, params), "utf8"), key).toString("base64");
  return { "content-digest": digest, date, "signature-input": `sig1=${params}`, signature: `sig1=:${sig}:` };
}

export type Verified = { keyid: string; created: number };

/** Verify a request's signature with the signer's public key (its JWK `x`). Null when absent or invalid. */
export function verifyRequest(o: { method: string; url: string; body?: string; headers: { [h: string]: string | string[] | undefined }; publicX: (keyid: string) => Promise<string | undefined>; now?: number; skew?: number }): Promise<Verified | null> {
  return (async () => {
    const h = (n: string) => { const v = o.headers[n] ?? o.headers[n.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
    const input = h("signature-input");
    const signature = h("signature");
    const date = h("date");
    const digest = h("content-digest");
    if (!input || !signature || !date || !digest) return null;
    const m = input.match(/^sig1=(\((?:"[^"]+" ?)+\);created=(\d+);keyid="([^"]+)";alg="ed25519")$/);
    const s = signature.match(/^sig1=:([A-Za-z0-9+/=]+):$/);
    if (!m || !s) return null;
    const [, params, createdText, keyid] = m as unknown as [string, string, string, string];
    const created = Number(createdText);
    const now = o.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - created) > (o.skew ?? 300)) return null;
    if (contentDigest(o.body ?? "") !== digest) return null;
    const x = await o.publicX(keyid);
    if (!x) return null;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    const ok = edVerify(null, Buffer.from(base(o.method, o.url, digest, date, params), "utf8"), key, Buffer.from(s[1] as string, "base64"));
    return ok ? { keyid, created } : null;
  })();
}
