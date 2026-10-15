// store.ts: one owner's store on Postgres (docs/design/store.md). An entry is one transaction: lock the
// chain, build the entry, apply it with the engine's applyEntry, persist the difference, append the log.
// The log is the truth; `rebuild` gives every other table back from it.

import { applyEntry, diffWrites, differs, emptyState, type Draft, type Entry, type State } from "../../crubal/src/log.ts";
import type { JsonObject } from "../../crubal/src/model.ts";
import { MemoryRecords } from "../../crubal/src/records.ts";
import { entryHash, verifyChain, writeHash, type Keys } from "../../crubal/src/store.ts";
import { type Client, type Pool, transaction } from "./db.ts";
import { isObj, loadState, persist, wipeState } from "./state.ts";

const clone = <T>(v: T): T => structuredClone(v);

/** A state's maps copied, so a draft can be changed without touching what was loaded. */
function draftOf(state: State): Draft {
  const records = new MemoryRecords();
  for (const [id, r] of state.records) records.set(id, clone(r));
  return { records, bindings: new Map(state.bindings), instructions: new Map([...state.instructions].map(([k, v]) => [k, clone(v)])) as Draft["instructions"], edges: new Map([...state.edges].map(([k, v]) => [k, clone(v)])), review: clone(state.reviews) };
}

function copyState(state: State): State {
  const s = emptyState();
  for (const [id, r] of state.records) s.records.set(id, clone(r));
  for (const [k, v] of state.edges) s.edges.set(k, clone(v));
  for (const [k, v] of state.bindings) s.bindings.set(k, v);
  for (const [k, v] of state.instructions) s.instructions.set(k, clone(v));
  s.observations.push(...clone(state.observations));
  s.reviews.push(...clone(state.reviews));
  for (const [k, v] of state.runs) s.runs.set(k, clone(v));
  s.installed.push(...clone(state.installed));
  s.reads.push(...clone(state.reads));
  for (const [k, v] of state.definitions) s.definitions.set(k, clone(v));
  return s;
}

export class PgStore {
  readonly pool: Pool;
  readonly owner: string;
  readonly chain: string;

  constructor(pool: Pool, owner: string, chain = "main") {
    this.pool = pool;
    this.owner = owner;
    this.chain = chain;
  }

  /** The owner's state as the tables hold it. */
  async state(): Promise<State> {
    const client = await this.pool.connect();
    try {
      return await loadState(client, this.owner);
    } finally {
      client.release();
    }
  }

  /** The owner's entries, in chain order. */
  async entries(): Promise<Entry[]> {
    const { rows } = await this.pool.query("select entry from log where owner = $1 and chain = $2 order by seq", [this.owner, this.chain]);
    return rows.map((r: { entry: Entry }) => r.entry);
  }

  /** Lock the chain for this transaction and return its head. Writers to one chain serialize here. */
  private async lockChain(client: Client): Promise<{ seq: number; hash: string | null }> {
    await client.query("insert into chains (owner, chain) values ($1, $2) on conflict do nothing", [this.owner, this.chain]);
    const { rows } = await client.query("select head_seq, head_hash from chains where owner = $1 and chain = $2 for update", [this.owner, this.chain]);
    const head = rows[0] as { head_seq: string | number; head_hash: string | null };
    return { seq: Number(head.head_seq), hash: head.head_hash };
  }

  /** Link an entry to the chain's head, insert it, and move the head. The entry gets its `prev`. */
  private async link(client: Client, entry: Entry, head: { seq: number; hash: string | null }): Promise<Entry> {
    const linked: Entry = { ...entry };
    if (head.hash) linked.prev = `sha256:${head.hash}`;
    else delete linked.prev;
    const hash = entryHash(linked);
    const seq = head.seq + 1;
    await client.query(
      "insert into log (owner, chain, seq, log_id, prev, hash, at, witnessed, entry) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [this.owner, this.chain, seq, String(linked.log), linked.prev ?? null, hash, typeof linked.at === "string" ? linked.at : null, linked.witnessed === true, linked],
    );
    await client.query("update chains set head_seq = $3, head_hash = $4 where owner = $1 and chain = $2", [this.owner, this.chain, seq, hash]);
    return linked;
  }

