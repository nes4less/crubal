// Run from corpus/exchange: node ../tools/gen-border.ts. Mints a fresh test key for distributor.example and
// writes a signed border wrapper (008) and a tampered copy (009). The cases change when it runs.
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
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
const kept = existsSync("_keys.json") ? (JSON.parse(readFileSync("_keys.json", "utf8")).keys["distributor.example"] as { public: string; "private-test-only": string } | undefined) : undefined;
const { privateKey, publicKey } = kept
  ? (() => { const k = keyFrom({ key: { kty: "OKP", crv: "Ed25519", x: kept.public, d: kept["private-test-only"] }, format: "jwk" }); return { privateKey: k, publicKey: createPublicKey(k) }; })()
  : generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" }).x as string;
const priv = privateKey.export({ format: "jwk" }).d as string;

const record = {
  id: "D-100", kind: "item", level: "product", owner: "distributor.example",
  values: { title: "Christmas Vacation", runtime: { $qty: "97", unit: "min" } },
  sources: { "*": { origin: "declared", via: "L-1" }, runtime: { origin: "observed", via: "L-2" } },
};
const entries: Record<string, unknown>[] = [];
for (const [i, e] of [
  { log: "L-1", owner: "distributor.example", at: "2026-10-14T08:00:00Z", by: { person: "editor-1" }, writes: [{ record: "D-100", address: "title", value: "Christmas Vacation" }] },
  { log: "L-2", owner: "distributor.example", at: "2026-10-14T08:05:00Z", by: { contract: "measure", run: "R-9" }, writes: [{ record: "D-100", address: "runtime", value: { $qty: "97", unit: "min" } }] },
].entries()) {
  const entry: Record<string, unknown> = { ...e };
  if (i > 0) entry.prev = `sha256:${hash(entries[i - 1] as Record<string, unknown>).toString("hex")}`;
  entry.sig = sign(null, hash(entry), privateKey).toString("base64url");
  entries.push(entry);
}
const wrapper = { crubal: "2", package: "distributor.example/catalog /2026-10-01", records: [record], log: entries };
const keys = { "distributor.example": { alg: "Ed25519", public: pub } };
const write = (dir: string, w: unknown, expected: unknown, note: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/border.json`, `${JSON.stringify(w, null, 2)}\n`);
  writeFileSync(`${dir}/keys.json`, `${JSON.stringify(keys, null, 2)}\n`);
  writeFileSync(`${dir}/expected-border.json`, `${JSON.stringify(expected, null, 2)}\n`);
  writeFileSync(`${dir}/README.md`, `${note}\n`);
};
write("008-border-verified", wrapper, { verified: true, records: 1, owner: "distributor.example" },
  "Data from another owner, with its signed log. The consumer checks it against the presenter's published key (chapter 8.5.1).");
const tampered = JSON.parse(JSON.stringify(wrapper));
tampered.log[1].writes[0].value.$qty = "79";
write("009-border-tampered", tampered, { verified: false, "breaks-at": "L-2", reason: "signature" },
  "The same border, with one value changed after signing: the presenter's signature no longer verifies.");
writeFileSync("_keys.json", `${JSON.stringify({ _note: "TEST KEYS ONLY. Published on purpose; never use for real data.", keys: { "distributor.example": { alg: "Ed25519", public: pub, "private-test-only": priv } } }, null, 2)}\n`);
