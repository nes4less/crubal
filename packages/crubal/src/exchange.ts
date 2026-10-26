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
import { MemoryRecords, type RecordSet } from "./records.ts";
import { Engine, type Result, type Rule } from "./rules.ts";
import { isSchedule, readSchedule, ticksDue } from "./schedule.ts";
import { type Contract, fieldPath, type IntakeOutcome, type Keys, land, receive, sha256, verifyChain, proposeSplit, type Observation } from "./store.ts";
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

/**
 * What a caller is, for `who` (7.6): the classes it wears, its roles' grants, and the menu items it holds
 * on the record by its edges (14.6) when the run has access to consult. A caller with no record of its own
 * here (a hosted person, 14.8) is still what its edges make it.
 */
function callerStates(caller: Record | undefined, roles: Role[], held?: (verb: string, target: string) => boolean, asked: string[] = []): StateOf {
  return (path) => {
    const s = new Set<string>();
    if (path !== "caller") return s;
    if (held) for (const q of asked) if (held(q.slice(0, q.indexOf(" ")), q.slice(q.indexOf(" ") + 1))) s.add(`may:${q}`);
    if (!caller) return s;
    for (const w of caller.wears ?? []) s.add(`wears:${w}`);
    const names = (Array.isArray(caller.values.roles) ? caller.values.roles : caller.values.roles ? [caller.values.roles] : []).map((r) => (isObj(r) && "$link" in r ? String(r.$link) : String(r)));
    for (const r of roles.filter((x) => names.includes(x.name))) {
      for (const [verb, targets] of Object.entries(r.may)) for (const t of targets) s.add(`may:${verb} ${t}`);
    }
    return s;
  };
}

// ─── Publish checks (7.10) ───────────────────────────────────────────────────

const PARTS: { [kind: string]: string[] } = {
  send: ["needs", "gives", "writes", "reads", "stream", "to", "when", "missed", "who", "audience", "auth", "scope", "credential", "retry", "undo", "for", "label", "describe", "version"],
  receive: ["needs", "gives", "reads", "when", "missed", "who", "audience", "origin", "lands", "evidence", "absorb", "ignore", "keep-raw", "prefix", "ref", "relation", "auth", "scope", "credential", "retry", "undo", "for", "label", "describe", "version"],
  store: ["needs", "stores", "origin", "when", "who", "audience", "for", "label", "describe", "version"],
  form: ["needs", "gives", "writes", "reads", "when", "who", "audience", "origin", "lands", "ref", "relation", "for", "label", "describe", "version"],
  offer: ["needs", "gives", "to", "mode", "terms", "for", "when", "who", "audience", "label", "describe", "version"],
  take: ["needs", "from", "offer", "reads", "mode", "lands", "origin", "absorb", "ignore", "keep-raw", "prefix", "ref", "when", "who", "audience", "for", "label", "describe", "version"],
};
const AUDIENCES = ["public", "member", "staff", "owner"];
/**
 * The lowest audience that may run a contract (7.2): what it says; else public for one that grants the
 * consumer's edge (a sign-up, a first order: how one becomes a member, 14.4), member for any other form,
 * public otherwise.
 */
const audienceOf = (c: Contract): string => c.parts.audience ?? (c.kind === "form" && !c.parts.relation ? "member" : "public");

