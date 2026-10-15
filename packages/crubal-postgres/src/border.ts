// border.ts: the border (spec chapter 7) running over the store. Every run is one entry: the engine's
// Exchange is built over the commit's draft, runs, and what it changed plus its run write become the entry.
// Intake records keep their bytes in the intake table (9.1); idempotency keys and run counts live in the
// runs table, so a run never acts twice across restarts (7.5); stream contracts read the projection stream
// and keep an index's cursor (12.6.2); scheduled contracts tick from the schedules table (7.11).

import { Access, type Edge, type Permissions } from "../../crubal/src/access.ts";
import type { Dictionary } from "../../crubal/src/defs.ts";
import { Exchange, type Role, type RunResult } from "../../crubal/src/exchange.ts";
import type { Draft, Journal } from "../../crubal/src/log.ts";
import type { Json, JsonObject } from "../../crubal/src/model.ts";
import { MemoryRecords } from "../../crubal/src/records.ts";
import type { Rule } from "../../crubal/src/rules.ts";
import { isSchedule, readSchedule, ticksDue } from "../../crubal/src/schedule.ts";
import { type Contract, receive } from "../../crubal/src/store.ts";
import type { StreamEntry } from "../../crubal/src/views.ts";
import type { PgStore } from "./store.ts";

export type BorderOptions = { dict: Dictionary; contracts: Contract[]; roles?: Role[]; rules?: Rule[]; perms?: Permissions };

type Row = { [column: string]: unknown };

export class PgBorder {
  readonly store: PgStore;
  readonly o: BorderOptions;
  readonly contracts: Map<string, Contract>;

  constructor(store: PgStore, o: BorderOptions) {
    this.store = store;
    this.o = o;
    this.contracts = new Map(o.contracts.map((c) => [c.name, c]));
  }

  private get owner() {
    return this.store.owner;
  }

  /** Runs so far and the keys acted on, from the runs table, so a fresh Exchange continues where the last left off. */
  private async past(): Promise<{ runs: number; sent: Set<string> }> {
    const { rows } = await this.store.pool.query("select json from runs where owner = $1", [this.owner]);
    const sent = new Set<string>();
    for (const r of rows as Row[]) {
      const j = r.json as JsonObject;
      if (typeof j.key === "string" && (j.state === "acted" || j.state === "closed")) sent.add(j.key);
    }
    return { runs: rows.length, sent };
  }

  /**
   * One border run as one entry: the Exchange is built over the draft, with the store's edges, runs and
   * keys; `fn` runs it; its changes and its run write become the entry. The function MUST be pure over the
   * draft (it may run more than once while the working set loads).
   */
  async run<T extends RunResult>(fn: (ex: Exchange) => T, at?: string): Promise<T> {
    const { runs, sent } = await this.past();
    const { out } = await this.store.commitFrom((draft: Draft) => {
      const ex = new Exchange(this.o.dict, this.o.contracts, this.o.roles ?? [], this.o.rules ?? []);
      ex.records = draft.records;
      ex.bindings = draft.bindings;
      ex.runs = runs;
      for (const k of sent) ex.sent.add(k);
      if (this.o.perms) {
        ex.access = new Access(this.o.dict, this.o.perms, draft.records, [...draft.edges.values()] as unknown as Edge[], this.owner);
        ex.access.edges = draft.edges as unknown as Map<string, Edge>;
      }
      // The rules engine knows every record the working set holds, as the memory border's does.
      for (const [, r] of Map.prototype.entries.call(draft.records) as Iterable<[string, import("../../crubal/src/model.ts").Record]>) ex.engine.put(r);
      let captured: { by: JsonObject; extra: JsonObject[] } = { by: { contract: "" }, extra: [] };
      ex.journal = { commit: (by: JsonObject, _m: unknown, _at: unknown, extra: JsonObject[] = []) => { captured = { by, extra }; return null; } } as unknown as Journal;
      const result = fn(ex);
      return { by: captured.by, extra: captured.extra, out: result };
    }, at);
    return out;
  }

