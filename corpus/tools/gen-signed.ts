import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function serialize(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${serialize(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
// An entry hashes with each write replaced by its own hash (8.5), so a write can be redacted in place.
const writeHash = (w: unknown) => `sha256:${createHash("sha256").update(serialize(w)).digest("hex")}`;
const hash = (e: Record<string, unknown>) => {
  const { sig: _s, ...rest } = e;
  if (Array.isArray(rest.writes)) rest.writes = rest.writes.map(writeHash);
  return createHash("sha256").update(serialize(rest)).digest();
};

// Reuse the published test key when there is one, so the cases stay stable; mint one only the first time.
import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey as keyFrom } from "node:crypto";
const kept = existsSync("_keys.json") ? (JSON.parse(readFileSync("_keys.json", "utf8")).keys["test.example"] as { public: string; "private-test-only": string } | undefined) : undefined;
const { privateKey, publicKey } = kept
  ? (() => { const k = keyFrom({ key: { kty: "OKP", crv: "Ed25519", x: kept.public, d: kept["private-test-only"] }, format: "jwk" }); return { privateKey: k, publicKey: createPublicKey(k) }; })()
  : generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" }).x as string;
const priv = privateKey.export({ format: "jwk" }).d as string;
const other = generateKeyPairSync("ed25519").privateKey;

// Run from corpus/store: node ../tools/gen-signed.ts. It mints a fresh test key, so the cases change.
writeFileSync("_keys.json", `${JSON.stringify({
  "_note": "TEST KEYS ONLY. The private key is published on purpose so anyone can regenerate the signed cases. Never use it for real data.",
  "keys": { "test.example": { "alg": "Ed25519", "public": pub, "private-test-only": priv } }
}, null, 2)}\n`);

function chain(signer: (i: number) => typeof privateKey) {
  const base = [
    { log: "L-1", owner: "test.example", at: "2026-10-14T09:00:00Z", by: { person: "staff-1" }, writes: [{ record: "P-1", address: "title", value: "Christmas Vacation" }] },
    { log: "L-2", owner: "test.example", at: "2026-10-14T09:05:00Z", by: { contract: "ocr", run: "R-1" }, writes: [{ record: "P-1", address: "runtime", value: { $qty: "97", unit: "min" } }] },
    { log: "L-3", owner: "test.example", at: "2026-10-14T09:10:00Z", by: { rule: "listingTitle" }, writes: [{ record: "P-1", address: "listingTitle", value: "Christmas Vacation [DVD]" }] },
  ] as Record<string, unknown>[];
  const out: Record<string, unknown>[] = [];
  base.forEach((e, i) => {
    const entry: Record<string, unknown> = { ...e };
    if (i > 0) entry.prev = `sha256:${hash(out[i - 1] as Record<string, unknown>).toString("hex")}`;
    entry.sig = sign(null, hash(entry), signer(i)).toString("base64url");
    out.push(entry);
  });
  return out;
}

const dump = (dir: string, log: unknown, verdict: unknown, readme: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/log.json`, `${JSON.stringify(log, null, 2)}\n`);
  writeFileSync(`${dir}/expected-verify.json`, `${JSON.stringify(verdict, null, 2)}\n`);
  writeFileSync(`${dir}/README.md`, `${readme}\n`);
};
dump("011-signed-chain", chain(() => privateKey), { valid: true },
  "A chain signed with the test key in `_keys.json`: each `sig` is Ed25519 over the entry's SHA-256 hash, base64url (chapter 8.5).");
dump("012-bad-signature", chain((i) => (i === 1 ? other : privateKey)), { valid: false, "breaks-at": "L-2", reason: "signature" },
  "L-2 is signed with a key that isn't the owner's published key: its links are fine, its signature is not.");
void createPrivateKey; void createPublicKey;
