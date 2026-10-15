// exchange.ts: the Exchange level (spec chapters 7, 9 at borders, 11). Contracts are checked at publish
// (7.10) and run in seven steps (7.4): trigger and permission, needs, map out, act, map back, rules,
// record. Runs are idempotent (7.5). Offer and take share between owners, and only the overlap flows
// (7.8). Data crossing a border is verified against the presenter's published key (8.5.1).

import type { Access, Edge } from "./access.ts";
import { arrive, type Arrival } from "./arrival.ts";
import type { Journal } from "./log.ts";
import type { StreamEntry, Views } from "./views.ts";
import { serialize } from "./canonical.ts";
import { evaluate, parseCondition, type StateOf } from "./conditions.ts";
import type { ClassLine, Dictionary } from "./defs.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import { Engine, type Result, type Rule } from "./rules.ts";
import { isSchedule, readSchedule, ticksDue } from "./schedule.ts";
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
  send: ["needs", "gives", "writes", "reads", "stream", "to", "when", "missed", "who", "auth", "scope", "credential", "retry", "undo", "for", "label", "describe", "version"],
  receive: ["needs", "gives", "reads", "when", "missed", "who", "origin", "lands", "evidence", "absorb", "ignore", "keep-raw", "prefix", "ref", "relation", "auth", "scope", "credential", "retry", "undo", "for", "label", "describe", "version"],
  store: ["needs", "stores", "when", "who", "for", "label", "describe", "version"],
  form: ["needs", "gives", "writes", "reads", "when", "who", "origin", "lands", "ref", "relation", "for", "label", "describe", "version"],
  offer: ["needs", "gives", "to", "mode", "terms", "for", "when", "who", "label", "describe", "version"],
  take: ["needs", "from", "reads", "mode", "lands", "origin", "absorb", "ignore", "keep-raw", "prefix", "ref", "when", "who", "for", "label", "describe", "version"],
};

