// store.ts: one owner's store on Postgres (docs/design/store.md). An entry is one transaction: lock the
// chain, build the entry, apply it with the engine's applyEntry, persist the difference, append the log.
// The log is the truth; `rebuild` gives every other table back from it.

import { applyEntry, diffWrites, differs, type Draft, type Entry, type State } from "../../crubal/src/log.ts";
import { CrubalError } from "../../crubal/src/tree.ts";
import { Access, type Edge } from "../../crubal/src/access.ts";
import type { View } from "../../crubal/src/views.ts";
import { apply, pending, type Store as LifecycleStore } from "../../crubal/src/lifecycle.ts";
import type { Json, JsonObject, Record } from "../../crubal/src/model.ts";
import { entryHash, verifyChain, writeHash, type Keys } from "../../crubal/src/store.ts";
import { type Client, type Pool, transaction } from "./db.ts";
import { isObj, loadState, persist, wipeState, recordOf } from "./state.ts";
import { type Parsed, readBundleOnto, verifyBundle } from "../../crubal/src/bundle.ts";
import { dryRun, restamp, type StepStats } from "../../crubal/src/migrate.ts";
import { checkAll, definitionsOf, unitsExtensionOf, workingBundle } from "./definitions.ts";
import { decide as decideReview, type Decision, openItems } from "../../crubal/src/review.ts";
import { land, receive, type IntakeOutcome } from "../../crubal/src/store.ts";
import { entriesSince, markStale, type Projecting, publish } from "./projector.ts";
import { copyWorking, loadWhole, Needs, settle, type WorkingRecords, workingState } from "./working.ts";
import type { StreamEntry } from "../../crubal/src/views.ts";

/** A state's maps copied, so a draft can be changed without touching what was loaded. */
function draftOf(state: State): Draft {
  // A copy of the working state is itself a working state, so the draft notes what it lacks.
  const s = copyWorking(state);
  return { records: s.records, bindings: s.bindings, instructions: s.instructions as Draft["instructions"], edges: s.edges, review: s.reviews };
}

export type StoreOptions = {
  chain?: string;
  /** Definitions handed in instead of read from the store's installed bundles and define writes (tests). */
  projecting?: Projecting;
  /** Install an unsigned bundle (development only; refused by default, docs/design/publishing.md). */
  allowUnsigned?: boolean;
  /** Sign each entry's hash with the owner's key (8.5): the host holds the key, the store never sees it. */
  signer?: (hash: string) => string;
  /** Publish every view right after each write commits (`fresh: write`); else the host calls `project`. */
  fresh?: "write" | "asked";
  /** The signer for a person this owner hosts (14.1), made on their first write; the host holds the key. */
  hostedSigner?: (owner: string) => Promise<((hash: string) => string) | undefined>;
};

export class PgStore {
  readonly pool: Pool;
  readonly owner: string;
  readonly chain: string;
  readonly options: StoreOptions;

  constructor(pool: Pool, owner: string, options: StoreOptions | string = {}) {
    this.pool = pool;
    this.owner = owner;
    this.options = typeof options === "string" ? { chain: options } : options;
    this.chain = this.options.chain ?? "main";
  }

  /**
   * Publish the views whose rows a write made stale (12.6): every view, or the named one, for its own
   * audience or the one given. Runs outside any write transaction. Returns the stream entries published.
   */
  async project(view?: string, audience?: string, only?: (v: View) => boolean): Promise<StreamEntry[]> {
    const p = await this.projecting();
    if (!p) throw new Error("the store has no views to project");
    const names = view ? [view] : [...p.views.views.values()].filter((v) => !only || only(v)).map((v) => v.name);
    const out: StreamEntry[] = [];
    for (const name of names) out.push(...(await transaction(this.pool, (client) => publish(client, this.owner, p, name, audience))));
    return out;
  }