function ourKey(address: string): string {
  return address.replace(/^\w+::/, "").split(/[.[]/)[0] as string;
}

/** Check contracts against a dictionary (7.10). Throws the first problem. `views` lets stream contracts be checked. */
export function checkContracts(contracts: Contract[], dict: Dictionary, ownPrefix = "", views?: Set<string>): void {
  const names = new Set(contracts.map((c) => c.name));
  for (const c of contracts) {
    const allowed = PARTS[c.kind];
    if (!allowed) throw new CrubalError(`unknown contract kind ${c.kind}`, c.line);
    if (c.parts.audience && !AUDIENCES.includes(c.parts.audience)) throw new CrubalError(`${c.name}: audience is public, member, staff or owner, not ${c.parts.audience}`, c.partLines.audience ?? c.line);
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
  records: RecordSet = new MemoryRecords();
  bindings = new Map<string, string>();
  /** Set to make the border consult access: `run` needs the caller's `run` item, gated access suggests. */
  access?: Access;
  /** The owner whose records these are, when the caller knows it: a store's border names it, so no run looks at a record to learn it. */
  owner?: string;
  /**
   * How an arrival's new record is named (9.2a). A persistent store sets this to mint the next id of the
   * owner (`P-2` after `P-1`), since an Exchange is built per run and its own counter would start again.
   * Without it the memory border's `<L>-NEW<n>` stands.
   */
  mint?: (level: string) => string;
  /** Set to make every run a transaction (8.5): the border works on the journal's draft and commits each run. */
  journal?: Journal;
  /** Set to let stream contracts (12.6.2) carry the views' projection streams. */
  views?: Views;
  /** Per stream contract, the cursor each view's index has acknowledged, with the version it was for. */
  private cursors = new Map<string, { [view: string]: { version: string; seq: number } }>();
  /** The rules a run's step 6 applies (7.4): the package's, plus the facet shortcuts the engine adds. */
  readonly engine: Engine;
  /** Idempotency keys acted on (7.5); a store that outlives the instance seeds and keeps them. */
  readonly sent = new Set<string>();
  /** Runs so far, which numbers the next run's log; a store continues the count across instances. */
  runs = 0;
  /** Records minted by arrivals (9.2a), likewise. */
  minted = 0;
  /** The versions a run uses (7.4 step 7, 8.5): the package's, set by a store; the contract's is added per run. */
  versions: JsonObject = {};
  /** The review queue the border writes to (a dead run, an answer naming no run); the journal's draft list. */
  review: JsonObject[] = [];
  /** Observations this instance made (9.7); a store keeps every one in its state. */
  observations: JsonObject[] = [];
  private observed = 0;
  /** The package's thresholds (11.1): instances to propose a version split, witnesses to confirm. */
  thresholds: { confirm?: number; split?: number } = {};
  /** Review items already open in the store, for a border that loads them apart from the draft's list. */
  knownReview: JsonObject[] = [];
  /** Mapped-out payloads kept beside the log, by run (docs/design/runs.md): a store keeps them in outtake. */
  readonly outtake = new Map<string, JsonObject>();
  /** Runs the store knows beyond this instance's entries (a border over a store seeds them): run → contract and record. */
  readonly runsKnown = new Map<string, { contract: string; record: string }>();
  /** Runs started and not yet acted or failed, by run: what a restarted host asks the adapter about. */
  readonly started = new Map<string, { contract: string; record: string; key: string; attempts: number; cause?: string }>();

  constructor(dict: Dictionary, contracts: Contract[], roles: Role[] = [], rules: Rule[] = []) {
    this.dict = dict;
    this.contracts = new Map(contracts.map((c) => [c.name, c]));
    this.roles = roles;
    this.engine = new Engine(dict, rules, () => this.records);
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
          const src = sources[r.address];
          held[r.address] = { value: v, rule: r.rule, ...(src ? { source: src as unknown as JsonObject } : {}) };
          delete values[r.address];
          delete sources[r.address];
        }
        summary.held = [...((summary.held as Json[]) ?? []), r.address];
      }
      if (r.result === "released" && r.address && held[r.address]) {
        // The held value comes back as it was (6.7).
        const h = held[r.address] as JsonObject;
        values[r.address] = h.value as Json;
        if (isObj(h.source)) sources[r.address] = h.source as unknown as Source;
        delete held[r.address];
        summary.released = [...((summary.released as Json[]) ?? []), r.address];
      }
      if (r.result === "flagged" && r.rule) summary.flagged = [...((summary.flagged as Json[]) ?? []), r.rule];
    }
    // The held bag is rebuilt from what stayed held: a released key leaves it.
    const { held: _was, ...base } = landed as unknown as { held?: unknown } & Record;
    const record = { ...base, values, sources, ...(Object.keys(held).length ? { held } : {}) } as unknown as Record;
    this.engine.put(record);
    // 6b. What the ancestors derive from below is recomputed now (6.4), nearest first, each landing before
    // the next reads it; the record itself is in the set first, so a rollup over it sees this write.
    if (this.engine.readsLowerLevels) {
      this.records.set(record.id, record);
      const recomputed = this.reproduceAncestors(record.id);
      if (recomputed.length) summary.recomputed = recomputed;
    }
    return { record, summary };
  }

  /** Run the ancestors' productions again after a write below them; the ids whose values changed. */
  reproduceAncestors(id: string): string[] {
    const changed: string[] = [];
    for (const upId of this.engine.ancestorsOf(id)) {
      const up = this.records.get(upId);
      if (!up) break;
      this.engine.put(up);
      const derived = this.engine.reproduce(upId).filter((r) => (r.result === "derived" || r.result === "filled") && r.address && r.value !== undefined && r.rule);
      if (!derived.length) continue;
      const values: JsonObject = { ...up.values };
      const sources: { [a: string]: Source } = { ...(up.sources ?? {}) };
      let moved = false;
      for (const r of derived) {
        const address = r.address as string;
        if (serialize(values[address] ?? "∅") === serialize(r.value as Json)) continue;
        values[address] = r.value as Json;
        sources[address] = { origin: "derived", via: r.rule as string };
        moved = true;
      }
      if (!moved) continue;
      const next = { ...up, values, sources } as Record;
      this.records.set(upId, next);
      this.engine.put(next);
      changed.push(upId);
    }
    return changed;
  }

  /** Work on a journal's draft, so every run the border makes is one logged entry (8.5). */
  useJournal(journal: Journal) {
    this.journal = journal;
    for (const [id, r] of this.records) journal.draft.records.set(id, r);
    for (const [k, v] of this.bindings) journal.draft.bindings.set(k, v);
    this.records = journal.draft.records;
    this.bindings = journal.draft.bindings;
    if (this.access) {
      for (const [k, e] of this.access.edges) journal.draft.edges.set(k, e);
      this.access.edges = journal.draft.edges;
    }
    this.review = journal.draft.review;
  }

  /** Log a run's transaction: what it changed on the draft, the run's own state, and any observations (8.5). */
  private commit(by: JsonObject, log: string, run: JsonObject, more: JsonObject[] = []) {
    this.journal?.commit(by, () => {}, `2026-01-01T00:00:${String(this.runs).padStart(2, "0")}Z`, [{ run: log, ...run }, ...more]);
  }

  /** Step 1 of a run (7.4): the menu is the permission (14.6); `who` only narrows. */
  private permitted(c: Contract, recordId: string, callerId?: string, arrival = false): string | null {
    // A run needs `run` on the record (14.6); an arrival has no record yet, so it needs `run` anywhere by an
    // admin or control edge, or to be an admitted member taking part (14.4), on the parent when it has one.
    const may = (verb: string, target: string): boolean => {
      if (!this.access || !callerId) return true;
      if (!arrival || recordId) return this.access.may(callerId, verb, target, recordId);
      return this.access.mayAnywhere(callerId, verb, target) || (verb === "run" && (audienceOf(c) === "public" || this.access.audienceOf(callerId) !== "public"));
    };
    if (this.access && callerId && !may("run", c.name)) return "permission";
    // The contract's audience (7.2, 14.4): consume opens only what the package opens to consumers.
    if (this.access && callerId && AUDIENCES.indexOf(this.access.audienceOf(callerId)) < AUDIENCES.indexOf(audienceOf(c))) return "permission";
    if (c.who) {
      const caller = callerId ? this.records.get(callerId) : undefined;
      // `caller may edit Deployment`: held by the caller's edges and the menu on this record (14.6).
      const asked = [...c.who.matchAll(/\bcaller may (\w+) (\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
      const held = this.access && callerId ? (verb: string, target: string) => may(verb, target) : undefined;
      const ok = evaluate(parseCondition(c.who), caller ? { ...caller.values } : {}, callerStates(caller, this.roles, held, asked));
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

  /**
   * A send (or form) contract's run with no act between (the memory border, docs/design/runs.md): prepare,
   * then acted, in two entries. A host puts its adapter between `prepare` and `acted` or `failed`.
   */
  run(name: string, recordId: string, callerId?: string): RunResult {
    const p = this.prepare(name, recordId, callerId);
    if (p.started !== true) return p;
    this.acted(String(p.log));
    const { started: _s, ...rest } = p;
    return { ...rest, acted: true };
  }

  /**
   * Steps 1–3 of a send (7.4): permission, needs, map out; then the run is `started`, its idempotency key
   * and the payload's hash logged, the payload itself kept beside the log. A key already started or acted
   * is never sent again (7.5).
   */
  prepare(name: string, recordId: string, callerId?: string, cause?: string): RunResult {
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
    // 4 begins: at most once per contract, record and payload; a started run is not started again.
    const key = `${name}|${recordId}|${sha256(serialize(payload))}`;
    const open = [...this.started].find(([, s]) => s.key === key);
    if (open) return { ...head, started: false, reason: "a run with this payload is already started", run: open[0] };
    if (this.sent.has(key)) return { ...head, acted: false, reason: "the same payload was already sent" };
    this.sent.add(key);
    this.outtake.set(log, payload);
    this.started.set(log, { contract: name, record: recordId, key, attempts: 0, ...(cause ? { cause } : {}) });
    const versions: JsonObject = { ...this.versions, ...(c.parts.version ? { contract: c.parts.version } : {}) };
    this.commit({ contract: name, run: log }, log, { contract: name, record: recordId, key, state: "started", payload: `sha256:${sha256(serialize(payload))}`, ...(Object.keys(versions).length ? { versions } : {}), ...(cause ? { cause } : {}) });
    return { ...head, started: true, payload, key, log, ...(cause ? { cause } : {}) };
  }

  /** The act succeeded: the run is `acted` (docs/design/runs.md). */
  acted(run: string, at?: string): RunResult {
    const s = this.started.get(run);
    if (!s) throw new Error(`no started run ${run}`);
    this.started.delete(run);
    this.commit({ contract: s.contract, run }, run, { contract: s.contract, record: s.record, key: s.key, state: "acted", ...(at ? { at } : {}) });
    return { contract: s.contract, record: s.record, run, acted: true };
  }

  /** How many attempts a contract allows (7.5 `retry: N every D`): one without it. */
  private attemptsAllowed(c: Contract): number {
    const m = (c.parts.retry ?? "").match(/^(\d+)\s+every\s+/);
    return m ? 1 + Number(m[1]) : 1;
  }

  /**
   * The act failed: a `failed` entry with the attempt; after the last attempt the contract allows, a
   * review item `run:<contract>` opens, grouped by contract across records, and the run stays failed.
   */
  failed(run: string, reason: string): RunResult {
    const s = this.started.get(run);
    if (!s) throw new Error(`no started run ${run}`);
    const c = this.contracts.get(s.contract);
    s.attempts += 1;
    const allowed = c ? this.attemptsAllowed(c) : 1;
    const dead = s.attempts >= allowed;
    if (dead) {
      this.started.delete(run);
      this.review.push({ key: `run:${s.contract}`, run, record: s.record, reason, attempts: s.attempts });
    }
    this.commit({ contract: s.contract, run }, run, { contract: s.contract, record: s.record, key: s.key, state: "failed", reason, attempt: s.attempts });
    return { contract: s.contract, record: s.record, run, failed: true, attempt: s.attempts, ...(dead ? { dead: true, review: `run:${s.contract}` } : { retry: allowed - s.attempts }) };
  }

  /**
   * A decision on a dead run (runs.md): `retry` releases its key and starts a new run from the record as it
   * now is; `drop` closes the item. Either is a review write.
   */
  decideRun(run: string, decision: "retry" | "drop", callerId?: string): RunResult {
    const w = this.runOf(run);
    if (!w) throw new Error(`no run ${run}`);
    const item = this.review.find((it) => it.run === run && it.key === `run:${w.contract}` && it.decision === undefined);
    const key = [...this.sent].find((k) => k.startsWith(`${w.contract}|${w.record}|`));
    if (decision === "retry" && key) this.sent.delete(key);
    this.review.push({ ...(item ?? { key: `run:${w.contract}`, run, record: w.record }), decision, ...(decision === "retry" && key ? { releases: key } : {}), ...(callerId ? { by: callerId } : {}) });
    if (decision === "drop") return { contract: w.contract, run, decision };
    return { ...this.prepare(w.contract, w.record, callerId), decision, retried: run };
  }

  /** Run the contract that reverses a run (7.5 `undo`): an ordinary send naming its cause. */
  /** The contract and record of a run this instance or its store knows. */
  runOf(run: string): { contract: string; record: string } | undefined {
    const known = this.runsKnown.get(run);
    if (known) return known;
    for (const x of this.journal?.entries ?? []) {
      const w = Array.isArray(x.writes) ? (x.writes.find((y) => isObj(y) && y.run === run) as JsonObject | undefined) : undefined;
      if (w) return { contract: String(w.contract), record: String(w.record ?? "") };
    }
    return undefined;
  }

  undo(run: string, callerId?: string): RunResult {
    const w = this.runOf(run);
    const contract = w ? this.contracts.get(w.contract) : undefined;
    if (!w || !contract) throw new Error(`no run ${run}`);
    if (!contract.undo) return { contract: contract.name, run, stopped: "undo", reason: `${contract.name} names no undo` };
    return this.prepare(contract.undo, w.record, callerId, run);
  }

  private needsOf(c: Contract): ClassLine[] {
    return c.needs;
  }

  /**
   * Steps 5–6 for a receive contract: map the answer back, compare with the record, and land it. Under a
   * gated edge (14.7) the values land as suggestions for the edge's reviewer, whatever the contract says.
   */
  receiveRun(name: string, recordId: string, body: string, callerId?: string, forRun?: string): RunResult {
    const c = this.contracts.get(name);
    const r = this.records.get(recordId);
    if (!c || !r) throw new Error(`no contract ${name} or record ${recordId}`);
    const head: RunResult = { contract: name, record: recordId, ...(callerId ? { caller: callerId } : {}) };
    // An answer that names a run the store doesn't know is never guessed onto a record (docs/design/runs.md).
    if (forRun !== undefined) {
      const known = this.runOf(forRun)?.contract === name;
      if (!known) {
        this.review.push({ key: `run:${name}`, run: forRun, record: recordId, reason: "an answer named a run the store doesn't know" });
        const l = this.nextLog();
        this.commit({ contract: name, run: l }, l, { contract: name, record: recordId, state: "closed", answerFor: forRun });
        return { ...head, stopped: "run", reason: `no run ${forRun}`, log: l };
      }
    }
    const stopped = this.permitted(c, recordId, callerId);
    if (stopped) return { ...head, stopped };
    const log = forRun ?? this.nextLog();
    const intake = receive(c, body, recordId, this.dict, `I-${log.slice(2)}`);
    const outcomes: IntakeOutcome[] = intake.outcomes.map((o) => {
      if (o.outcome !== "absorbed" || !o.to) return o;
      // A value a must rule won't have is a contradiction citing the rule (9.3): parked, never landed.
      const broken = this.engine.probe({ ...r, values: { [o.to]: o.value as Json } });
      if (broken) return { ...o, outcome: "contradiction", cites: { rule: broken.rule ?? "" } };
      const current = r.values[o.to];
      if (current === undefined || (isObj(current) && "$empty" in current)) return o;
      if (serialize(current) === serialize(o.value as Json)) return o;
      // A state facet moves (4.2, 9.3): a later value of equal or higher trust is absorbed, not disputed.
      // Equal trust is the common case here (a form of the same origin); the landing decides the rest.
      if (this.dict.facets.get(o.to)?.transitions && (c.origin === "declared" || callerId)) return o;
      return { ...o, outcome: "conflict" };
    });
    const source: Source = { origin: c.origin, via: log };
    const gate = this.gate(recordId, callerId);
    let summary: JsonObject = {};
    if (c.lands === "observation") {
      // Evidence (9.7): each reading is an observation on this instance, supporting the record that stores
      // the value; the first observation fills an empty value with origin observed.
      const docs: JsonObject[] = [];
      let filled: Record | undefined;
      for (const o of outcomes) {
        if (!o.to || o.value === undefined || !["absorbed", "conflict", "new"].includes(o.outcome)) continue;
        const up = r.of ? this.records.get(r.of) : undefined;
        const supports = up && r.values[o.to] === undefined && (up.values[o.to] !== undefined || !this.dict.vary.get(r.level)?.has(o.to)) ? up.id : r.id;
        const doc: JsonObject = { obs: `O-${++this.observed}`, on: recordId, address: o.to, value: o.value, "evidence-type": c.parts.evidence ?? "reading", reading: intake.intake, supports };
        docs.push(doc);
        const target = filled ?? (supports === r.id ? r : (up as Record));
        const cur = target.values[o.to];
        if (cur === undefined || (isObj(cur) && "$empty" in cur)) {
          filled = { ...target, values: { ...target.values, [o.to]: o.value }, sources: { ...(target.sources ?? {}), [o.to]: { origin: "observed", via: log } } };
        }
      }
      this.observed = Math.max(this.observed, ...this.observations.map((o) => Number(String(o.obs).replace(/^O-/, "")) || 0));
      for (const d of docs) d.obs = `O-${++this.observed}`;
      this.observations.push(...docs);
      if (filled) this.put(filled);
      // The version split proposed (9.7.3): at the threshold, a review item names the instances that agree.
      const proposed: JsonObject[] = [];
      const supported = [...new Set(docs.map((d) => String(d.supports)))].flatMap((id) => { const rec = this.records.get(id); return rec ? [rec] : []; });
      for (const item of proposeSplit(supported, this.observations as Observation[], this.thresholds.split ?? 3)) {
        const same = (it: JsonObject) => it.key === item.key && it.address === item.address && serialize(it.value as Json) === serialize(item.value as Json) && it.decision === undefined;
        if (!this.review.some(same) && !this.knownReview.some(same)) {
          this.review.push(item);
          proposed.push(item);
        }
      }
      this.commit({ contract: name, run: log }, log, { contract: name, record: recordId, state: "closed" }, docs.map((d) => ({ observation: d })));
      return { ...head, outcomes: outcomes as unknown as Json, log, landed: "observation", observations: docs, ...(filled ? { filled: filled.id } : {}), ...(proposed.length ? { proposed } : {}) };
    }
    if (c.lands === "suggestion" || gate) this.put(suggest(r, outcomes, source));
    else {
      // A form run by a caller is a person's write (11.3): it ranks as `person`, ahead of what a contract or an earlier declaration left.
      const landed = land(r, { outcomes, contract: name, ...(c.kind === "form" && callerId ? { person: true } : {}) }, source, this.dict.trust, this.dict.facetTrust, new Set([...this.dict.facets.values()].filter((f) => f.transitions).map((f) => f.key)), this.dict);
      // 6. Rules, over what this run changed.
      const touched: JsonObject = {};
      for (const [k, v] of Object.entries(landed.values)) if (serialize(r.values[k] ?? "∅") !== serialize(v)) touched[k] = v;
      const ruled = this.applyRules(landed, touched);
      if ("refused" in ruled) return { ...head, stopped: "rule", rule: ruled.refused.rule ?? "", address: ruled.refused.address ?? "", log };
      this.put(ruled.record);
      summary = ruled.summary;
    }
    // A form run by a caller is that person's entry (8.5), as an arrival's is; the run write still names the contract.
    this.commit(callerId && c.kind === "form" ? { person: callerId } : { contract: name, run: log }, log, { contract: name, record: recordId, state: "closed" });
    return { ...head, outcomes: outcomes as unknown as Json, sources: { origin: c.origin }, log, landed: gate || c.lands === "suggestion" ? "suggestion" : "value", ...(gate ? { gated: gate.edge, reviewer: gate.reviewer ?? gate.by } : {}), ...(Object.keys(summary).length ? { rules: summary } : {}) };
  }

  /**
   * An arrival through a contract (9.2a): the payload finds or makes its record; a new record made for a
   * caller gets their consumer edge (14.4).
   */
  arriveRun(name: string, body: string, level: string, callerId?: string, of?: string, within?: string): RunResult {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const log = this.nextLog();
    const domain = this.owner ?? this.access?.owner ?? this.journal?.owner ?? this.records.all()[0]?.owner ?? "";
    // A person owns what the package lets a person own (14.1): the record is theirs, written as `domain:id`.
    const kind = this.dict.levels.get(level) ?? level;
    // Permitted on the record the new one sits under or within (14.2), else anywhere (7.4 step 1).
    const refused = this.permitted(c, of ?? within ?? "", callerId, true);
    if (refused) return { contract: name, ...(callerId ? { caller: callerId } : {}), stopped: refused, log };
    const person = callerId && !callerId.includes(":") && (this.access?.perms.ownership.get("person") ?? []).includes(kind);
    const owner = person ? `${domain}:${callerId}` : domain;
    // A refusal by the rules puts everything back: the arrival never happened.
    const prevRecords = new Map(this.records);
    const prevBindings = new Map(this.bindings);
    const { arrival, record } = arrive(c, body, level, this, this.dict, { mint: () => (this.mint ? this.mint(level) : `${level.charAt(0).toUpperCase()}-NEW${++this.minted}`), owner, ...(of ? { of } : {}), ...(within ? { within } : {}), intakeId: `I-${log.slice(2)}` });
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
   * only to a party holding `run` for the contract. With `o.limit`, at most that many entries per view, and
   * `more: true` when a view had that many (the scale rule: a run never reads a catalog whole; the index
   * acknowledges each page and asks again).
   */
  streamRun(name: string, callerId?: string, cursor?: { [view: string]: number }, o?: { limit?: number }): RunResult {
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
    let more = false;
    for (const v of c.stream) {
      this.views.stream(v);
      const version = this.views.versionOf(v);
      const held = stored[v];
      const since = cursor?.[v] ?? (held && held.version === version ? held.seq : 0);
      const list: StreamEntry[] = this.views.entriesSince(v, since, undefined, o?.limit);
      entries[v] = list as unknown as Json;
      out[v] = list.at(-1)?.seq ?? since;
      if (list.length) batches.push(`${name}|${v}|${version}|${list[0]?.seq}-${list.at(-1)?.seq}`);
      if (o?.limit && list.length >= o.limit) more = true;
    }
    return { ...head, entries, cursor: out, ...(batches.length ? { key: batches.join(" ") } : {}), ...(more ? { more: true } : {}), log };
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
      const targets = c.parts.for ? this.records.forTarget(c.parts.for).map((r) => r.id) : [];
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

  /** The classes a record wears, those of the records above it included (5.5). */
  private wearsOf(r: Record): string[] {
    const up = r.of ? this.records.get(r.of) : undefined;
    return [...(up ? this.wearsOf(up) : []), ...(r.wears ?? [])];
  }

  /**
   * An offer (7.8): the records the contract's `for` selects, with only the facets it gives, each value with
   * its source; the mode and terms ride along. A value the owner took under `reshare: no` never flows on.
   * Who may see it is the host's decision from `to`.
   */
  offer(name: string, owner: string, only?: string[]): Offer {
    const c = this.contracts.get(name);
    if (!c || c.kind !== "offer") throw new Error(`no offer ${name}`);
    const wears = c.parts.for;
    // What the contract is `for` is asked for by target, never the whole catalog (brief 18, the scale rule).
    const pool = only ? only.flatMap((id) => this.records.get(id) ?? []) : wears ? this.records.forTarget(wears) : this.records.all();
    const records: Record[] = [];
    for (const r of pool) {
      if (r.status?.state === "archived") continue;
      if (wears && !this.wearsOf(r).includes(wears)) continue;
      const values: JsonObject = {};
      const sources: { [a: string]: Source } = {};
      for (const key of c.gives) {
        const v = r.values[key];
        if (v === undefined || (isObj(v) && "$empty" in v)) continue;
        const s = r.sources?.[key] ?? r.sources?.["*"];
        if (s?.reshare === false) continue;
        values[key] = v;
        if (s) sources[key] = { origin: s.origin, via: s.via, ...(s.owner ? { owner: s.owner } : {}) };
      }
      if (!Object.keys(values).length) continue;
      records.push({ id: r.id, kind: r.kind, level: r.level, owner: r.owner, values, sources, ...(r.of ? { of: r.of } : {}) });
    }
    return { contract: name, owner, to: c.to ?? "private", mode: c.mode ?? "gathered", terms: { ...c.terms }, gives: [...c.gives], records };
  }

  /**
   * Offer and take (7.8): only what the offer gives and the take reads flows, by the offer's mode.
   * `dump` copies once and never updates; `observed` stores a link and no value; `gathered` copies and
   * takes the presenter's updates as intake, never over a value the consumer entered; `controlled` copies
   * under the presenter's terms, which do override, expire and withdraw. The entry names the presenter's
   * entry the values came from (8.5.1).
   */
  take(takeName: string, offer: string | Offer, recordId: string, presenter: Record): RunResult {
    const t = this.contracts.get(takeName);
    const o: Offer | undefined = typeof offer === "string" ? this.localOffer(offer) : offer;
    const r = this.records.get(recordId);
    if (!t || !o || !r) throw new Error("a take needs its take contract, the offer and the record");
    if (t.from && t.from !== presenter.owner) return { contract: takeName, record: recordId, stopped: "from" };
    const mode = o.mode;
    if (t.mode && t.mode !== mode) return { contract: takeName, record: recordId, stopped: "mode", offered: mode };
    const log = this.nextLog();
    const values: JsonObject = { ...r.values };
    const sources: { [a: string]: Source } = { ...(r.sources ?? {}) };
    const alternatives: { [a: string]: JsonObject[] } = { ...((r as unknown as { alternatives?: { [a: string]: JsonObject[] } }).alternatives ?? {}) };
    const flows: string[] = [];
    let from: string | undefined;
    const fromPresenter = (a: string) => sources[a]?.owner === presenter.owner;
    if (mode === "observed") {
      // A read-through is never stored (7.8): the record links to the presenter's, naming what it reads.
      for (const m of t.reads) if (o.gives.includes(m.from) && presenter.values[m.from] !== undefined) flows.push(m.from);
      values["crubal:observes"] = { $link: `${presenter.owner}/${presenter.id}` };
      sources["crubal:observes"] = { origin: "reported", via: log, owner: presenter.owner };
      this.put({ ...r, values, sources });
      this.commit({ take: takeName, from: presenter.owner }, log, { contract: takeName, record: recordId, state: "closed" });
      return { contract: takeName, record: recordId, mode, observes: flows, log };
    }
    for (const m of t.reads) {
      const theirs = m.from;
      if (!o.gives.includes(theirs)) continue; // not offered: doesn't flow
      const v = presenter.values[theirs];
      if (v === undefined) continue;
      const theirSource = presenter.sources?.[theirs] ?? presenter.sources?.["*"];
      from ??= theirSource?.via ? `${presenter.owner}/${theirSource.via}` : presenter.owner;
      const src: Source = { origin: theirSource?.origin ?? "reported", via: log, owner: presenter.owner };
      if (mode === "controlled") {
        if (o.terms.expires) src.until = o.terms.expires;
        if (o.terms.reshare === "no") src.reshare = false;
        if (o.terms.revocable === "yes") src.revocable = true;
      }
      const current = values[m.to];
      const empty = current === undefined || (isObj(current) && "$empty" in current);
      if (empty) {
        values[m.to] = v;
        sources[m.to] = src;
        flows.push(theirs);
      } else if (serialize(current) === serialize(v)) {
        if (mode !== "dump" && fromPresenter(m.to)) sources[m.to] = { ...sources[m.to], ...src, via: sources[m.to]?.via ?? log } as Source;
      } else if (mode === "dump") {
        // Copied once, never updated.
      } else if (mode === "controlled" || fromPresenter(m.to)) {
        // The presenter's update: under controlled terms it wins; gathered, it replaces only its own earlier value.
        values[m.to] = v;
        sources[m.to] = src;
        flows.push(theirs);
      } else {
        // A presenter never overrides a value a person entered on the consumer's side.
        alternatives[m.to] = [...(alternatives[m.to] ?? []), { value: v, origin: src.origin, via: log, owner: presenter.owner }];
      }
    }
    // Withdrawal under revocable terms: a value this presenter gave and no longer offers or holds is removed.
    const withdrawn: string[] = [];
    for (const [a, s] of Object.entries(sources)) {
      if (!fromPresenter(a) || !s.revocable) continue;
      const line = t.reads.find((m) => m.to === a);
      const still = line && o.gives.includes(line.from) && presenter.values[line.from] !== undefined;
      if (still) continue;
      delete values[a];
      delete sources[a];
      withdrawn.push(a);
    }
    const next = { ...r, values, sources, ...(Object.keys(alternatives).length ? { alternatives } : {}) } as Record;
    this.put(next);
    this.commit({ take: takeName, from: from ?? presenter.owner }, log, { contract: takeName, record: recordId, state: "closed" });
    return { contract: takeName, record: recordId, mode, flows, ...(withdrawn.length ? { withdrawn } : {}), log };
  }

  /** A local offer contract as an offer object, for a take run against a presenter record at hand. */
  private localOffer(name: string): Offer | undefined {
    const o = this.contracts.get(name);
    return o ? { contract: name, owner: "", to: o.to ?? "private", mode: o.mode ?? "gathered", terms: { ...o.terms }, gives: [...o.gives], records: [] } : undefined;
  }

  /** Taken values past their terms' `expires` (7.8) are removed, each record one entry; the ids changed. */
  expire(now: string): string[] {
    const out: string[] = [];
    for (const r of this.records.all()) {
      const gone = Object.entries(r.sources ?? {}).filter(([, s]) => typeof s.until === "string" && s.until <= now).map(([a]) => a);
      if (!gone.length) continue;
      const values = { ...r.values };
      const sources = { ...(r.sources ?? {}) };
      for (const a of gone) { delete values[a]; delete sources[a]; }
      this.put({ ...r, values, sources });
      const log = this.nextLog();
      this.commit({ take: "expired", at: now }, log, { contract: "expired", record: r.id, state: "closed" });
      out.push(r.id);
    }
    return out;
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

/** An offer as one owner's host serves it to another (7.8): the border wrapper's content. */
export type Offer = { contract: string; owner: string; to: string; mode: string; terms: { [term: string]: string }; gives: string[]; records: Record[]; log?: JsonObject[]; /** The package version the records were written under (3.8, 10.1): `<owner>/<name> /<version>`. */ package?: string };

/**
 * The version gate at a border (10.1): what a receiver does with data written under another version of a
 * package it holds. Newer than ours: hold until we upgrade. Older: restamp through the recipes between.
 * The same, or a package we don't hold, or no version on the wire: take as is.
 */
export function versionGate(theirs: string | undefined, installed: { package: string; version: string }[]): { kind: "take" } | { kind: "hold"; package: string; theirs: string; ours: string } | { kind: "restamp"; package: string; theirs: string; ours: string } {
  if (!theirs) return { kind: "take" };
  const at = theirs.lastIndexOf(" /");
  if (at < 0) return { kind: "take" };
  const pkg = theirs.slice(0, at).trim();
  const version = theirs.slice(at + 2).trim();
  const ours = installed.filter((i) => i.package === pkg).map((i) => i.version).sort().at(-1);
  if (!ours) return { kind: "take" };
  if (version > ours) return { kind: "hold", package: pkg, theirs: version, ours };
  if (version < ours) return { kind: "restamp", package: pkg, theirs: version, ours };
  return { kind: "take" };
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
