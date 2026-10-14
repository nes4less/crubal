// exchange.ts: the Exchange level (spec chapters 7, 9 at borders, 11). Contracts are checked at publish
// (7.10) and run in seven steps (7.4): trigger and permission, needs, map out, act, map back, rules,
// record. Runs are idempotent (7.5). Offer and take share between owners, and only the overlap flows
// (7.8). Data crossing a border is verified against the presenter's published key (8.5.1).

import { serialize } from "./canonical.ts";
import { evaluate, parseCondition, type StateOf } from "./conditions.ts";
import type { ClassLine, Dictionary } from "./defs.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import { type Contract, fieldPath, type IntakeOutcome, type Keys, land, receive, sha256, verifyChain } from "./store.ts";
import { CrubalError, readTree } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

// ─── Roles (12.4), as `who` needs them ───────────────────────────────────────

export type Role = { name: string; audience: string; may: { [verb: string]: string[] }; line: number };

export function readRoles(source: string): Role[] {
  const out: Role[] = [];
  for (const node of readTree(source)) {
    if (node.kind !== "pair" || node.key !== "role") continue;
    const role: Role = { name: node.value.trim(), audience: "member", may: {}, line: node.line };
    for (const c of node.children) {
      if (c.key === "audience") role.audience = c.value;
      if (c.key === "may") for (const g of c.children) if (g.key) role.may[g.key] = g.value.split(",").map((s) => s.trim());
    }
    out.push(role);
  }
  return out;
}

/** What a caller is, for `who` (7.6): its values, the classes it wears, and its roles' grants. */
function callerStates(caller: Record | undefined, roles: Role[]): StateOf {
  return (path) => {
    const s = new Set<string>();
    if (path !== "caller" || !caller) return s;
    for (const w of caller.wears ?? []) s.add(`wears:${w}`);
    const held = caller.values.roles;
    const names = (Array.isArray(held) ? held : held ? [held] : []).map((r) => (isObj(r) && "$link" in r ? String(r.$link) : String(r)));
    for (const r of roles.filter((x) => names.includes(x.name))) {
      for (const [verb, targets] of Object.entries(r.may)) for (const t of targets) s.add(`may:${verb} ${t}`);
    }
    return s;
  };
}

// ─── Publish checks (7.10) ───────────────────────────────────────────────────

const PARTS: { [kind: string]: string[] } = {
  send: ["needs", "gives", "writes", "reads", "when", "who", "auth", "scope", "credential", "retry", "undo", "for", "label", "describe", "version"],
  receive: ["needs", "gives", "reads", "when", "who", "origin", "lands", "evidence", "absorb", "ignore", "keep-raw", "prefix", "auth", "scope", "credential", "retry", "undo", "for", "label", "describe", "version"],
  store: ["needs", "stores", "when", "who", "for", "label", "describe", "version"],
  form: ["needs", "gives", "writes", "reads", "when", "who", "origin", "lands", "for", "label", "describe", "version"],
  offer: ["needs", "gives", "to", "mode", "terms", "for", "when", "who", "label", "describe", "version"],
  take: ["needs", "from", "reads", "mode", "lands", "origin", "absorb", "ignore", "keep-raw", "prefix", "when", "who", "for", "label", "describe", "version"],
};