function ourKey(address: string): string {
  return address.replace(/^\w+::/, "").split(/[.[]/)[0] as string;
}

/** Check contracts against a dictionary (7.10). Throws the first problem. `views` lets stream contracts be checked. */
export function checkContracts(contracts: Contract[], dict: Dictionary, ownPrefix = "", views?: Set<string>): void {
  const names = new Set(contracts.map((c) => c.name));
  for (const c of contracts) {
    const allowed = PARTS[c.kind];
    if (!allowed) throw new CrubalError(`unknown contract kind ${c.kind}`, c.line);
    for (const [part, line] of Object.entries(c.partLines)) {
      if (part === "kind" || part.includes(":")) continue;
      if (!allowed.includes(part)) throw new CrubalError(`a ${c.kind} contract has no part ${part}`, line);
    }
    // A stream contract (12.6.2) carries projection entries: nothing is mapped and nothing is needed.
    if (c.stream.length) {
      if (c.writes.length || c.needs.length) throw new CrubalError(`${c.name} carries a stream, so it has no writes and no needs`, c.partLines.stream);
      if (!c.parts.to) throw new CrubalError(`${c.name} carries a stream, so it names who it goes to`, c.partLines.stream);
      if (views) for (const v of c.stream) if (!views.has(v)) throw new CrubalError(`${c.name} streams ${v}, which isn't a view`, c.partLines.stream);
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
    // `when` is a condition, `asked` (a caller starts it), `entry` (a stream contract runs as its views
    // publish) or a schedule (7.11).
    if (c.who) parseCondition(c.who, c.line);
    if (c.when && c.when !== "asked" && c.when !== "entry") {
      if (isSchedule(c.when)) readSchedule(c.when, c.partLines.when);
      else parseCondition(c.when, c.line);
    }
    if (c.when === "entry" && !c.stream.length) throw new CrubalError(`${c.name} runs on entry but carries no stream`, c.partLines.when);
    const missed = c.parts.missed;
    if (missed && !["once", "all", "skip"].includes(missed)) throw new CrubalError(`${c.name}: missed is once, all or skip`, c.partLines.missed);
    if (missed && !isSchedule(c.when)) throw new CrubalError(`${c.name}: missed belongs to a scheduled contract`, c.partLines.missed);
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
  /** The records, shared with the Access that decides over them (chapter 14). */
  records = new Map<string, Record>();
  bindings = new Map<string, string>();
  /** Set to make the border consult access: `run` needs the caller's `run` item, gated access suggests. */
  access?: Access;
  /** Set to make every run a transaction (8.5): the border works on the journal's draft and commits each run. */
  journal?: Journal;
  /** Set to let stream contracts (12.6.2) carry the views' projection streams. */
  views?: Views;
  /** Per stream contract, the cursor each view's index has acknowledged, with the version it was for. */
  private cursors = new Map<string, { [view: string]: { version: string; seq: number } }>();
  /** The rules a run's step 6 applies (7.4): the package's, plus the facet shortcuts the engine adds. */
  readonly engine: Engine;
  private sent = new Set<string>();
  private runs = 0;
  private minted = 0;

  constructor(dict: Dictionary, contracts: Contract[], roles: Role[] = [], rules: Rule[] = []) {
    this.dict = dict;
    this.contracts = new Map(contracts.map((c) => [c.name, c]));
    this.roles = roles;
    this.engine = new Engine(dict, rules);
  }

  /**
   * Step 6 of a run (7.4): what came in runs through the rules (chapter 6). A `must` the write breaks
   * refuses it and nothing changes; a hold takes the value out of the current values; a fill or derivation
   * lands with `origin: derived` and the rule as its `via`. Returns the record to keep, or the refusal.
   */
  private applyRules(landed: Record, touched: JsonObject): { record: Record; summary: JsonObject } | { refused: Result } {
    const results = this.engine.write({ ...landed, values: touched });
    const refused = results.find((r) => r.result === "refused");
    if (refused) return { refused };
    const after = this.engine.get(landed.id);
    if (!after) return { record: landed, summary: {} };
    const values: JsonObject = { ...landed.values };
    const sources: { [a: string]: Source } = { ...(landed.sources ?? {}) };
    const summary: JsonObject = {};
    const held: { [a: string]: JsonObject } = { ...((landed as unknown as { held?: { [a: string]: JsonObject } }).held ?? {}) };
    for (const r of results) {
      if ((r.result === "filled" || r.result === "derived") && r.address && r.value !== undefined && r.rule) {
        values[r.address] = r.value;
        sources[r.address] = { origin: "derived", via: r.rule };
        const bag = (summary[r.result] ?? {}) as JsonObject;
        bag[r.address] = r.value;
        summary[r.result] = bag;
      }
      if (r.result === "held" && r.address && r.rule) {
        const v = values[r.address];
        if (v !== undefined) {
          held[r.address] = { value: v, rule: r.rule };
          delete values[r.address];
          delete sources[r.address];
        }
        summary.held = [...((summary.held as Json[]) ?? []), r.address];
      }
      if (r.result === "flagged" && r.rule) summary.flagged = [...((summary.flagged as Json[]) ?? []), r.rule];
    }
    const record = { ...landed, values, sources, ...(Object.keys(held).length ? { held } : {}) } as unknown as Record;
    this.engine.put(record);
    return { record, summary };
  }

  /** Work on a journal's draft, so every run the border makes is one logged entry (8.5). */
  useJournal(journal: Journal) {
    this.journal = journal;
    for (const [id, r] of this.records) journal.draft.records.set(id, r);
    for (const [k, v] of this.bindings) journal.draft.bindings.set(k, v);
    this.records = journal.draft.records;
    this.bindings = journal.draft.bindings;
    if (this.access) {
      for (const [k, e] of this.access.edges) journal.draft.edges.set(k, e as unknown as JsonObject);
      this.access.edges = journal.draft.edges as unknown as Map<string, Edge>;
    }
  }

  /** Log a run's transaction: what it changed on the draft, and the run's own state (8.5). */
  private commit(by: JsonObject, log: string, run: JsonObject) {
    this.journal?.commit(by, () => {}, `2026-01-01T00:00:${String(this.runs).padStart(2, "0")}Z`, [{ run: log, ...run }]);
  }

  /** Step 1 of a run (7.4): the menu is the permission (14.6); `who` only narrows. */
  private permitted(c: Contract, recordId: string, callerId?: string): string | null {
    if (this.access && callerId && !this.access.may(callerId, "run", c.name, recordId)) return "permission";
    if (c.who) {
      const caller = callerId ? this.records.get(callerId) : undefined;
      const ok = evaluate(parseCondition(c.who), caller ? { ...caller.values } : {}, callerStates(caller, this.roles));
      if (ok !== true) return "who";
    }
    return null;
  }

  /** The gated edge a caller's access comes through, if every granting edge is gated (14.7). */
  private gate(recordId: string, callerId?: string): Edge | null {
    return this.access && callerId ? this.access.gated(callerId, recordId) : null;
  }

  /**
   * A contract that creates a record for a caller grants their edge on it (14.4): `mode: consume`, the
   * contract's `relation`, under the owner's grant.
   */
  private grantConsumer(c: Contract, recordId: string, callerId: string): Edge | null {
    const relation = c.parts.relation;
    if (!this.access || !relation) return null;
    const edge: Edge = { edge: `E-${c.name}-${recordId}`, who: callerId, relation, mode: "consume", on: recordId, grants: [], by: "owner", line: c.line };
    this.access.edges.set(edge.edge, edge);
    return edge;
  }

  put(r: Record) {
    this.records.set(r.id, r);
    this.engine.put(r);
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

    // 1. Permission and trigger.
    const stopped = this.permitted(c, recordId, callerId);
    if (stopped) return { ...head, stopped };
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
    this.commit({ contract: name, run: log }, log, { contract: name, key, state: "acted" });
    return { ...head, acted: true, payload, key, log };
  }

  private needsOf(c: Contract): ClassLine[] {
    return c.needs;
  }

  /**
   * Steps 5–6 for a receive contract: map the answer back, compare with the record, and land it. Under a
   * gated edge (14.7) the values land as suggestions for the edge's reviewer, whatever the contract says.
   */
  receiveRun(name: string, recordId: string, body: string, callerId?: string): RunResult {
    const c = this.contracts.get(name);
    const r = this.records.get(recordId);
    if (!c || !r) throw new Error(`no contract ${name} or record ${recordId}`);
    const head: RunResult = { contract: name, record: recordId, ...(callerId ? { caller: callerId } : {}) };
    const stopped = this.permitted(c, recordId, callerId);
    if (stopped) return { ...head, stopped };
    const log = this.nextLog();
    const intake = receive(c, body, recordId, this.dict, `I-${log.slice(2)}`);
    const outcomes: IntakeOutcome[] = intake.outcomes.map((o) => {
      if (o.outcome !== "absorbed" || !o.to) return o;
      // A value a must rule won't have is a contradiction citing the rule (9.3): parked, never landed.
      const broken = this.engine.probe({ ...r, values: { [o.to]: o.value as Json } });
      if (broken) return { ...o, outcome: "contradiction", cites: { rule: broken.rule ?? "" } };
      const current = r.values[o.to];
      if (current === undefined || (isObj(current) && "$empty" in current)) return o;
      return serialize(current) === serialize(o.value as Json) ? o : { ...o, outcome: "conflict" };
    });
    const source: Source = { origin: c.origin, via: log };
    const gate = this.gate(recordId, callerId);
    let summary: JsonObject = {};
    if (c.lands === "suggestion" || gate) this.put(suggest(r, outcomes, source));
    else {
      const landed = land(r, { outcomes, contract: name }, source, this.dict.trust, this.dict.facetTrust);
      // 6. Rules, over what this run changed.
      const touched: JsonObject = {};
      for (const [k, v] of Object.entries(landed.values)) if (serialize(r.values[k] ?? "∅") !== serialize(v)) touched[k] = v;
      const ruled = this.applyRules(landed, touched);
      if ("refused" in ruled) return { ...head, stopped: "rule", rule: ruled.refused.rule ?? "", address: ruled.refused.address ?? "", log };
      this.put(ruled.record);
      summary = ruled.summary;
    }
    this.commit({ contract: name, run: log }, log, { contract: name, record: recordId, state: "closed" });
    return { ...head, outcomes: outcomes as unknown as Json, sources: { origin: c.origin }, log, landed: gate || c.lands === "suggestion" ? "suggestion" : "value", ...(gate ? { gated: gate.edge, reviewer: gate.reviewer ?? gate.by } : {}), ...(Object.keys(summary).length ? { rules: summary } : {}) };
  }

  /**
   * An arrival through a contract (9.2a): the payload finds or makes its record; a new record made for a
   * caller gets their consumer edge (14.4).
   */
  arriveRun(name: string, body: string, level: string, callerId?: string, of?: string): RunResult {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const log = this.nextLog();
    const owner = this.access?.owner ?? [...this.records.values()][0]?.owner ?? "";
    // A refusal by the rules puts everything back: the arrival never happened.
    const prevRecords = new Map(this.records);
    const prevBindings = new Map(this.bindings);
    const { arrival, record } = arrive(c, body, level, this, this.dict, { mint: () => `${level.charAt(0).toUpperCase()}-NEW${++this.minted}`, owner, ...(of ? { of } : {}), intakeId: `I-${log.slice(2)}` });
    const out: RunResult = { contract: name, ...(callerId ? { caller: callerId } : {}), arrival: arrival as unknown as Json, log };
    if (record) {
      // 6. Rules, over what landed (everything, for a new record).
      const was = prevRecords.get(record.id);
      const touched: JsonObject = {};
      for (const [k, v] of Object.entries(record.values)) if (!was || serialize(was.values[k] ?? "∅") !== serialize(v)) touched[k] = v;
      const ruled = this.applyRules(record, touched);
      if ("refused" in ruled) {
        this.records.clear();
        for (const [k, v] of prevRecords) this.records.set(k, v);
        this.bindings.clear();
        for (const [k, v] of prevBindings) this.bindings.set(k, v);
        if (was) this.engine.put(was);
        return { contract: name, ...(callerId ? { caller: callerId } : {}), stopped: "rule", rule: ruled.refused.rule ?? "", address: ruled.refused.address ?? "", log };
      }
      this.put(ruled.record);
      if (Object.keys(ruled.summary).length) out.rules = ruled.summary;
    }
    if (record && arrival.outcome === "new" && callerId) {
      const edge = this.grantConsumer(c, record.id, callerId);
      if (edge) out.granted = { edge: edge.edge, relation: edge.relation, mode: edge.mode, on: edge.on };
    }
    this.commit(callerId && c.kind === "form" ? { person: callerId } : { contract: name, run: log }, log, { contract: name, ...(record ? { record: record.id } : {}), state: arrival.outcome === "held" ? "started" : "closed" });
    return out;
  }

  /** The arrival type, re-exported for callers that read `arrival`. */
  static arrivalOf(r: RunResult): Arrival | undefined {
    return r.arrival as unknown as Arrival | undefined;
  }

  /**
   * A stream contract's run (12.6.2): the entries of each view since the cursor, in order. Pushed (the
   * stored cursor, acknowledged by the index) or pulled (the caller's cursor). A view above `public` goes
   * only to a party holding `run` for the contract.
   */
  streamRun(name: string, callerId?: string, cursor?: { [view: string]: number }): RunResult {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    if (!c.stream.length) throw new Error(`${name} carries no stream`);
    if (!this.views) throw new Error("no views to stream from");
    const party = callerId ?? c.parts.to ?? "";
    const head: RunResult = { contract: name, caller: party };
    for (const v of c.stream) {
      const view = this.views.set.views.get(v);
      if (view && view.show !== "public" && !this.access?.mayAnywhere(party, "run", name)) return { ...head, stopped: "permission", view: v };
    }
    const log = this.nextLog();
    const stored = this.cursors.get(name) ?? {};
    const entries: JsonObject = {};
    const out: JsonObject = {};
    const batches: string[] = [];
    for (const v of c.stream) {
      this.views.stream(v);
      const version = this.views.versionOf(v);
      const held = stored[v];
      const since = cursor?.[v] ?? (held && held.version === version ? held.seq : 0);
      const list: StreamEntry[] = this.views.entriesSince(v, since);
      entries[v] = list as unknown as Json;
      out[v] = list.at(-1)?.seq ?? since;
      if (list.length) batches.push(`${name}|${v}|${version}|${list[0]?.seq}-${list.at(-1)?.seq}`);
    }
    return { ...head, entries, cursor: out, ...(batches.length ? { key: batches.join(" ") } : {}), log };
  }

  private lastTick = new Map<string, string>();

  /**
   * A scheduled contract's tick (7.11): the host offers its clock as `now`; every tick due since the last
   * one runs (or only the latest, or none, by `missed`), each run keyed by the contract and the tick so a
   * restarted host never runs a tick twice. A send contract with `for` runs over every record it selects;
   * a stream contract pushes; any other runs once with no record.
   */
  tick(name: string, now: string, callerId?: string): RunResult {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    if (!isSchedule(c.when)) throw new Error(`${name} isn't scheduled`);
    const sch = readSchedule(c.when as string);
    // A schedule begins when its contract is published (7.11): here, at the first clock reading.
    if (!this.lastTick.has(name)) {
      this.lastTick.set(name, now);
      return { contract: name, now, ticks: [], runs: [], began: now };
    }
    const due = ticksDue(sch, this.lastTick.get(name), now);
    const missed = c.parts.missed ?? "once";
    const run = missed === "all" ? due : missed === "once" ? due.slice(-1) : [];
    const skipped = due.filter((t) => !run.includes(t));
    const results: Json[] = [];
    for (const tick of run) {
      const key = `${name}|${tick}`;
      if (this.sent.has(key)) continue;
      this.sent.add(key);
      if (c.stream.length) {
        const r = this.streamRun(name, callerId);
        results.push({ tick, ...r } as Json);
        continue;
      }
      const targets = c.parts.for ? [...this.records.values()].filter((r) => (r.wears ?? []).includes(c.parts.for as string) || r.level === c.parts.for || r.kind === c.parts.for).map((r) => r.id) : [];
      if (!targets.length) {
        const log = this.nextLog();
        this.commit({ contract: name, run: log }, log, { contract: name, tick, key, state: "acted" });
        results.push({ tick, log, acted: true });
        continue;
      }
      for (const id of targets) results.push({ tick, ...this.run(name, id, callerId) } as Json);
    }
    if (due.length) this.lastTick.set(name, due[due.length - 1] as string);
    return { contract: name, now, ticks: run, ...(skipped.length ? { skipped } : {}), runs: results };
  }

  /** The index acknowledges what it holds: the store resumes from there (12.6.2). */
  ack(name: string, cursor: { [view: string]: number }): RunResult {
    const stored = this.cursors.get(name) ?? {};
    for (const [v, seq] of Object.entries(cursor)) stored[v] = { version: this.views?.versionOf(v) ?? "", seq };
    this.cursors.set(name, stored);
    return { contract: name, acked: cursor };
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
    this.commit({ take: takeName, from: presenter.owner }, log, { contract: takeName, record: recordId, state: "closed" });
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