  /** The entries of a view's stream after `seq` (12.6.2). */
  async entriesSince(view: string, seq: number, audience?: string): Promise<StreamEntry[]> {
    const p = await this.projecting();
    if (!p) throw new Error("the store has no views");
    const client = await this.pool.connect();
    try {
      return await entriesSince(client, this.owner, p, view, seq, audience);
    } finally {
      client.release();
    }
  }

  /** After a persist: mark what the entry made stale, inside the same transaction. */
  private async afterPersist(client: Client, before: State, after: State, seq: number): Promise<void> {
    const p = this.options.projecting ?? (await this.projectingFrom(client));
    if (p?.views.views.size) await markStale(client, this.owner, p, before, after, seq);
  }

  private async freshen(): Promise<void> {
    // Views with `fresh: write` publish now (12.6); a view with a delay waits for the loop.
    if (this.options.fresh === "write" && (await this.projecting())?.views.views.size) await this.project(undefined, undefined, (v) => v.fresh === "write");
  }

  // ─── Definitions from the store (docs/design/publishing.md) ────────────────

  private defsCache: { seq: number; parsed: Parsed } | undefined;

  /** The definitions in force: installed bundles in order, then the owner's define writes. Cached per chain head. */
  async definitions(fresh = false): Promise<Parsed> {
    const client = await this.pool.connect();
    try {
      return await this.definitionsFrom(client, fresh);
    } finally {
      client.release();
    }
  }