function ourKey(address: string): string {
  return address.replace(/^\w+::/, "").split(/[.[]/)[0] as string;
}

/** Check contracts against a dictionary (7.10). Throws the first problem. */
export function checkContracts(contracts: Contract[], dict: Dictionary, ownPrefix = ""): void {
  const names = new Set(contracts.map((c) => c.name));
  for (const c of contracts) {
    const allowed = PARTS[c.kind];
    if (!allowed) throw new CrubalError(`unknown contract kind ${c.kind}`, c.line);
    for (const [part, line] of Object.entries(c.partLines)) {
      if (part === "kind" || part.includes(":")) continue;
      if (!allowed.includes(part)) throw new CrubalError(`a ${c.kind} contract has no part ${part}`, line);
    }
    for (const l of c.needs) if (!dict.facets.has(l.facet)) throw new CrubalError(`${l.facet} is not a defined facet`, l.line);
    const sides: { address: string; line: number; values: string[]; valueLines: number[]; mayBeUnknown: boolean }[] = [
      ...c.writes.filter((m) => !m.from.startsWith('"')).map((m) => ({ address: m.from, line: m.line, values: m.values.map(([ours]) => ours), valueLines: m.valueLines, mayBeUnknown: false })),
      ...c.reads.map((m) => ({ address: m.to, line: m.line, values: m.values.map(([, ours]) => ours), valueLines: m.valueLines, mayBeUnknown: true })),
    ];
    for (const s of sides) {
      const key = ourKey(s.address);
      const f = dict.facets.get(key);
      const foreign = key.includes(":") && !(ownPrefix && key.startsWith(`${ownPrefix}:`));
      if (!f) {
        if (s.mayBeUnknown && foreign) continue;
        throw new CrubalError(`${key} is not a defined facet`, s.line);
      }
      s.values.forEach((v, i) => {
        if (f.type !== "choice" || v === "-") return;
        if ((f.values ?? []).some((x) => x.value === v)) return;
        const of = (f.values ?? []).find((x) => x.aliases.includes(v));
        throw new CrubalError(of ? `${v} is an alias of ${of.value}; a value map must name the real value` : `${v} is not a value of ${key}`, s.valueLines[i] ?? s.line);
      });
    }
    for (const cond of [c.who, c.when]) if (cond && cond !== "asked") parseCondition(cond, c.line);
    if (c.undo && !names.has(c.undo)) throw new CrubalError(`${c.name}'s undo names ${c.undo}, which isn't a contract here`, c.partLines.undo);
    const cred = c.parts.credential;
    if (cred && /[^A-Za-z0-9._-]/.test(cred)) throw new CrubalError(`${c.name}'s credential must be a name, never a secret`, c.partLines.credential);
  }
}

// ─── Running a contract (7.4, 7.5) ───────────────────────────────────────────

export type RunResult = { [k: string]: Json };

/** The plain text a value is sent as: an amount for money and quantities, a target for links. */
function wire(v: Json): Json {
  if (isObj(v)) {
    if ("$value" in v) return wire(v.$value as Json);
    if ("$money" in v) return String(v.$money);
    if ("$qty" in v) return String(v.$qty);
    if ("$link" in v) return String(v.$link);
    if ("$image" in v) return String(v.$image);
    if ("$empty" in v) return "";
  }
  if (Array.isArray(v)) return v.map(wire);
  return v;
}

function put(payload: JsonObject, path: string, value: Json) {
  const names = fieldPath(path);
  let at = payload;
  names.slice(0, -1).forEach((n) => {
    if (!isObj(at[n])) at[n] = {};
    at = at[n] as JsonObject;
  });
  at[names.at(-1) as string] = value;
}

export class Exchange {
  readonly dict: Dictionary;
  readonly contracts: Map<string, Contract>;
  readonly roles: Role[];
  private records = new Map<string, Record>();
  private sent = new Set<string>();
  private runs = 0;

  constructor(dict: Dictionary, contracts: Contract[], roles: Role[] = []) {
    this.dict = dict;
    this.contracts = new Map(contracts.map((c) => [c.name, c]));
    this.roles = roles;
  }

  put(r: Record) {
    this.records.set(r.id, r);
  }

  get(id: string): Record | undefined {
    return this.records.get(id);
  }

  /** A record's values with everything above it read through (1.7). */
  effective(r: Record): JsonObject {
    const up = r.of ? this.records.get(r.of) : undefined;
    return { ...(up ? this.effective(up) : {}), ...r.values };
  }

  /** The value an address names from a record, with a level prefix reading that level. */
  private read(r: Record, address: string): Json | undefined {
    const m = address.match(/^(\w+)::(.+)$/);
    // A level prefix reads the record at that level: the run's record itself, when it sits there.
    if (m) return r.level === m[1] ? this.effective(r)[m[2] as string] : undefined;
    return this.effective(r)[address];
  }

  private nextLog(): string {
    this.runs += 1;
    return `L-R${this.runs}`;
  }

  /** Steps 1–4 of a send (or form) contract: permission, needs, map out, act once. */
  run(name: string, recordId: string, callerId?: string): RunResult {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const r = this.records.get(recordId);
    if (!r) throw new Error(`no record ${recordId}`);
    const head: RunResult = { contract: name, record: recordId, ...(callerId ? { caller: callerId } : {}) };
    const log = this.nextLog();

    // 1. Trigger and permission.
    if (c.who) {
      const caller = callerId ? this.records.get(callerId) : undefined;
      const ok = evaluate(parseCondition(c.who), caller ? { ...caller.values } : {}, callerStates(caller, this.roles));
      if (ok !== true) return { ...head, stopped: "who" };
    }
    // 2. Needs: an unnamed class over the record.
    const missing: string[] = [];
    const unfit: string[] = [];
    for (const l of this.needsOf(c)) {
      const v = this.read(r, l.level ? `${l.level}::${l.facet}` : l.facet);
      const empty = v === undefined || (isObj(v) && "$empty" in v);
      if (l.required && empty) missing.push(l.facet);
      if (!empty && l.values && typeof v === "string" && !l.values.includes(v)) unfit.push(l.facet);
      if (!empty && l.length !== undefined && typeof v === "string" && [...v].length > l.length) unfit.push(l.facet);
    }
    if (missing.length || unfit.length) return { ...head, stopped: "needs", ...(missing.length ? { missing } : {}), ...(unfit.length ? { unfit } : {}) };

    if (c.kind === "receive" || c.kind === "take") return { ...head, ready: true, log };

    // 3. Map out.
    const payload: JsonObject = {};
    for (const m of c.writes) {
      if (m.from.startsWith('"')) {
        put(payload, m.to, JSON.parse(m.from) as string);
        continue;
      }
      const v = this.read(r, m.from);
      if (v === undefined) continue;
      const mapped = typeof v === "string" ? (m.values.find(([ours]) => ours === v)?.[1] ?? v) : v;
      put(payload, m.to, wire(mapped));
    }
    // 4. Act, at most once per contract, record and payload.
    const key = `${name}|${recordId}|${sha256(serialize(payload))}`;
    if (this.sent.has(key)) return { ...head, acted: false, reason: "the same payload was already sent" };
    this.sent.add(key);
    return { ...head, acted: true, payload, key, log };
  }

  private needsOf(c: Contract): ClassLine[] {
    return c.needs;
  }

  /** Steps 5–6 for a receive contract: map the answer back, compare with the record, and land it. */
  receiveRun(name: string, recordId: string, body: string): RunResult {
    const c = this.contracts.get(name);
    const r = this.records.get(recordId);
    if (!c || !r) throw new Error(`no contract ${name} or record ${recordId}`);
    const log = this.nextLog();
    const intake = receive(c, body, recordId, this.dict, `I-${log.slice(2)}`);
    const outcomes: IntakeOutcome[] = intake.outcomes.map((o) => {
      if (o.outcome !== "absorbed" || !o.to) return o;
      const current = r.values[o.to];
      if (current === undefined || (isObj(current) && "$empty" in current)) return o;
      return serialize(current) === serialize(o.value as Json) ? o : { ...o, outcome: "conflict" };
    });
    const source: Source = { origin: c.origin, via: log };
    if (c.lands === "suggestion") this.put(suggest(r, outcomes, source));
    else this.put(land(r, { outcomes, contract: name }, source, this.dict.trust, this.dict.facetTrust));
    return { contract: name, record: recordId, outcomes: outcomes as unknown as Json, sources: { origin: c.origin }, log };
  }

  /** Offer and take (7.8): only what the offer gives and the take reads flows. */
  take(takeName: string, offerName: string, recordId: string, presenter: Record): RunResult {
    const t = this.contracts.get(takeName);
    const o = this.contracts.get(offerName);
    const r = this.records.get(recordId);
    if (!t || !o || !r) throw new Error("a take needs its take contract, the offer and the record");
    if (t.from && t.from !== presenter.owner) return { contract: takeName, record: recordId, stopped: "from" };
    const log = this.nextLog();
    const values: JsonObject = { ...r.values };
    const sources: { [a: string]: Source } = { ...(r.sources ?? {}) };
    const alternatives: { [a: string]: JsonObject[] } = { ...((r as unknown as { alternatives?: { [a: string]: JsonObject[] } }).alternatives ?? {}) };
    const flows: string[] = [];
    for (const m of t.reads) {
      const theirs = m.from;
      if (!o.gives.includes(theirs)) continue; // not offered: doesn't flow
      const v = presenter.values[theirs];
      if (v === undefined) continue;
      flows.push(theirs);
      const theirSource = presenter.sources?.[theirs] ?? presenter.sources?.["*"];
      const src: Source = { origin: theirSource?.origin ?? "reported", via: log, owner: presenter.owner };
      const current = values[m.to];
      if (current === undefined || (isObj(current) && "$empty" in current)) {
        values[m.to] = v;
        sources[m.to] = src;
      } else if (serialize(current) !== serialize(v)) {
        // A presenter never overrides the consumer's value unless the consumer took controlled terms.
        alternatives[m.to] = [...(alternatives[m.to] ?? []), { value: v, origin: src.origin, via: log, owner: presenter.owner }];
      }
    }
    const next = { ...r, values, sources, ...(Object.keys(alternatives).length ? { alternatives } : {}) } as Record;
    this.put(next);
    return { contract: takeName, record: recordId, flows, log };
  }
}

function suggest(r: Record, outcomes: IntakeOutcome[], source: Source): Record {
  const s: { [a: string]: JsonObject[] } = { ...((r as unknown as { suggestions?: { [a: string]: JsonObject[] } }).suggestions ?? {}) };
  for (const o of outcomes) {
    if (!o.to || o.value === undefined || o.outcome === "unknown" || o.outcome === "ignored" || o.outcome === "contradiction") continue;
    s[o.to] = [...(s[o.to] ?? []), { value: o.value, origin: source.origin, via: source.via }];
  }
  return { ...r, suggestions: s } as unknown as Record;
}

// ─── Borders (8.5.1) ─────────────────────────────────────────────────────────

/** Verify a border wrapper from another owner: its log against the owner's key, and its values against the log. */
export function verifyBorder(w: { records: Record[]; log?: JsonObject[] }, keys: Keys): JsonObject {
  const owner = w.records[0]?.owner ?? "";
  if (!keys[owner]) return { verified: false, reason: "no key for the owner" };
  const chain = verifyChain(w.log ?? [], keys);
  if (!chain.valid) return { verified: false, "breaks-at": chain["breaks-at"] ?? "", reason: chain.reason ?? "" };
  const byLog = new Map((w.log ?? []).map((e) => [String(e.log), e]));
  for (const r of w.records) {
    for (const [address, value] of Object.entries(r.values)) {
      const via = (r.sources?.[address] ?? r.sources?.["*"])?.via;
      const entry = via ? byLog.get(via) : undefined;
      const writes = Array.isArray(entry?.writes) ? (entry.writes as JsonObject[]) : [];
      const write = writes.find((x) => x.record === r.id && x.address === address);
      if (!write || serialize(write.value as Json) !== serialize(value)) return { verified: false, record: r.id, address, reason: "value doesn't match the log" };
    }
  }
  return { verified: true, records: w.records.length, owner };
}
