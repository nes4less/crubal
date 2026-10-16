// emergency.ts: emergency access (spec 14.13), the mechanics a platform enforces. An emergency edge is
// created only under published terms, with the approvals they require, each a signature with a key kept
// for this alone, none by the requester; it is view or a narrow control, never admin, never grant, never an
// owner power; it lasts no longer than the terms allow; it is written witnessed, into the owner's log; every
// read under it is logged; the owner is told. The people and the policy are the platform's.

import { createPublicKey, verify as edVerify } from "node:crypto";
import { serialize } from "../../crubal/src/canonical.ts";
import type { JsonObject } from "../../crubal/src/model.ts";
import { sha256 } from "../../crubal/src/store.ts";
import type { PgStore } from "../../crubal-postgres/src/store.ts";

export type EmergencyTerms = {
  /** How many approvers an edge needs. */
  approvers: number;
  /** The longest an edge may last, ISO 8601 (`PT24H`). */
  longest: string;
  /** How owners are told. */
  notify?: string;
  /** The approvers' dedicated keys, by approver ID: Ed25519 public halves. */
  keys: { [approver: string]: { alg: string; public: string } };
};

export type EmergencyRequest = {
  edge: string;
  who: string;
  mode: "view" | "control";
  on: string;
  grants?: string[];
  until: string;
  kind: "legal" | "incident";
  reason: string;
  reference: string;
  /** Each approval: the approver and their signature over the edge's hash. */
  approvals: { by: string; sig: string }[];
  notify?: "now" | { delayUntil: string; order: string };
};

const durationMs = (d: string) => {
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  return m ? (Number(m[1] ?? 0) * 24 * 60 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60_000 : Number.NaN;
};

/** What an approver signs: the edge without its approvals and notice. */
export function edgeHash(r: EmergencyRequest): string {
  const { approvals: _a, notify: _n, ...rest } = r;
  return sha256(serialize(rest as unknown as JsonObject));
}

/** Check a request against the terms. Returns the reasons it is refused; none means it may be made. */
export function checkEmergency(r: EmergencyRequest, terms: EmergencyTerms | undefined, now: string): string[] {
  const why: string[] = [];
  if (!terms) return ["the platform publishes no emergency terms, so it can make no emergency edge"];
  if (r.mode !== "view" && r.mode !== "control") why.push("an emergency edge is view or control, never admin");
  if ((r.grants ?? []).some((g) => /^grant\b/.test(g) || g === "grant")) why.push("an emergency edge never carries grant");
  if (r.kind !== "legal" && r.kind !== "incident") why.push("the kind is legal or incident");
  if (!r.reason || !r.reference) why.push("a stated reason and reference are required");
  const approvers = new Set(r.approvals.map((a) => a.by));
  if (approvers.size < terms.approvers) why.push(`${terms.approvers} approvers are required, ${approvers.size} approved`);
  if (approvers.has(r.who)) why.push("the requester may not approve");
  const hash = edgeHash(r);
  for (const a of r.approvals) {
    const k = terms.keys[a.by];
    if (!k) {
      why.push(`${a.by} holds no emergency key`);
      continue;
    }
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.public }, format: "jwk" });
      if (!edVerify(null, Buffer.from(hash, "hex"), key, Buffer.from(a.sig, "base64url"))) why.push(`${a.by}'s approval doesn't verify`);
    } catch {
      why.push(`${a.by}'s approval doesn't verify`);
    }
  }
  const longest = durationMs(terms.longest);
  if (Number.isNaN(Date.parse(r.until)) || Date.parse(r.until) - Date.parse(now) > longest) why.push(`until is later than the terms allow (${terms.longest})`);
  if (Date.parse(r.until) <= Date.parse(now)) why.push("until is already past");
  return why;
}

/** Make the edge in the owner's log: witnessed, by platform, its approvals carried. */
export async function makeEmergencyEdge(store: PgStore, r: EmergencyRequest, terms: EmergencyTerms | undefined, now: string): Promise<{ edge: JsonObject; entry: string }> {
  const why = checkEmergency(r, terms, now);
  if (why.length) throw new Error(`the emergency edge is refused: ${why.join("; ")}`);
  const edge: JsonObject = {
    edge: r.edge, who: r.who, relation: "emergency", mode: r.mode, on: r.on, grants: r.grants ?? [], until: r.until, by: "platform",
    emergency: { kind: r.kind, reason: r.reason, reference: r.reference, approvals: r.approvals as unknown as JsonObject[], notify: (r.notify ?? "now") as unknown as JsonObject, at: now },
  };
  const out = await store.commitFrom((d) => { d.edges.set(r.edge, edge); return { by: { person: r.who }, out: null }; }, now, { witnessed: true });
  if (!out.entry) throw new Error("the edge wrote nothing");
  return { edge, entry: String(out.entry.log) };
}

/** Log a read under an emergency edge (14.13): record by record, witnessed. */
export async function logEmergencyRead(store: PgStore, who: string, recordId: string, edge: string, now: string): Promise<void> {
  await store.commitFrom(() => ({ by: { person: who }, extra: [{ read: recordId, edge }], out: null }), now, { witnessed: true });
}

/** End an emergency edge: the owner may, unless it cites a legal order; the attempt is recorded either way. */
export async function endEmergencyEdge(store: PgStore, edgeId: string, by: string, now: string, isOwner: boolean): Promise<{ ended: boolean; reason?: string }> {
  const state = await store.state();
  const edge = state.edges.get(edgeId);
  if (!edge || edge.relation !== "emergency") throw new Error(`no emergency edge ${edgeId}`);
  const legal = (edge.emergency as JsonObject | undefined)?.kind === "legal";
  if (isOwner && legal) {
    await store.commitFrom(() => ({ by: { person: by }, extra: [{ review: { key: "emergency", edge: edgeId, attempted: "end", by, reason: "a legal order's edge is ended by the order" } }], out: null }), now, { witnessed: true });
    return { ended: false, reason: "a legal order's edge is the order's matter; the attempt is recorded" };
  }
  await store.commitFrom((d) => { d.edges.delete(edgeId); return { by: { person: by }, out: null }; }, now, { witnessed: true });
  return { ended: true };
}