  /** `fresh` builds a copy to try a change on (a trial reads onto it and must not touch the cache). */
  private async definitionsFrom(client: Client, fresh = false): Promise<Parsed> {
    if (fresh) return definitionsOf(client, this.owner);
    const { rows } = await client.query("select head_seq from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
    const seq = rows.length ? Number((rows[0] as { head_seq: string | number }).head_seq) : 0;
    if (this.defsCache && this.defsCache.seq === seq) return this.defsCache.parsed;
    const parsed = await definitionsOf(client, this.owner);
    this.defsCache = { seq, parsed };
    return parsed;
  }

  /** What the store projects with: handed in, else built from its definitions. */
  async projecting(): Promise<Projecting | undefined> {
    if (this.options.projecting) return this.options.projecting;
    const client = await this.pool.connect();
    try {
      return await this.projectingFrom(client);
    } finally {
      client.release();
    }
  }

  private async projectingFrom(client: Client): Promise<Projecting | undefined> {
    if (this.options.projecting) return this.options.projecting;
    const p = await this.definitionsFrom(client);
    if (!p.views.views.size && !p.dict.facets.size) return undefined;
    return { dict: p.dict, views: p.views, perms: p.perms };
  }

  /**
   * Install a published version (docs/design/publishing.md): verify the hash and signature, require the
   * language version at or below ours and every extended package installed at its pinned version, write
   * the install entry and keep the bundle, restamp through the recipes when an earlier version was
   * installed, and check the definitions that result. Refused whole on any failure.
   */
  async install(bundle: JsonObject, keys?: Keys, at?: string): Promise<Entry> {
    if (!bundle.sig && !this.options.allowUnsigned) throw new Error(`${bundle.id}: unsigned bundles are refused; a store may allow them for development`);
    const v = verifyBundle(bundle, bundle.sig ? keys : undefined);
    if (!v.valid) throw new Error(`${bundle.id}: the bundle doesn't verify (${v.reason})`);
    if (Number(bundle.crubal ?? 2) > 2) throw new Error(`${bundle.id} is written in CRUBAL ${bundle.crubal}, above this store's`);
    const installed = (await this.state()).installed;
    const have = (pkg: string) => installed.filter((i) => i.package === pkg).map((i) => String(i.version));
    for (const e of (bundle.extends as JsonObject[] | undefined) ?? []) {
      if (!have(String(e.package)).includes(String(e.version))) throw new Error(`${bundle.id} extends ${e.package} /${e.version}, which isn't installed`);
    }
    const previous = have(String(bundle.id)).at(-1);
    if (previous === bundle.version) throw new Error(`${bundle.id} /${bundle.version} is already installed`);
    // The definitions that would result must pass every publish check before anything is written.
    const next = readBundleOnto(bundle, await this.definitions(true));
    checkAll(next);
    // The bundle goes in first: the entry's own transaction rebuilds definitions from it. A refused install takes it out again.
    await this.pool.query("insert into bundles (owner, package, version, hash, json) values ($1, $2, $3, $4, $5) on conflict (owner, package, version) do update set hash = excluded.hash, json = excluded.json", [this.owner, bundle.id, bundle.version, bundle.hash, bundle]);
    let result: { entry: Entry | null; out: null };
    try {
      result = await this.commitFrom((draft) => {
      const extra: JsonObject[] = [{ install: { package: String(bundle.id), version: String(bundle.version), hash: String(bundle.hash) } }];
      // A pin move restamps through the bundle's recipes from the installed version (10.4), in order.
      if (previous) {
        const recipes = ((bundle.recipes as JsonObject[] | undefined) ?? []).filter((r) => r.migration && (r.migration as JsonObject).from === `${bundle.package} /${previous}`);
        const parsedRecipes = next.recipes.filter((r) => recipes.some((j) => (j.migration as JsonObject).from === r.from));
        for (const recipe of parsedRecipes) {
          const records = draft.records.all();
          const { records: after, review } = restamp(records, recipe, next.dict);
          for (const r of after) draft.records.set(r.id, r);
          for (const item of review) draft.review.push({ ...item, step: item.step, migration: `${recipe.from} -> ${recipe.to}` });
        }
      }
      const by: JsonObject = previous ? { migration: `${bundle.package} /${previous} -> ${bundle.package} /${bundle.version}` } : { person: "owner" };
      return { by, extra, out: null };
      }, at);
    } catch (e) {
      await this.pool.query("delete from bundles where owner = $1 and package = $2 and version = $3", [this.owner, bundle.id, bundle.version]);
      throw e;
    }
    if (!result.entry) throw new Error("the install wrote nothing");
    this.defsCache = undefined;
    if (previous) for (const table of ["projections", "projection_stream", "stale"]) await this.pool.query(`delete from ${table} where owner = $1`, [this.owner]);
    return result.entry;
  }

  /** Well-formed access (14.12) on what an entry changed: ownership, wearing, within, and every edge written. */
  private checkWrites(p: Parsed, entry: Entry, after: State): void {
    const writes = (Array.isArray(entry.writes) ? entry.writes : []) as JsonObject[];
    const touched = new Set(writes.map((w) => (typeof w.record === "string" ? w.record : "")).filter(Boolean));
    const edges = writes.filter((w) => isObj(w.edge)).map((w) => w.edge as unknown as Edge);
    if (!touched.size && !edges.length) return;
    const access = new Access(p.dict, p.perms, after.records, [...after.edges.values()] as unknown as Edge[], this.owner);
    for (const id of touched) {
      const r = after.records.get(id);
      if (!r) continue;
      access.checkOwnership(r);
      access.checkWears(r);
      // Within: the chain up from this record only, never a scan of the catalog.
      const seen = new Set<string>([id]);
      let cur = r.within;
      while (cur) {
        if (seen.has(cur)) throw new CrubalError(`${id} is within itself through ${cur}`);
        seen.add(cur);
        const up = after.records.get(cur);
        if (up && up.owner !== r.owner) throw new CrubalError(`${id} is within ${cur}, which belongs to ${up.owner}: within never crosses owners`);
        cur = up?.within;
      }
    }
    // An emergency edge is checked by the host against the platform's published terms (14.13), not here.
    for (const e of edges) if (e.relation !== "emergency") access.checkEdge(e);
  }

  /** One record by id, from its row alone (no whole state): undefined when there is none. */
  async get(id: string): Promise<Record | undefined> {
    const { rows } = await this.pool.query("select * from records where owner = $1 and id = $2", [this.owner, id]);
    return rows[0] ? recordOf(rows[0] as { [column: string]: unknown }) : undefined;
  }

  /** The review items still open (9.5). */
  async review(): Promise<JsonObject[]> {
    return openItems((await this.state()).reviews);
  }

  /**
   * A review decision (9.5, 11.9, 14.7, runs.md): one entry holding the review write and what it causes;
   * then the intakes the decision affects are replayed (9.6), each its own entry.
   */
  async decide(d: Decision, by: JsonObject = { person: "owner" }, at?: string): Promise<{ entry: Entry | null; replayed: string[] }> {
    const p = await this.definitions(true);
    // The operation may run more than once while the working set loads (working.ts): each run changes a copy.
    const fresh = () => ({ dict: { ...p.dict, facets: new Map(p.dict.facets) }, contracts: new Map(p.contracts.map((c) => [c.name, c])), units: [...((p as Parsed & { units?: JsonObject[] }).units ?? [])] });
    const result = await this.commitFrom((draft) => {
      const extra = decideReview(d, draft as unknown as Parameters<typeof decideReview>[1], fresh());
      return { by, extra, out: null };
    }, at);
    this.defsCache = undefined;
    const replayed = await this.replayFor(d, at);
    return { entry: result.entry, replayed };
  }

  /** Replay the kept intakes a decision reaches: by facet, by contract field, or by unit spelling (9.6). */
  private async replayFor(d: Decision, at?: string): Promise<string[]> {
    const key = d.key;
    const reaches = (o: JsonObject) =>
      (key.startsWith("facet:") && o.to === key.slice(6) && o.outcome === "new") ||
      (key.startsWith("contract:") && o.from === d.field && o.outcome === "unknown") ||
      (key.startsWith("unit:") && isObj(o.cites) && o.cites.unit === key.slice(5));
    if (!key.startsWith("facet:") && !key.startsWith("contract:") && !key.startsWith("unit:")) return [];
    if (d.decision === "reject" || d.decision === "ignore" || d.decision === "not a unit") return [];
    const p = await this.definitions(true);
    const { rows } = await this.pool.query("select intake, contract, \"for\", raw, json from intake where owner = $1 order by received", [this.owner]);
    const out: string[] = [];
    for (const row of rows as { intake: string; contract: string; for: string | null; raw: Uint8Array; json: JsonObject }[]) {
      const outcomes = (row.json.outcomes as JsonObject[] | undefined) ?? [];
      if (!outcomes.some(reaches) || !row.for) continue;
      const c = p.contracts.find((x) => x.name === row.contract);
      if (!c) continue;
      const body = Buffer.from(row.raw).toString("utf8");
      const again = receive(c, body, row.for, p.dict, row.intake);
      const recordId = row.for;
      const earlier = `L-${row.intake.slice(2)}`;
      const entry = await this.commitFrom((draft) => {
        const r = draft.records.get(recordId);
        if (!r) return { by: { migration: "replay" }, out: null };
        // What this intake landed before is replaced by its replay, never left to a tie with itself.
        const values = { ...r.values };
        const sources = { ...(r.sources ?? {}) };
        for (const [k, s] of Object.entries(sources)) if (s.via === earlier || s.via === row.intake) { delete values[k]; delete sources[k]; }
        const cleared = { ...r, values, sources };
        draft.records.set(recordId, land(cleared, { outcomes: again.outcomes as IntakeOutcome[], contract: c.name }, { origin: c.origin || "reported", via: row.intake }, p.dict.trust, p.dict.facetTrust));
        return { by: { migration: "replay" }, extra: [], out: null };
      }, at);
      await this.pool.query("update intake set json = $3 where owner = $1 and intake = $2", [this.owner, row.intake, { ...row.json, replays: [...((row.json.replays as JsonObject[]) ?? []), { outcomes: again.outcomes as unknown as Json, contract: c.name, ...(entry.entry ? { entry: String(entry.entry.log) } : {}) }] }]);
      out.push(row.intake);
    }
    return out;
  }

  /**
   * Drain (docs/design/store.md, completion.md P): apply pending instructions to the records that have
   * them, at most `rate` records per call, each its own entry `by: migration: drain`; the ids done and
   * how many still wait.
   */
  async drain(rate = 100, at?: string): Promise<{ applied: string[]; remaining: number }> {
    const dict = (await this.definitions()).dict;
    const s = await this.state();
    const store = { records: s.records, bindings: s.bindings, instructions: s.instructions, review: s.reviews, edges: s.edges } as unknown as LifecycleStore;
    const waiting = s.records.all().filter((r) => r.status?.state !== "archived" && pending(store, r).length > 0).map((r) => r.id);
    const applied: string[] = [];
    for (const id of waiting.slice(0, rate)) {
      const entry = await this.commit({ migration: "drain" }, (d) => { apply(d as unknown as LifecycleStore, id, dict); }, at);
      if (entry) applied.push(id);
    }
    return { applied, remaining: Math.max(0, waiting.length - applied.length) };
  }

  /** What installing a version would restamp (10.4): per recipe and step, how many values change and how many go to review. */
  async dryRun(bundle: JsonObject): Promise<{ recipes: { from: string; to: string; steps: StepStats[]; review: number }[]; records: number }> {
    const installed = (await this.state()).installed;
    const previous = installed.filter((i) => i.package === bundle.id).map((i) => String(i.version)).at(-1);
    if (!previous) return { recipes: [], records: 0 };
    const next = readBundleOnto(bundle, await this.definitions(true));
    const records = (await this.state()).records.all();
    const recipes = next.recipes.filter((r) => r.from === `${bundle.package} /${previous}`).map((r) => { const d = dryRun(records, r, next.dict); return { from: r.from, to: r.to, steps: d.steps, review: d.review }; });
    return { recipes, records: records.length };
  }

  /** A define write (8.5, 11.4): one member of the working package as it now stands, checked with the rest first. */
  async define(member: JsonObject, by: JsonObject = { person: "owner" }, at?: string): Promise<Entry | null> {
    const trial = readBundleOnto(workingBundle(this.owner, [member]), await this.definitions(true));
    checkAll(trial);
    const e = (await this.commitFrom(() => ({ by, extra: [{ define: member }], out: null }), at)).entry;
    this.defsCache = undefined;
    return e;
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
  private async link(client: Client, entry: Entry, head: { seq: number; hash: string | null }, owner = this.owner, signer = this.options.signer): Promise<Entry> {
    const linked: Entry = { ...entry };
    if (head.hash) linked.prev = `sha256:${head.hash}`;
    else delete linked.prev;
    const hash = entryHash(linked);
    if (signer) linked.sig = signer(hash);
    const seq = head.seq + 1;
    await client.query(
      "insert into log (owner, chain, seq, log_id, prev, hash, at, witnessed, entry) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [owner, this.chain, seq, String(linked.log), linked.prev ?? null, hash, typeof linked.at === "string" ? linked.at : null, linked.witnessed === true, linked],
    );
    await client.query("update chains set head_seq = $3, head_hash = $4 where owner = $1 and chain = $2", [owner, this.chain, seq, hash]);
    return linked;
  }

  /**
   * A hosted person's records live in their own chain (14.1): the writes to records owned `<owner>:<id>`
   * leave the owner's entry and become one entry per person, linked and signed in the same transaction.
   * The chains lock in a fixed order (the owner's first, then the persons' by name).
   */
  private async linkSplit(client: Client, entry: Entry, head: { seq: number; hash: string | null }, after: State): Promise<{ entry: Entry | null; hosted: Entry[] }> {
    const prefix = `${this.owner}:`;
    const byOwner = new Map<string, JsonObject[]>();
    const own: JsonObject[] = [];
    for (const w of (Array.isArray(entry.writes) ? entry.writes : []) as JsonObject[]) {
      const rec = typeof w.record === "string" ? after.records.get(w.record) : undefined;
      const o = rec?.owner;
      if (o && o.startsWith(prefix)) byOwner.set(o, [...(byOwner.get(o) ?? []), w]);
      else own.push(w);
    }
    const hosted: Entry[] = [];
    for (const person of [...byOwner.keys()].sort()) {
      await client.query("insert into chains (owner, chain) values ($1, $2) on conflict do nothing", [person, this.chain]);
      const { rows } = await client.query("select head_seq, head_hash from chains where owner = $1 and chain = $2 for update", [person, this.chain]);
      const h = rows[0] as { head_seq: number | string; head_hash: string | null };
      const ph = { seq: Number(h.head_seq), hash: h.head_hash };
      const signer = this.options.hostedSigner ? await this.options.hostedSigner(person) : undefined;
      const e: Entry = { ...entry, log: `L-${ph.seq + 1}`, owner: person, writes: byOwner.get(person) as JsonObject[] };
      hosted.push(await this.link(client, e, ph, person, signer));
    }
    if (!own.length) return { entry: null, hosted };
    return { entry: await this.link(client, { ...entry, writes: own }, head), hosted };
  }

  /**
   * Append an entry made elsewhere (a rebuilt log, a hosted person's chain the host carries): it is
   * linked to this chain's head, applied with the engine's applyEntry, and its effects persisted.
   */
  async append(entry: Entry): Promise<Entry> {
    return transaction(this.pool, async (client) => {
      const head = await this.lockChain(client);
      const base = await this.base(client);
      const linked = await this.link(client, entry, head);
      const { state: after } = await settle(client, this.owner, base, (s) => applyEntry(s, linked));
      await persist(client, this.owner, base, after);
      await this.afterPersist(client, base, after, head.seq + 1);
      return linked;
    }).then(async (e) => {
      await this.freshen();
      return e;
    });
  }

  /** An empty working state with the whole small tables in it; records, bindings and runs load as needed. */
  private async base(client: Client): Promise<State> {
    const needs = new Needs();
    this.trace = needs;
    const base = workingState(needs);
    await loadWhole(client, this.owner, base);
    return base;
  }

  /** What the last operation loaded, for tests and for watching a store's cost. */
  trace: Needs | undefined;

  /**
   * One operation, one entry (8.5): the engine runs on a draft of the state, what it changed becomes the
   * entry's writes (plus `extra` writes the diff can't see), and the entry is applied and persisted in the
   * same transaction. Nothing happens when nothing changed; a throw inside `mutate` rolls everything back.
   */
  async commit(by: JsonObject, mutate: (draft: Draft) => void, at?: string, extra: JsonObject[] = []): Promise<Entry | null> {
    return (await this.commitFrom((d) => { mutate(d); return { by, extra, out: undefined }; }, at)).entry;
  }

  /**
   * The same, for an operation that decides its own cause and extra writes as it runs (a border run): it
   * returns `by`, `extra` and an outcome, and the outcome comes back beside the entry.
   */
  async commitFrom<T>(run: (draft: Draft) => { by: JsonObject; extra?: JsonObject[]; out: T }, at?: string, mark: { witnessed?: true } = {}): Promise<{ entry: Entry | null; out: T }> {
    return transaction(this.pool, async (client) => {
      const head = await this.lockChain(client);
      const before = await this.base(client);
      const needs = before.records as WorkingRecords;
      // The operation runs until the working set holds everything it asked for (working.ts); so does the
      // entry's application. Both run on copies of the same base, so the draft and the applied state
      // hold the same records and `differs` compares like with like.
      let draft: Draft;
      let after: State;
      let entry: Entry;
      let result: { by: JsonObject; extra?: JsonObject[]; out: T };
      const p = await this.definitionsFrom(client, false);
      for (;;) {
        const had = needs.needs.loaded.size;
        ({ draft, result } = (await settle(client, this.owner, before, (s) => { const d = draftOf(s); const r = run(d); return { draft: d, result: r }; })).out);
        const writes = [...diffWrites(before, draft), ...(result.extra ?? [])];
        if (!writes.length) return { entry: null, out: result.out };
        entry = { log: `L-${head.seq + 1}`, owner: this.owner, at: at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by: result.by, writes, ...(mark.witnessed ? { witnessed: true } : {}) };
        const e = entry;
        // The entry applied, then checked in the same run (14.12, 5.5, 14.1), so what the check reads loads too.
        after = (await settle(client, this.owner, before, (s) => { applyEntry(s, e); this.checkWrites(p, e, s); })).state;
        if (needs.needs.loaded.size === had) break;
      }
      const { entry: linked, hosted } = await this.linkSplit(client, entry, head, after);
      const problem = differs(after, draft);
      if (problem) throw new Error(`the log doesn't describe the change: ${problem}`);
      await persist(client, this.owner, before, after);
      await this.afterPersist(client, before, after, head.seq + (linked ? 1 : 0));
      return { entry: linked ?? (hosted[0] as Entry), out: result.out };
    }).then(async (r) => {
      if (r.entry) await this.freshen();
      return r;
    });
  }

  /**
   * Erase a record's values from the log (8.5.2): every value write to it, and every observation on it, in
   * every entry, is redacted in place; creations, envelopes and everything else stay. The state is rebuilt.
   */
  async erase(recordId: string): Promise<{ redacted: number; witnessed: string[] }> {
    const witnessed: string[] = [];
    let redacted = 0;
    await transaction(this.pool, async (client) => {
      await this.lockChain(client);
      const { rows } = await client.query("select owner, log_id, entry from log where (owner = $1 or owner like $1 || ':%') and chain = $2 and not (entry ? 'redacted') order by ord for update", [this.owner, this.chain]);
      for (const row of rows as { owner: string; log_id: string; entry: Entry }[]) {
        const writes = Array.isArray(row.entry.writes) ? row.entry.writes : [];
        const hits = writes.map((w, i) => (isObj(w) && ((w.record === recordId && typeof w.address === "string") || (isObj(w.observation) && w.observation.on === recordId)) ? i : -1)).filter((i) => i >= 0);
        if (!hits.length) continue;
        if (row.entry.witnessed === true) {
          witnessed.push(row.log_id);
          continue;
        }
        const next = [...writes];
        for (const i of hits) next[i] = { redacted: `sha256:${writeHash(writes[i] as JsonObject)}` };
        await client.query("update log set entry = $3 where owner = $1 and log_id = $2", [row.owner, row.log_id, { ...row.entry, writes: next }]);
        redacted += hits.length;
      }
    });
    // What is kept beside the log for the record goes too: the payloads sent about it.
    await this.pool.query("delete from outtake where owner = $1 and record = $2", [this.owner, recordId]);
    if (redacted) await this.rebuild();
    return { redacted, witnessed };
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
      // The owner's chain and the chains of the people it hosts (14.1), in the order they were written.
      const { rows } = await client.query("select entry from log where (owner = $1 or owner like $1 || ':%') and chain = $2 order by ord", [this.owner, this.chain]);
      for (const row of rows as { entry: Entry }[]) {
        const base = await this.base(client);
        const { state } = await settle(client, this.owner, base, (s) => applyEntry(s, row.entry));
        await persist(client, this.owner, base, state);
      }
      // Projections follow: with nothing stored, the next publish rebuilds every row of every view.
      for (const table of ["projections", "projection_stream", "stale"]) await client.query(`delete from ${table} where owner = $1`, [this.owner]);
      return loadState(client, this.owner);
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
