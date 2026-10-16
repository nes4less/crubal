// border.ts: the border (spec chapter 7) running over the store. Every run is one entry: the engine's
// Exchange is built over the commit's draft, runs, and what it changed plus its run write become the entry.
// Intake records keep their bytes in the intake table (9.1); idempotency keys and run counts live in the
// runs table, so a run never acts twice across restarts (7.5); stream contracts read the projection stream
// and keep an index's cursor (12.6.2); scheduled contracts tick from the schedules table (7.11).

import { Access, type Edge, type Permissions } from "../../crubal/src/access.ts";
import type { Dictionary } from "../../crubal/src/defs.ts";
import { Exchange, type Role, type RunResult } from "../../crubal/src/exchange.ts";
import type { Draft, Journal } from "../../crubal/src/log.ts";
import type { Json, JsonObject, Record } from "../../crubal/src/model.ts";
import { MemoryRecords } from "../../crubal/src/records.ts";
import type { Rule } from "../../crubal/src/rules.ts";
import { isSchedule, readSchedule, ticksDue } from "../../crubal/src/schedule.ts";
import { openItems } from "../../crubal/src/review.ts";
import { type Contract, receive } from "../../crubal/src/store.ts";
import type { Offer } from "../../crubal/src/exchange.ts";
import type { StreamEntry } from "../../crubal/src/views.ts";
import type { PgStore } from "./store.ts";

/** What performs a run's act (7.4 step 4): the host's code for a system; never a package's. */
export type Adapter = (contract: Contract, payload: JsonObject, run: string) => Promise<{ acted: true; body?: string } | { failed: string }>;

export type BorderOptions = { dict: Dictionary; contracts: Contract[]; roles?: Role[]; rules?: Rule[]; perms?: Permissions; adapters?: { [contract: string]: Adapter }; versions?: JsonObject; thresholds?: { confirm?: number; split?: number } };

/** The border's options from the store's own definitions (docs/design/publishing.md). */
export async function borderOptions(store: PgStore): Promise<BorderOptions> {
  const p = await store.definitions();
  const thresholds: { confirm?: number; split?: number } = {};
  for (const k of ["confirm", "split"] as const) if (p.info.header[k]) thresholds[k] = Number(p.info.header[k]);
  return { dict: p.dict, contracts: p.contracts, rules: p.rules, perms: p.perms, thresholds, ...(p.info.version ? { versions: { package: `${p.info.name} /${p.info.version}` } } : {}) };
}

type Row = { [column: string]: unknown };

/**
 * A system acting for a person (14.9): the run's caller is the person, whose access is capped to the items
 * they chose and gated until they lifted it; the entry names the system as `caller` and the person as
 * `for`; a write that grants onward, or runs under an emergency edge, is refused.
 */
export type Acting = { system: string; person: string; items?: string[]; gated?: boolean };

export class PgBorder {
  readonly store: PgStore;
  readonly o: BorderOptions;
  readonly contracts: Map<string, Contract>;
  /** Set for one request when a system acts for a person (14.9); every run of this border then runs as the person. */
  acting?: Acting;

  constructor(store: PgStore, o: BorderOptions) {
    this.store = store;
    this.o = o;
    this.contracts = new Map(o.contracts.map((c) => [c.name, c]));
  }

  /** The person's access, narrowed as they chose (14.9), laid over the owner's access for this run. */
  private cap(access: Access, acting: Acting): void {
    const { person, items, gated } = acting;
    const effective = access.effective.bind(access);
    access.effective = (callerId: string, recordId: string) => {
      const e = effective(callerId, recordId);
      if (callerId !== person) return e;
      if (items?.length) e.items = new Set([...e.items].filter((i) => items.includes(i)));
      if (gated && e.mode !== "none") e.gated = true;
      return e;
    };
    if (gated) {
      const was = access.gated.bind(access);
      access.gated = (callerId: string, recordId: string) => (callerId === person ? { edge: "acting-for", who: acting.system, relation: "agent", mode: "control", on: recordId, grants: [], by: person, gate: "review", reviewer: person, line: 0 } : was(callerId, recordId));
    }
  }