  /**
   * Append an entry made elsewhere (a rebuilt log, a hosted person's chain the host carries): it is
   * linked to this chain's head, applied with the engine's applyEntry, and its effects persisted.
   */
  async append(entry: Entry): Promise<Entry> {
    return transaction(this.pool, async (client) => {
      const head = await this.lockChain(client);
      const before = await loadState(client, this.owner);
      const after = copyState(before);
      const linked = await this.link(client, entry, head);
      applyEntry(after, linked);
      await persist(client, this.owner, before, after);
      return linked;
    });
  }

  /**
   * One operation, one entry (8.5): the engine runs on a draft of the state, what it changed becomes the
   * entry's writes (plus `extra` writes the diff can't see), and the entry is applied and persisted in the
   * same transaction. Nothing happens when nothing changed; a throw inside `mutate` rolls everything back.
   */
  async commit(by: JsonObject, mutate: (draft: Draft) => void, at?: string, extra: JsonObject[] = []): Promise<Entry | null> {
    return transaction(this.pool, async (client) => {
      const head = await this.lockChain(client);
      const before = await loadState(client, this.owner);
      const draft = draftOf(before);
      mutate(draft);
      const writes = [...diffWrites(before, draft), ...extra];
      if (!writes.length) return null;
      const entry: Entry = { log: `L-${head.seq + 1}`, owner: this.owner, at: at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by, writes };
      const after = copyState(before);
      const linked = await this.link(client, entry, head);
      applyEntry(after, linked);
      const problem = differs(after, draft);
      if (problem) throw new Error(`the log doesn't describe the change: ${problem}`);
      await persist(client, this.owner, before, after);
      return linked;
    });
  }

  /** Check the chain's links and, with the owner's key, its signatures (8.5). */
  async verify(keys?: Keys): Promise<ReturnType<typeof verifyChain>> {
    return verifyChain((await this.entries()) as unknown as JsonObject[], keys);
  }

  /** Empty the owner's state tables and apply the log again, in order (8.5.3). */
  async rebuild(): Promise<State> {
    return transaction(this.pool, async (client) => {
      await this.lockChain(client);
      await wipeState(client, this.owner);
      const state = emptyState();
      const { rows } = await client.query("select entry from log where owner = $1 and chain = $2 order by seq", [this.owner, this.chain]);
      for (const row of rows as { entry: Entry }[]) applyEntry(state, row.entry);
      await persist(client, this.owner, emptyState(), state);
      return state;
    });
  }

  /**
   * Redact one write of an entry, or the whole entry (8.5.2): the log's one update, which the trigger
   * admits and nothing else. The state is then rebuilt, so the cache forgets what the log forgot.
   */
  async redact(logId: string, writeIndex?: number): Promise<void> {
    await transaction(this.pool, async (client) => {
      await this.lockChain(client);
      const { rows } = await client.query("select entry from log where owner = $1 and log_id = $2 for update", [this.owner, logId]);
      const entry = (rows[0] as { entry: Entry } | undefined)?.entry;
      if (!entry) throw new Error(`no entry ${logId}`);
      if (entry.witnessed === true) throw new Error("a witnessed entry is never redacted");
      let next: Entry;
      if (writeIndex === undefined) {
        const writes = Array.isArray(entry.writes) ? entry.writes : [];
        for (const w of writes) if (isObj(w) && !(typeof w.record === "string" && typeof w.address === "string") && !isObj(w.observation) && typeof w.read !== "string" && typeof w.redacted !== "string") throw new Error("an entry holding a write that is never redacted is redacted write by write, never whole");
        next = { log: String(entry.log), redacted: `sha256:${entryHash(entry as unknown as JsonObject)}` };
        if (entry.prev !== undefined) next.prev = entry.prev;
        if (entry.chain !== undefined) next.chain = entry.chain;
        if (entry.sig !== undefined) next.sig = entry.sig;
      } else {
        const writes = Array.isArray(entry.writes) ? [...entry.writes] : [];
        const w = writes[writeIndex];
        if (!isObj(w)) throw new Error(`no write ${writeIndex} in ${logId}`);
        if (!(typeof w.record === "string" && typeof w.address === "string") && !isObj(w.observation) && typeof w.read !== "string") throw new Error("a write that created a record, changed its envelope or a definition, or wrote an edge, binding, review, instruction, run or install is never redacted");
        writes[writeIndex] = { redacted: `sha256:${writeHash(w)}` };
        next = { ...entry, writes };
      }
      await client.query("update log set entry = $3 where owner = $1 and log_id = $2", [this.owner, logId, next]);
    });
    await this.rebuild();
  }
}