  /** Keep an intake record with its bytes (9.1), beside the log. */
  private async keepIntake(c: Contract, body: string, forRecord: string, log: string, at?: string): Promise<void> {
    const intake = receive(c, body, forRecord, this.o.dict, `I-${log.slice(2)}`);
    const raw = intake.raw;
    const bytes = Buffer.from(raw.body, "utf8");
    await this.store.pool.query(
      `insert into intake (owner, intake, contract, received, "for", raw, sha256, type, json) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (owner, intake) do nothing`,
      [this.owner, intake.intake, c.name, at ?? null, forRecord || null, bytes, raw.sha256, raw.type, { ...intake, raw: { type: raw.type, sha256: raw.sha256 } }],
    );
  }

  /** A receive contract's run on a record (7.4 steps 5–6), its intake kept. */
  async receive(name: string, recordId: string, body: string, callerId?: string, at?: string): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const r = await this.run((ex) => ex.receiveRun(name, recordId, body, callerId), at);
    if (typeof r.log === "string") await this.keepIntake(c, body, recordId, r.log, at);
    return r;
  }

  /** An arrival (9.2a): the payload finds or makes its record; its intake kept. */
  async arrive(name: string, body: string, level: string, callerId?: string, of?: string, at?: string): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const r = await this.run((ex) => ex.arriveRun(name, body, level, callerId, of), at);
    const record = (r.arrival as JsonObject | undefined)?.record;
    if (typeof r.log === "string") await this.keepIntake(c, body, typeof record === "string" ? record : "", r.log, at);
    return r;
  }

  /** A send or form contract's run (7.4 steps 1–4): acts at most once per contract, record and payload. */
  async send(name: string, recordId: string, callerId?: string, at?: string): Promise<RunResult> {
    return this.run((ex) => ex.run(name, recordId, callerId), at);
  }

  /** The stored cursor of a stream contract for a view, when it is for the view's current version. */
  private async cursorOf(contract: string, view: string, version: string, audience: string): Promise<number | undefined> {
    const { rows } = await this.store.pool.query("select seq from cursors where owner = $1 and contract = $2 and view = $3 and version = $4 and audience = $5", [this.owner, contract, view, version, audience]);
    return rows.length ? Number((rows[0] as Row).seq) : undefined;
  }

  /**
   * A stream contract's run (12.6.2): the entries of each view since the cursor, pushed (the stored
   * cursor) or pulled (the caller's). A view above public goes only to a party holding `run` for the
   * contract. A batch with entries is logged as a run keyed by the contract, the views and the ranges.
   */
  async streamRun(name: string, callerId?: string, cursor?: { [view: string]: number }, at?: string): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    if (!c.stream.length) throw new Error(`${name} carries no stream`);
    const p = this.store.options.projecting;
    if (!p) throw new Error("the store has no views to stream from");
    const party = callerId ?? c.parts.to ?? "";
    const head: RunResult = { contract: name, caller: party };
    for (const v of c.stream) {
      const view = p.views.views.get(v);
      if (view && view.show !== "public") {
        const edges = (await this.store.pool.query("select json from edges where owner = $1", [this.owner])).rows.map((r: Row) => r.json as unknown as Edge);
        const access = this.o.perms ? new Access(this.o.dict, this.o.perms, new MemoryRecords(), edges, this.owner) : undefined;
        if (!access?.mayAnywhere(party, "run", name)) return { ...head, stopped: "permission", view: v };
      }
    }
    const entries: JsonObject = {};
    const out: JsonObject = {};
    const batches: string[] = [];
    for (const v of c.stream) {
      const view = p.views.views.get(v);
      if (!view) throw new Error(`no view ${v}`);
      const version = view.version ?? "";
      const since = cursor?.[v] ?? (await this.cursorOf(name, v, version, view.show)) ?? 0;
      const list: StreamEntry[] = await this.store.entriesSince(v, since);
      entries[v] = list as unknown as Json;
      out[v] = list.at(-1)?.seq ?? since;
      if (list.length) batches.push(`${name}|${v}|${version}|${list[0]?.seq}-${list.at(-1)?.seq}`);
    }
    if (!batches.length) return { ...head, entries, cursor: out };
    const { runs } = await this.past();
    const log = `L-R${runs + 1}`;
    await this.store.commitFrom(() => ({ by: { contract: name, run: log }, extra: [{ run: log, contract: name, key: batches.join(" "), state: "acted" }], out: null }), at);
    return { ...head, entries, cursor: out, key: batches.join(" "), log };
  }

  /** An index acknowledges the last `seq` it holds per view (12.6.2); the store resumes from the next. */
  async ack(name: string, cursor: { [view: string]: number }): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const p = this.store.options.projecting;
    if (!p) throw new Error("the store has no views");
    for (const [v, seq] of Object.entries(cursor)) {
      const view = p.views.views.get(v);
      if (!view) continue;
      await this.store.pool.query(
        "insert into cursors (owner, contract, view, version, audience, seq) values ($1, $2, $3, $4, $5, $6) on conflict (owner, contract, view, version, audience) do update set seq = excluded.seq",
        [this.owner, name, v, view.version ?? "", view.show, seq],
      );
    }
    return { contract: name, cursor };
  }

  /**
   * A scheduled contract's tick (7.11): every tick due since the last one runs (or the latest, or none,
   * by `missed`), each keyed by the contract and the tick so a restarted host never runs one twice. The
   * schedule begins at the first clock reading.
   */
  async tick(name: string, now: string, callerId?: string): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    if (!isSchedule(c.when)) throw new Error(`${name} isn't scheduled`);
    const sch = readSchedule(c.when as string);
    const { rows } = await this.store.pool.query("select last_tick from schedules where owner = $1 and contract = $2", [this.owner, name]);
    if (!rows.length) {
      await this.store.pool.query("insert into schedules (owner, contract, last_tick) values ($1, $2, $3)", [this.owner, name, now]);
      return { contract: name, now, ticks: [], runs: [], began: now };
    }
    const last = String((rows[0] as Row).last_tick);
    const due = ticksDue(sch, last, now);
    const missed = c.parts.missed ?? "once";
    const run = missed === "all" ? due : missed === "once" ? due.slice(-1) : [];
    const skipped = due.filter((t) => !run.includes(t));
    const results: Json[] = [];
    for (const tick of run) {
      const key = `${name}|${tick}`;
      const { sent } = await this.past();
      if (sent.has(key)) continue;
      if (c.stream.length) {
        results.push({ tick, ...(await this.streamRun(name, callerId, undefined, now)) } as Json);
      } else {
        const targets = c.parts.for ? (await this.store.pool.query("select id from records where owner = $1 and ($2 = any(wears) or level = $2 or kind = $2) order by ord", [this.owner, c.parts.for])).rows.map((r: Row) => String(r.id)) : [];
        for (const id of targets) results.push({ tick, ...(await this.send(name, id, callerId, now)) } as Json);
      }
      // The tick itself is a run, keyed so it never runs twice (7.11).
      const { runs } = await this.past();
      const log = `L-R${runs + 1}`;
      await this.store.commitFrom(() => ({ by: { contract: name, run: log }, extra: [{ run: log, contract: name, tick, key, state: "acted" }], out: null }), now);
      results.push({ tick, log, acted: true });
    }
    await this.store.pool.query("update schedules set last_tick = $3 where owner = $1 and contract = $2", [this.owner, name, now]);
    return { contract: name, now, ticks: due, runs: results, ...(skipped.length ? { skipped } : {}) };
  }
}