  /** Refuse what a system acting for a person may never do (14.9, 14.12 items 8 and 9). */
  private refuseActing(acting: Acting, recordId: string | undefined, access: Access | undefined, edgesBefore: Set<string>, edgesAfter: Map<string, unknown>): void {
    if (recordId && access) {
      const eff = access.effective(acting.person, recordId);
      if (eff.edges.some((e) => e.relation === "emergency" || e.by === "platform")) throw Object.assign(new Error(`${acting.system} may not act for ${acting.person} under an emergency edge`), { status: 403 });
    }
    for (const [k, e] of edgesAfter) {
      if (edgesBefore.has(k)) continue;
      const who = (e as { who?: string }).who;
      if (who !== acting.person) throw Object.assign(new Error(`${acting.system} acting for ${acting.person} may not grant onward (${k})`), { status: 403 });
    }
  }

  /** A border over a store's own definitions. */
  static async over(store: PgStore): Promise<PgBorder> {
    return new PgBorder(store, await borderOptions(store));
  }

  private get owner() {
    return this.store.owner;
  }

  /** Runs so far and the keys acted on, from the runs table, so a fresh Exchange continues where the last left off. */
  private async past(): Promise<{ runs: number; sent: Set<string>; known: Map<string, { contract: string; record: string }>; open: Map<string, { contract: string; record: string; key: string; attempts: number }> }> {
    const { rows } = await this.store.pool.query("select run, json from runs where owner = $1", [this.owner]);
    const sent = new Set<string>();
    const known = new Map<string, { contract: string; record: string }>();
    const open = new Map<string, { contract: string; record: string; key: string; attempts: number }>();
    // A retry decision releases a dead run's key (runs.md), so the same payload may go again.
    const released = new Set((await this.store.pool.query("select json->>'releases' as k from review where owner = $1 and json->>'decision' = 'retry' and json ? 'releases'", [this.owner])).rows.map((x: Row) => String(x.k)));
    for (const r of rows as Row[]) {
      const j = r.json as JsonObject;
      const run = String(r.run);
      known.set(run, { contract: String(j.contract), record: String(j.record ?? "") });
      if (typeof j.key !== "string") continue;
      if (released.has(j.key) && j.state === "failed") continue;
      if (j.state === "acted" || j.state === "closed" || j.state === "started" || j.state === "failed") sent.add(j.key);
      // A run still open: started, or failed with attempts left (docs/design/runs.md).
      const c = this.contracts.get(String(j.contract));
      const allowed = c ? 1 + Number((c.parts.retry ?? "").match(/^(\d+)\s+every\s+/)?.[1] ?? 0) : 1;
      const attempts = Number(j.attempt ?? 0);
      if (j.state === "started" || (j.state === "failed" && attempts < allowed)) open.set(run, { contract: String(j.contract), record: String(j.record ?? ""), key: j.key, attempts });
    }
    return { runs: rows.length, sent, known, open };
  }

  /**
   * One border run as one entry: the Exchange is built over the draft, with the store's edges, runs and
   * keys; `fn` runs it; its changes and its run write become the entry. The function MUST be pure over the
   * draft (it may run more than once while the working set loads).
   */
  async run<T extends RunResult>(fn: (ex: Exchange) => T, at?: string, seed: { observations?: JsonObject[]; review?: JsonObject[] } = {}): Promise<T> {
    const { runs, sent, known, open } = await this.past();
    const { out } = await this.store.commitFrom((draft: Draft) => {
      const ex = new Exchange(this.o.dict, this.o.contracts, this.o.roles ?? [], this.o.rules ?? []);
      ex.records = draft.records;
      ex.bindings = draft.bindings;
      ex.review = draft.review;
      // The observations and open items this run reads, loaded apart from the draft: the entry's own
      // observation and review writes are what the store keeps.
      ex.observations = [...(seed.observations ?? [])];
      ex.knownReview = seed.review ?? [];
      if (this.o.thresholds) ex.thresholds = this.o.thresholds;
      if (this.o.versions) ex.versions = this.o.versions;
      ex.runs = runs;
      for (const k of sent) ex.sent.add(k);
      for (const [k, v] of known) ex.runsKnown.set(k, v);
      // A copy each run: the operation may run more than once while the working set loads (working.ts).
      for (const [k, v] of open) ex.started.set(k, { ...v });
      if (this.o.perms) {
        ex.access = new Access(this.o.dict, this.o.perms, draft.records, [...draft.edges.values()] as unknown as Edge[], this.owner);
        ex.access.edges = draft.edges as unknown as Map<string, Edge>;
        if (this.acting) this.cap(ex.access, this.acting);
      }
      // The rules engine knows every record the working set holds, as the memory border's does.
      for (const [, r] of Map.prototype.entries.call(draft.records) as Iterable<[string, import("../../crubal/src/model.ts").Record]>) ex.engine.put(r);
      let captured: { by: JsonObject; extra: JsonObject[] } = { by: { contract: "" }, extra: [] };
      ex.journal = { commit: (by: JsonObject, _m: unknown, _at: unknown, extra: JsonObject[] = []) => { captured = { by, extra }; return null; } } as unknown as Journal;
      const edgesBefore = new Set(draft.edges.keys());
      const result = fn(ex);
      if (this.acting) {
        const recordId = typeof result.record === "string" ? result.record : undefined;
        this.refuseActing(this.acting, recordId, ex.access, edgesBefore, draft.edges);
        // Every write names both (14.9): the system that acted and the person it acted for.
        captured.by = { ...captured.by, caller: this.acting.system, for: this.acting.person };
      }
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

  /** A receive contract's run on a record (7.4 steps 5–6), its intake kept; with `forRun`, a late answer closing that run. */
  async receive(name: string, recordId: string, body: string, callerId?: string, at?: string, forRun?: string): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const seed = c.lands === "observation" ? await this.evidenceFor(recordId) : {};
    const r = await this.run((ex) => ex.receiveRun(name, recordId, body, callerId, forRun), at, seed);
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

  /**
   * A send (7.4, docs/design/runs.md): `started` in one entry with the payload kept in outtake, the adapter
   * outside any transaction, then `acted` or `failed` in another; an answer the adapter brings back closes
   * the run as a receive. Without an adapter the act is nothing and the run is acted.
   */
  async send(name: string, recordId: string, callerId?: string, at?: string): Promise<RunResult> {
    const p = await this.run((ex) => ex.prepare(name, recordId, callerId), at);
    if (p.started !== true) return p;
    const payload = (p.payload ?? {}) as JsonObject;
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const { createHash } = await import("node:crypto");
    await this.store.pool.query("insert into outtake (owner, run, contract, record, key, raw, sha256) values ($1, $2, $3, $4, $5, $6, $7) on conflict (owner, run) do nothing", [this.owner, String(p.log), name, recordId, String(p.key), bytes, createHash("sha256").update(bytes).digest("hex")]);
    return { ...p, ...(await this.act(name, String(p.log), recordId, payload, callerId, at)) };
  }

  /** The act and what follows it: acted or failed, and the answer landed against the run. */
  private async act(name: string, run: string, recordId: string, payload: JsonObject, callerId?: string, at?: string): Promise<RunResult> {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`no contract ${name}`);
    const adapter = this.o.adapters?.[name];
    let outcome: Awaited<ReturnType<Adapter>>;
    try {
      outcome = adapter ? await adapter(c, payload, run) : { acted: true };
    } catch (e) {
      outcome = { failed: e instanceof Error ? e.message : String(e) };
    }
    if ("failed" in outcome) return this.run((ex) => ex.failed(run, outcome.failed), at);
    const acted = await this.run((ex) => ex.acted(run, at), at);
    if (outcome.body) {
      const answered = await this.receive(name, recordId, outcome.body, callerId, at, run);
      return { ...acted, answer: answered };
    }
    return acted;
  }

  /** Try a failed run again from its kept payload (7.5 `retry`), never re-mapping it. */
  async retry(run: string, callerId?: string, at?: string): Promise<RunResult> {
    const { rows } = await this.store.pool.query("select contract, record, raw from outtake where owner = $1 and run = $2", [this.owner, run]);
    const row = rows[0] as Row | undefined;
    if (!row) throw new Error(`no payload kept for ${run}`);
    const payload = JSON.parse(Buffer.from(row.raw as Uint8Array).toString("utf8")) as JsonObject;
    return this.act(String(row.contract), run, String(row.record ?? ""), payload, callerId, at);
  }

  /** What an observation run reads (9.7.3): the observations supporting the record or its parent, and the open split items on them. */
  private async evidenceFor(recordId: string): Promise<{ observations: JsonObject[]; review: JsonObject[] }> {
    const q = async (sql: string, args: unknown[]) => (await this.store.pool.query(sql, args)).rows as Row[];
    const parent = (await q('select "of" from records where owner = $1 and id = $2', [this.owner, recordId]))[0]?.of;
    const ids = [recordId, ...(typeof parent === "string" ? [parent] : [])];
    const observations = (await q("select json from observations where owner = $1 and json->>'supports' = any($2) order by ord", [this.owner, ids])).map((r) => r.json as JsonObject);
    const items = (await q("select json from review where owner = $1 and json->>'key' = any($2) order by ord", [this.owner, ids.map((id) => `split:${id}`)])).map((r) => r.json as JsonObject);
    return { observations, review: openItems(items) };
  }

  /** The owner's offer (7.8), with the signed log entries its values came from, for another owner's take. */
  async offer(name: string, only?: string[]): Promise<Offer> {
    const state = await this.store.state();
    const ex = new Exchange(this.o.dict, this.o.contracts, this.o.roles ?? [], this.o.rules ?? []);
    ex.records = state.records;
    const o = ex.offer(name, this.owner, only);
    const vias = [...new Set(o.records.flatMap((r) => Object.values(r.sources ?? {}).map((s) => s.via)))];
    const { rows } = await this.store.pool.query("select entry from log where owner = $1 and log_id = any($2) order by seq", [this.owner, vias]);
    o.log = rows.map((r: Row) => r.entry as JsonObject);
    return o;
  }

  /** A take (7.8) of a presenter's record into one of ours, by the offer's mode; one entry naming the presenter's. */
  async take(takeName: string, offer: Offer, recordId: string, presenter: Record, callerId?: string, at?: string): Promise<RunResult> {
    return this.run((ex) => ex.take(takeName, offer, recordId, presenter), at);
  }

  /** Taken values past their terms (7.8): removed, one entry per record. */
  async expire(now: string, at?: string): Promise<string[]> {
    const { out } = await this.store.commitFrom((draft: Draft) => {
      const ex = new Exchange(this.o.dict, this.o.contracts, this.o.roles ?? [], this.o.rules ?? []);
      ex.records = draft.records;
      const ids = ex.expire(now);
      return { by: { take: "expired", at: now }, extra: [], out: ids };
    }, at);
    return out;
  }

  /** A decision on a dead run (runs.md): retry (a new run, the key released) or drop; then the act for a retry. */
  async decideRun(run: string, decision: "retry" | "drop", callerId?: string, at?: string): Promise<RunResult> {
    const p = await this.run((ex) => ex.decideRun(run, decision, callerId), at);
    if (p.started !== true) return p;
    const payload = (p.payload ?? {}) as JsonObject;
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const { createHash } = await import("node:crypto");
    await this.store.pool.query("insert into outtake (owner, run, contract, record, key, raw, sha256) values ($1, $2, $3, $4, $5, $6, $7) on conflict (owner, run) do nothing", [this.owner, String(p.log), String(p.contract), String(p.record), String(p.key), bytes, createHash("sha256").update(bytes).digest("hex")]);
    return { ...p, ...(await this.act(String(p.contract), String(p.log), String(p.record), payload, callerId, at)) };
  }

  /** Run the contract that reverses a run (7.5 `undo`), naming its cause. */
  async undo(run: string, callerId?: string, at?: string): Promise<RunResult> {
    const p = await this.run((ex) => ex.undo(run, callerId), at);
    if (p.started !== true) return p;
    const payload = (p.payload ?? {}) as JsonObject;
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const { createHash } = await import("node:crypto");
    await this.store.pool.query("insert into outtake (owner, run, contract, record, key, raw, sha256) values ($1, $2, $3, $4, $5, $6, $7) on conflict (owner, run) do nothing", [this.owner, String(p.log), String(p.contract), String(p.record), String(p.key), bytes, createHash("sha256").update(bytes).digest("hex")]);
    return { ...p, ...(await this.act(String(p.contract), String(p.log), String(p.record), payload, callerId, at)) };
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
    const p = await this.store.projecting();
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
    const p = await this.store.projecting();
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
