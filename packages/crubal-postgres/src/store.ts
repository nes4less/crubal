// store.ts: one owner's store on Postgres (docs/design/store.md). An entry is one transaction: lock the
// chain, build the entry, apply it with the engine's applyEntry, persist the difference, append the log.
// The log is the truth; `rebuild` gives every other table back from it.

import { applyEntry, diffWrites, differs, type Draft, type Entry, type State, MemoryRecords } from "@cruba/crubal";
import { Engine, serialize } from "@cruba/crubal";
import { CrubalError } from "@cruba/crubal";
import { Access, type Edge } from "@cruba/crubal";
import type { View } from "@cruba/crubal";
import { apply, pending, type Store as LifecycleStore } from "@cruba/crubal";
import type { Json, JsonObject, Record } from "@cruba/crubal";
import { entryHash, verifyChain, writeHash, type Keys } from "@cruba/crubal";
import { type Client, type Pool, transaction } from "./db.ts";
import { isObj, loadState, persist, wipeState, recordOf } from "./state.ts";
import { type Facet, type Parsed, readBundle, readBundleOnto, verifyBundle } from "@cruba/crubal";
import { dryRun, restamp, type StepStats } from "@cruba/crubal";
import { checkAll, definitionsOf, unitsExtensionOf, workingBundle } from "./definitions.ts";
import { decideReview, type Decision, openItems } from "@cruba/crubal";
import { land, receive, type IntakeOutcome } from "@cruba/crubal";
import { entriesSince, markStale, type Projecting, publish } from "./projector.ts";
import { copyWorking, loadWhole, Needs, settle, type WorkingRecords, workingState } from "./working.ts";
import type { StreamEntry } from "@cruba/crubal";

/** A state's maps copied, so a draft can be changed without touching what was loaded. */
function draftOf(state: State): Draft {
  // A copy of the working state is itself a working state, so the draft notes what it lacks.
  const s = copyWorking(state);
  return { records: s.records, bindings: s.bindings, instructions: s.instructions as Draft["instructions"], edges: s.edges, review: s.reviews };
}

export type StoreOptions = {
  /**
   * Whether `state()` and `records.all()` may load an owner's whole state. `refuse` is for a host serving
   * requests: nothing on a request path may be proportional to the catalog (brief 18, the scale rule);
   * rebuild, erase and an install's restamp read whole regardless, since they are what they are.
   */
  wholeState?: "allow" | "refuse";
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

/** What two definitions of one key must agree on (11.4): the type, the unit, how many, the list of values. */
function facetShape(f: Facet): string {
  const values = Array.isArray(f.values) ? (f.values as { value: string }[]).map((v) => v.value).join("|") : "";
  const pick = f.pick !== undefined && String(f.pick) !== "1" ? `pick ${String(f.pick)}` : "";
  return [f.type, f.unit ?? "", pick, values].filter(Boolean).join(" ");
}

/** Is a record the package's own (10.4): of a kind it defines, or wearing a class it defines? */
function ownRecord(own: Parsed, r: { kind: string; wears?: string[] }): boolean {
  return own.dict.kinds.has(r.kind) || (r.wears ?? []).some((w) => own.dict.classes.has(w));
}

/**
 * The records a package's recipes restamp (10.4), asked for by name from a working set: the records of
 * each kind it defines and the wearers of each class, so a draft loads those and nothing else. Reading the
 * catalog whole and filtering it down read a million records into memory for a recipe over a dozen
 * (Media Encyclopedia's storefront install, 2026-10-22).
 */
function ownRecordsOf(records: { forTarget(name: string): Record[] }, own: Parsed): Record[] {
  const seen = new Set<string>();
  const out: Record[] = [];
  for (const name of [...own.dict.kinds.keys(), ...own.dict.classes.keys()]) {
    for (const r of records.forTarget(name)) {
      if (seen.has(r.id) || !ownRecord(own, r)) continue;
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

/** The recipes of a package that lie between two versions, oldest first (10.1): `from` at or after the installed version, `to` at or before the new one. */
function recipesBetween<R extends { from: string; to: string }>(recipes: R[], pkg: string, installed: string, target: string): R[] {
  const version = (s: string) => s.slice(s.lastIndexOf("/") + 1);
  return recipes
    .filter((r) => r.from.startsWith(`${pkg} /`) && version(r.from) >= installed && version(r.to) <= target)
    .sort((a, b) => (version(a.from) < version(b.from) ? -1 : version(a.from) > version(b.from) ? 1 : 0));
}

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
    // Appended one by one: a first publish of a large view is hundreds of thousands of entries, more than a spread takes.
    for (const name of names) for (const e of await transaction(this.pool, (client) => publish(client, this.owner, p, name, audience))) out.push(e);
    return out;
  }

  /**
   * Publish every view whole next time, with a reset on each stream (12.6.2): an index that lost rows, or
   * kept rows nothing removed, is brought back to what the store holds. The named view alone when given.
   */
  async republish(view?: string): Promise<void> {
    const p = await this.projecting();
    if (!p) return;
    for (const v of p.views.views.values()) {
      if (view && v.name !== view) continue;
      await this.pool.query("insert into published (owner, view, audience, version) values ($1, $2, $3, '*') on conflict (owner, view, audience) do update set version = '*'", [this.owner, v.name, v.show]);
    }
  }

  /** The head of a view's stream for an audience (12.6.2): the last sequence number published, 0 when none. */
  async streamHead(view: string, audience?: string): Promise<number> {
    const p = await this.projecting();
    const v = p?.views.views.get(view);
    if (!v) throw new Error(`no view ${view}`);
    const { rows } = await this.pool.query("select coalesce(max(seq), 0) as seq from projection_stream where owner = $1 and view = $2 and audience = $3 and version = $4", [this.owner, view, audience ?? v.show, v.version ?? ""]);
    return Number((rows[0] as { seq: string | number }).seq);
  }

  /** The entries of a view's stream after `seq` (12.6.2). */
  async entriesSince(view: string, seq: number, audience?: string, limit?: number): Promise<StreamEntry[]> {
    const p = await this.projecting();
    if (!p) throw new Error("the store has no views");
    const client = await this.pool.connect();
    try {
      return await entriesSince(client, this.owner, p, view, seq, audience, limit);
    } finally {
      client.release();
    }
  }

  /** After a persist: mark what the entry made stale, inside the same transaction. */
  private async afterPersist(client: Client, before: State, after: State, seq: number, parsed?: Parsed): Promise<void> {
    const p = this.options.projecting ?? (parsed ? projectingOf(parsed) : await this.projectingFrom(client));
    if (p?.views.views.size && !this.skipStale) await markStale(client, this.owner, p, before, after, seq);
  }

  private async freshen(): Promise<void> {
    if (this.quiet) return;
    // Views with `fresh: write` publish now (12.6); a view with a delay waits for the loop.
    if (this.options.fresh === "write" && (await this.projecting())?.views.views.size) await this.project(undefined, undefined, (v) => v.fresh === "write");
  }

  /** Set while a bulk load runs: the per-commit publish waits for the one publish at the end. */
  private quiet = false;
  /** A bulk load that republishes at the end marks nothing stale per batch (load, `stale: false`). */
  private skipStale = false;

  /**
   * Load many records as the owner's own, in batches: one entry per batch, each record set whole with its
   * `sources` (or the `origin` given), the checks, rules and stale marks of a commit applying to every one;
   * the views publish once at the end. For a conversion or a migration (brief 18 step 1): a million rows
   * in an afternoon, not a day per hundred thousand through arrivals.
   */
  async load(records: Record[], by: JsonObject, opts: { batch?: number; at?: string; origin?: string; publish?: boolean; stale?: boolean } = {}): Promise<{ entries: string[]; records: number; published: number }> {
    const size = Math.max(1, Math.floor(opts.batch ?? 500));
    const entries: string[] = [];
    this.quiet = true;
    // `stale: false` marks nothing stale per batch: a conversion republishes every view at the end (12.6), and
    // marking a million rows one write at a time is the slowest thing a bulk load would do.
    this.skipStale = opts.stale === false;
    try {
      for (let i = 0; i < records.length; i += size) {
        const slice = records.slice(i, i + size);
        // Each record's values cite the entry that lands them (8.5), unless the record brings its own sources.
        const { rows } = await this.pool.query("select head_seq from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
        const via = `L-${(rows.length ? Number((rows[0] as { head_seq: string | number }).head_seq) : 0) + 1}`;
        const e = await this.commit(
          by,
          (d) => {
            for (const r of slice) {
              const sources = r.sources ?? { "*": { origin: opts.origin ?? "reported", via } };
              d.records.set(r.id, { ...r, owner: r.owner ?? this.owner, sources } as Record);
            }
          },
          opts.at,
        );
        if (e) entries.push(String(e.log));
      }
    } finally {
      this.quiet = false;
      this.skipStale = false;
    }
    const published = opts.publish === false ? 0 : (await this.project()).length;
    return { entries, records: records.length, published };
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

  /** `fresh` builds the caller's own copy to try a change on (a trial reads onto it and must not touch the shared cache). */
  private async definitionsFrom(client: Client, fresh = false): Promise<Parsed> {
    if (fresh) return definitionsOf(client, this.owner, [], true);
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
    return projectingOf(await this.definitionsFrom(client));
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
    const installed = await this.installed();
    const have = (pkg: string) => installed.filter((i) => i.package === pkg).map((i) => String(i.version));
    for (const e of (bundle.extends as JsonObject[] | undefined) ?? []) {
      // Named by short name within the bundle's own publisher, or by id across publishers.
      const dep = String(e.package).includes("/") ? String(e.package) : `${bundle.owner}/${e.package}`;
      if (!have(dep).includes(String(e.version))) throw new Error(`${bundle.id} extends ${e.package} /${e.version}, which isn't installed`);
    }
    const previous = have(String(bundle.id)).at(-1);
    if (previous === bundle.version) throw new Error(`${bundle.id} /${bundle.version} is already installed`);
    // The definitions that would result must pass every publish check before anything is written.
    const current = await this.definitions(true);
    const next = readBundleOnto(bundle, current);
    checkAll(next);
    // One dictionary (11.4): a facet another installed package defines with a different type is a collision,
    // refused here rather than letting the later definition silently win.
    const own = readBundle(bundle);
    {
      // Against each other package's version in force; a key this package's installed version already
      // defined the same way is no new collision (so two packages can unwind one, each in its turn).
      const { rows: others } = await this.pool.query("select distinct on (package) package, json from bundles where owner = $1 and package <> $2 order by package, version desc", [this.owner, bundle.id]);
      const { rows: mine } = previous ? await this.pool.query("select json from bundles where owner = $1 and package = $2 and version = $3", [this.owner, bundle.id, previous]) : { rows: [] };
      const before = mine[0] ? readBundle((mine[0] as { json: JsonObject }).json).dict.facets : new Map<string, { type: string }>();
      for (const o of others as { package: string; json: JsonObject }[]) {
        const theirs = readBundle(o.json).dict.facets;
        for (const [key, f] of own.dict.facets) {
          const t = theirs.get(key);
          if (!t) continue;
          const mine = facetShape(f);
          if (mine !== facetShape(t) && (!before.get(key) || facetShape(before.get(key) as Facet) !== mine)) throw new Error(`${bundle.id} /${bundle.version} defines ${key} as ${mine}, but ${o.package} defines it as ${facetShape(t)}; one dictionary, one key`);
        }
      }
    }
    // A version may not take away a preset or item that live edges still grant (14.12): lapse or regrant first.
    if (previous) {
      const { rows: prevRows } = await this.pool.query("select json from bundles where owner = $1 and package = $2 and version = $3", [this.owner, bundle.id, previous]);
      const was = prevRows[0] ? readBundle((prevRows[0] as { json: JsonObject }).json).perms : current.perms;
      const own = readBundle(bundle).perms;
      const gone = new Set([...was.presets.keys(), ...was.menu.keys()].filter((n) => !own.presets.has(n) && !own.menu.has(n)));
      if (gone.size) {
        const now = at ?? new Date().toISOString();
        const holding = [...installed.length ? (await this.edges()) : []].filter((e) => (!e.until || String(e.until) > now) && (e.grants as string[] | undefined)?.some((g) => gone.has(g)));
        if (holding.length) throw new Error(`${bundle.id} /${bundle.version} drops ${[...gone].join(", ")}, which ${holding.map((e) => String(e.edge)).join(", ")} still grant; lapse or regrant them first`);
      }
    }
    // The bundle goes in first: the entry's own transaction rebuilds definitions from it. A refused install takes it out again.
    await this.pool.query("insert into bundles (owner, package, version, hash, json) values ($1, $2, $3, $4, $5) on conflict (owner, package, version) do update set hash = excluded.hash, json = excluded.json", [this.owner, bundle.id, bundle.version, bundle.hash, bundle]);
    let result: { entry: Entry | null; out: null };
    this.walking = true;
    try {
      result = await this.commitFrom((draft) => {
      const extra: JsonObject[] = [{ install: { package: String(bundle.id), version: String(bundle.version), hash: String(bundle.hash) } }];
      // A pin move restamps through every recipe between the installed version and this one (10.1, 10.4),
      // in order: a store two versions behind takes both steps, never only the first.
      if (previous) {
        const parsedRecipes = recipesBetween(next.recipes, String(bundle.package), previous, String(bundle.version));
        for (const recipe of parsedRecipes) {
          // A recipe restamps what the store holds for the package (10.4): records of its kinds and records wearing its classes.
          const records = ownRecordsOf(draft.records, own);
          const { records: after, review } = restamp(records, recipe, next.dict);
          for (const r of after) draft.records.set(r.id, r);
          for (const item of review) draft.review.push({ ...item, step: item.step, migration: `${recipe.from} -> ${recipe.to}` });
        }
      }
      // The version's instruction blocks (10.7) are issued here; drain applies them record by record.
      for (const block of (bundle.instructions as JsonObject[] | undefined) ?? []) {
        const issuer = String(block.issuer);
        const list = (block.instructions as JsonObject[] | undefined) ?? [];
        if (list.length) draft.instructions.set(issuer, [...(draft.instructions.get(issuer) ?? []), ...list.map((i) => ({ ...i, issuer }))]);
      }
      const by: JsonObject = previous ? { migration: `${bundle.package} /${previous} -> ${bundle.package} /${bundle.version}` } : { person: "owner" };
      return { by, extra, out: null };
      }, at);
    } catch (e) {
      await this.pool.query("delete from bundles where owner = $1 and package = $2 and version = $3", [this.owner, bundle.id, bundle.version]);
      throw e;
    } finally {
      this.walking = false;
    }
    if (!result.entry) throw new Error("the install wrote nothing");
    this.defsCache = undefined;
    if (previous) await this.staleAll((sql, params) => this.pool.query(sql, params), await this.projecting());
    return result.entry;
  }

  /**
   * Mark every row of every view stale: after a reinstall or a rebuild the next publish rebuilds and
   * compares every row and announces what left, and the stream keeps its numbering. (Wiping the stored
   * rows instead, as before 0.1.16, made the next publish a first one, which announces no removals, so an
   * index kept rows nothing ever removed: ME's index held three versions of its shop.)
   */
  private async staleAll(run: (sql: string, params: unknown[]) => Promise<unknown>, p: Projecting | undefined): Promise<void> {
    if (!p) return;
    for (const v of p.views.views.values()) {
      await run(`insert into stale (owner, view, record, since) select $1, $2, id, 0 from records where owner = $1${v.level ? " and level = $3" : ""} on conflict do nothing`, v.level ? [this.owner, v.name, v.level] : [this.owner, v.name]);
      await run("insert into stale (owner, view, record, since) select owner, view, record, 0 from projections where owner = $1 and view = $2 on conflict do nothing", [this.owner, v.name]);
    }
  }

  /** Well-formed access (14.12) on what an entry changed: ownership, wearing, within, and every edge written. */
  /**
   * What the rules produce for the records an operation changed, and for their ancestors (6.4): a plain
   * write runs the productions as a border run does, so a rollup over units follows a unit written by the
   * owner's own commit. Derived values land in the draft with their rule as source, so the entry's writes
   * carry them like any other value; a person's value is never overwritten.
   */
  /** Records a `rederive` asks for, derived whether or not the operation changed them. */
  private alsoDerive?: Set<string>;

  /**
   * Run the productions over records as they stand (6.4), for records written before a rule existed: one
   * entry per call, holding only the derived values that changed. The ids are loaded into the working set
   * and derived with their ancestors; nothing else is written.
   */
  async rederive(ids: string[], by: JsonObject = { platform: "rederive" }, at?: string): Promise<Entry | null> {
    if (!ids.length) return null;
    this.alsoDerive = new Set(ids);
    try {
      return (await this.commitFrom((d) => { for (const id of ids) d.records.get(id); return { by, extra: [], out: null }; }, at)).entry;
    } finally {
      this.alsoDerive = undefined;
    }
  }

  private derive(p: Parsed, before: State, draft: Draft): void {
    if (!p.rules.some((r) => r.produces)) return;
    const changed: string[] = [];
    for (const [id, r] of draft.records) {
      const was = before.records.get(id);
      if (!was || serialize(was.values) !== serialize(r.values) || serialize(was.status ?? {}) !== serialize(r.status ?? {})) changed.push(id);
    }
    for (const id of this.alsoDerive ?? []) if (!changed.includes(id)) changed.push(id);
    if (!changed.length) return;
    const engine = new Engine(p.dict, p.rules, () => draft.records);
    for (const [, r] of draft.records) engine.put(r);
    const land = (id: string): boolean => {
      const rec = draft.records.get(id);
      if (!rec || rec.status?.state === "archived") return false;
      // What the record reads from above (1.7) must be in the engine: the chain up along `of`, asked for by
      // id so a working set loads just those, never the catalog.
      const seen = new Set<string>([id]);
      for (let up = rec.of ? draft.records.get(rec.of) : undefined; up && !seen.has(up.id); up = up.of ? draft.records.get(up.of) : undefined) {
        seen.add(up.id);
        engine.put(up);
      }
      engine.put(rec);
      const derived = engine.reproduce(id).filter((x) => (x.result === "derived" || x.result === "filled") && x.address && x.value !== undefined && x.rule);
      let moved = false;
      const values = { ...rec.values };
      const sources = { ...(rec.sources ?? {}) };
      for (const x of derived) {
        const address = x.address as string;
        if (serialize(values[address] ?? "∅") === serialize(x.value as Json)) continue;
        values[address] = x.value as Json;
        sources[address] = { origin: "derived", via: x.rule as string };
        moved = true;
      }
      if (!moved) return false;
      const next = { ...rec, values, sources } as Record;
      draft.records.set(id, next);
      engine.put(next);
      return true;
    };
    for (const id of changed) {
      land(id);
      if (engine.readsLowerLevels) for (const up of engine.ancestorsOf(id)) land(up);
    }
  }

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
    const { rows } = await this.pool.query("select json from review where owner = $1 order by ord", [this.owner]);
    return openItems((rows as { json: JsonObject }[]).map((r) => r.json));
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
        draft.records.set(recordId, land(cleared, { outcomes: again.outcomes as IntakeOutcome[], contract: c.name }, { origin: c.origin || "reported", via: row.intake }, p.dict.trust, p.dict.facetTrust, transitionsOf(p.dict)));
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
    // The records with an instruction still to apply, found by the tables (lifecycle.ts issuersFor: the
    // parent's instructions, a kind's, a class's worn by the record or its parent), oldest first; never a
    // walk of the catalog (brief 18, the scale rule).
    const waitingSql = `
      with ins as (select issuer, count(*)::int as n from instructions where owner = $1 group by issuer)
      select r.id, r.ord from records r
      where r.owner = $1 and coalesce(r.status ->> 'state', '') <> 'archived' and exists (
        select 1 from ins i where coalesce((r.applied ->> i.issuer)::int, 0) < i.n and (
          i.issuer = r."of"
          or (i.issuer like 'kind:%' and split_part(substr(i.issuer, 6), '/', 1) = r.kind)
          or (i.issuer like 'class:%' and (
            split_part(substr(i.issuer, 7), '/', 1) = any(r.wears)
            or split_part(substr(i.issuer, 7), '/', 1) = any(coalesce((select p.wears from records p where p.owner = r.owner and p.id = r."of"), '{}'::text[]))))))`;
    const { rows } = await this.pool.query(`${waitingSql} order by r.ord limit $2`, [this.owner, rate]);
    const applied: string[] = [];
    for (const row of rows as { id: string }[]) {
      const id = String(row.id);
      const entry = await this.commit({ migration: "drain" }, (d) => { apply(d as unknown as LifecycleStore, id, dict); }, at);
      if (entry) applied.push(id);
    }
    const left = (await this.pool.query(`select count(*)::int as n from (${waitingSql}) w`, [this.owner])).rows[0] as { n: number };
    return { applied, remaining: Number(left.n) };
  }

  /** What installing a version would restamp (10.4): per recipe and step, how many values change and how many go to review. */
  async dryRun(bundle: JsonObject): Promise<{ recipes: { from: string; to: string; steps: StepStats[]; review: number }[]; records: number }> {
    const installed = await this.installed();
    const previous = installed.filter((i) => i.package === bundle.id).map((i) => String(i.version)).at(-1);
    if (!previous) return { recipes: [], records: 0 };
    const next = readBundleOnto(bundle, await this.definitions(true));
    const own = readBundle(bundle);
    const records = await this.ownRecords(own);
    const recipes = recipesBetween(next.recipes, String(bundle.package), previous, String(bundle.version)).map((r) => { const d = dryRun(records, r, next.dict); return { from: r.from, to: r.to, steps: d.steps, review: d.review }; });
    return { recipes, records: records.length };
  }

  /** The records the package's recipes restamp (10.4): of its kinds or wearing its classes, one query on the kind and wears indexes; never the catalog whole. */
  private async ownRecords(own: Parsed): Promise<Record[]> {
    const kinds = [...own.dict.kinds.keys()];
    const classes = [...own.dict.classes.keys()];
    if (!kinds.length && !classes.length) return [];
    const { rows } = await this.pool.query("select * from records where owner = $1 and (kind = any($2::text[]) or wears && $3::text[]) order by ord", [this.owner, kinds, classes]);
    return (rows as { [column: string]: unknown }[]).map((r) => recordOf(r));
  }

  /** A define write (8.5, 11.4): one member of the working package as it now stands, checked with the rest first. */
  async define(member: JsonObject, by: JsonObject = { person: "owner" }, at?: string): Promise<Entry | null> {
    // The trial is the package as it would stand with this write (a redefinition replacing, a retired member
    // gone), checked whole; only then does the write land.
    const client = await this.pool.connect();
    try {
      checkAll(await definitionsOf(client, this.owner, [member]));
    } finally {
      client.release();
    }
    const e = (await this.commitFrom(() => ({ by, extra: [{ define: member }], out: null }), at)).entry;
    this.defsCache = undefined;
    return e;
  }

  /**
   * The owner's state as the tables hold it, kept per chain head: the same head answers from memory; a
   * head a little further on replays the entries since onto a copy (the engine's own replay), so a write
   * never costs a reload of every record; a gap over 200 entries, or an entry the replay can't take,
   * reads the tables whole. A commit works on a copy of the loaded state, so a kept state is never shared
   * with a draft. (G6: Cashierfu carried this around the store until 0.1.15.)
   */
  async state(): Promise<State> {
    if (this.options.wholeState === "refuse") throw new Error(`${this.owner}: the whole state is refused on a request path; read what is needed with read(), records(), installed(), edges() or openReview()`);
    return this.wholeState();
  }

  /**
   * The whole state regardless of the option: for a rebuild, an erase, an install's restamp, an export and a
   * test's assertions. Never on a request path: `state()` is the guarded door, this one says what it is.
   */
  async wholeState(): Promise<State> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query("select head_seq from chains where owner = $1 and chain = $2", [this.owner, this.chain]);
      const seq = rows.length ? Number((rows[0] as { head_seq: string | number }).head_seq) : -1;
      // A hosted person's writes go to their own chain (14.1) and move no head of ours, so the key the
      // state is kept under takes every hosted head along: one of theirs moving reads the tables whole.
      const hostedRows = await client.query("select coalesce(sum(head_seq), 0)::text as total, count(*)::text as n from chains where owner like $1 and chain = $2", [`${this.owner}:%`, this.chain]);
      const hosted = `${(hostedRows.rows[0] as { total: string; n: string }).n}/${(hostedRows.rows[0] as { total: string; n: string }).total}`;
      const kept = this.keptState;
      if (kept && kept.seq === seq && kept.hosted === hosted) return kept.state;
      if (kept && kept.hosted === hosted && seq > kept.seq && seq - kept.seq <= 200) {
        const since = await client.query("select seq, entry from log where owner = $1 and chain = $2 and seq > $3 order by seq", [this.owner, this.chain, kept.seq]);
        const entries = since.rows as { seq: string | number; entry: Entry }[];
        const contiguous = entries.length === seq - kept.seq && entries.every((e, i) => Number(e.seq) === kept.seq + i + 1);
        if (contiguous) {
          const next = copyState(kept.state);
          try {
            for (const e of entries) applyEntry(next, e.entry);
            this.keptState = { seq, hosted, state: next };
            return next;
          } catch {
            // an entry the replay can't take: the tables, below
          }
        }
      }
      const state = await loadState(client, this.owner);
      this.keptState = { seq, hosted, state };
      return state;
    } finally {
      client.release();
    }
  }

  // ─── Reads that never load the whole state (brief 18, the scale rule) ─────

  /**
   * A read on a working set: `fn` runs on a state whose records, bindings and runs load as it asks for them
   * (by id, level, parent, target or key), and runs again until it asked for nothing new; edges,
   * instructions and the working package are loaded whole (they are small). The lists (reviews,
   * observations, installed, reads) are not loaded here: the readers below serve them. `fn` MUST be pure.
   */
  async read<T>(fn: (s: State) => T, opts: { allowAll?: boolean } = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      const needs = new Needs();
      if (this.options.wholeState === "refuse" && !opts.allowAll) needs.refuseAll = `${this.owner}: records.all() asks for the whole catalog on a request path; ask by level, parent, target or key`;
      const base = workingState(needs);
      await loadWhole(client, this.owner, base);
      const { out } = await settle(client, this.owner, base, fn);
      return out;
    } finally {
      client.release();
    }
  }

  /** Records by level, kind, parent, placement or one key's value, in log order; paged by `ord`. */
  async records(where: { level?: string; kind?: string; of?: string; within?: string; key?: [string, Json] } = {}, opts: { limit?: number; after?: number; archived?: boolean } = {}): Promise<Record[]> {
    const conds = ["owner = $1"];
    const params: unknown[] = [this.owner];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace("?", `$${params.length}`)); };
    if (where.level) add("level = ?", where.level);
    if (where.kind) add("kind = ?", where.kind);
    if (where.of) add('"of" = ?', where.of);
    if (where.within) add("within = ?", where.within);
    // Containment, so the GIN on the values document answers (an equality on `->` would not).
    if (where.key) add("doc -> 'values' @> ?::jsonb", JSON.stringify({ [where.key[0]]: where.key[1] }));
    if (opts.archived === false) add("coalesce(status ->> 'state', '') <> ?", "archived");
    if (opts.after !== undefined) add("ord > ?", opts.after);
    const limit = opts.limit ? ` limit ${Math.max(1, Math.floor(opts.limit))}` : "";
    const { rows } = await this.pool.query(`select * from records where ${conds.join(" and ")} order by ord${limit}`, params);
    return (rows as { [column: string]: unknown }[]).map((r) => recordOf(r));
  }

  /** Every edge of the owner (small: people and their grants). */
  async edges(): Promise<Edge[]> {
    const { rows } = await this.pool.query("select json from edges where owner = $1 order by ord", [this.owner]);
    return (rows as { json: Edge }[]).map((r) => r.json);
  }

  /** The install log: every version taken, in order. */
  async installed(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from installed where owner = $1 order by ord", [this.owner]);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  /** The record a binding (`contract|ref`) names, if any. */
  async binding(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query("select record from bindings where owner = $1 and key = $2", [this.owner, key]);
    return rows[0] ? String((rows[0] as { record: string }).record) : undefined;
  }

  /** The owner's working package (11.4): `<member>:<name>` → the definition as it now stands. */
  async defines(): Promise<Map<string, JsonObject>> {
    const { rows } = await this.pool.query("select key, json from definitions where owner = $1 order by ord", [this.owner]);
    return new Map((rows as { key: string; json: JsonObject }[]).map((r) => [String(r.key), r.json]));
  }

  /** Every review item ever written, decided or not, in order (9.5); `review()` is the open ones. */
  async reviews(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from review where owner = $1 order by ord", [this.owner]);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  /** The records several bindings name, by key: one query for an import's references. */
  async bindings(keys: string[]): Promise<Map<string, string>> {
    if (!keys.length) return new Map();
    const { rows } = await this.pool.query("select key, record from bindings where owner = $1 and key = any($2)", [this.owner, keys]);
    return new Map((rows as { key: string; record: string }[]).map((r) => [String(r.key), String(r.record)]));
  }

  /** The log of reads under an emergency edge (14.13), in order. */
  async emergencyReads(): Promise<JsonObject[]> {
    const { rows } = await this.pool.query("select json from reads where owner = $1 order by ord", [this.owner]);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  /** The observations on one record, or on or supporting any of several (9.7). */
  async observationsOn(id: string | string[]): Promise<JsonObject[]> {
    return this.observations({ on: id });
  }

  /** Observations by what they are on or support, their evidence type and their address (9.7); never all of them unasked. */
  async observations(where: { on?: string | string[]; evidenceType?: string; address?: string }): Promise<JsonObject[]> {
    const conds = ["owner = $1"];
    const params: unknown[] = [this.owner];
    const add = (sql: string, v: unknown) => { params.push(v); conds.push(sql.replace("?", `$${params.length}`)); };
    if (where.on !== undefined) {
      const ids = Array.isArray(where.on) ? where.on : [where.on];
      params.push(ids);
      conds.push(`(json ->> 'on' = any($${params.length}) or json ->> 'supports' = any($${params.length}))`);
    }
    if (where.evidenceType) add("json ->> 'evidence-type' = ?", where.evidenceType);
    if (where.address) add("json ->> 'address' = ?", where.address);
    if (conds.length === 1) throw new Error(`${this.owner}: observations() wants what they are on, their evidence type or their address`);
    const { rows } = await this.pool.query(`select json from observations where ${conds.join(" and ")} order by ord`, params);
    return (rows as { json: JsonObject }[]).map((r) => r.json);
  }

  private keptState: { seq: number; hosted: string; state: State } | undefined;

  /** Forget the kept state: after a rewrite of history that moves no head (an erase, a rebuild). */
  forgetState(): void {
    this.keptState = undefined;
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
    if (this.options.wholeState === "refuse" && !this.walking) needs.refuseAll = `${this.owner}: records.all() asks for the whole catalog inside a commit on a request path; ask by level, parent, target or key`;
    this.trace = needs;
    const base = workingState(needs);
    await loadWhole(client, this.owner, base);
    return base;
  }

  /** What the last operation loaded, for tests and for watching a store's cost. */
  trace: Needs | undefined;

  /** Set while an install restamps: its commit walks the package's records by design, whatever `wholeState` says. */
  private walking = false;

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
      // CRUBAL_TRACE_COMMIT=1 prints each phase's time to stderr, for a probe or a slow commit in the field.
      const T0 = Date.now();
      const tr = (label: string) => { if (process.env.CRUBAL_TRACE_COMMIT) console.error(`commit ${this.owner} ${label} ${Date.now() - T0} ms`); };
      const head = await this.lockChain(client);
      const before = await this.base(client);
      tr("base");
      const needs = before.records as WorkingRecords;
      // The operation runs until the working set holds everything it asked for (working.ts); so does the
      // entry's application. Both run on copies of the same base, so the draft and the applied state
      // hold the same records and `differs` compares like with like.
      let draft: Draft;
      let after: State;
      let entry: Entry;
      let result: { by: JsonObject; extra?: JsonObject[]; out: T };
      const p = await this.definitionsFrom(client, false);
      tr("definitions");
      for (;;) {
        const had = needs.needs.loaded.size;
        ({ draft, result } = (await settle(client, this.owner, before, (s) => { const d = draftOf(s); const r = run(d); this.derive(p, before, d); return { draft: d, result: r }; })).out);
        const writes = [...diffWrites(before, draft), ...(result.extra ?? [])];
        if (!writes.length) return { entry: null, out: result.out };
        entry = { log: `L-${head.seq + 1}`, owner: this.owner, at: at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by: result.by, writes, ...(mark.witnessed ? { witnessed: true } : {}) };
        const e = entry;
        // The entry applied, then checked in the same run (14.12, 5.5, 14.1), so what the check reads loads too.
        after = (await settle(client, this.owner, before, (s) => { applyEntry(s, e); this.checkWrites(p, e, s); })).state;
        if (needs.needs.loaded.size === had) break;
      }
      tr(`settled, ${needs.needs.loaded.size} records loaded`);
      const { entry: linked, hosted } = await this.linkSplit(client, entry, head, after);
      const problem = differs(after, draft);
      if (problem) throw new Error(`the log doesn't describe the change: ${problem}`);
      await persist(client, this.owner, before, after);
      tr("persisted");
      await this.afterPersist(client, before, after, head.seq + (linked ? 1 : 0), p);
      tr("stale marked");
      // The definitions in force are unchanged by an entry with no define write (an install clears the
      // cache itself), so the cache follows the head: parsing them again cost every commit, and the first
      // read after it, ~110 ms on ME.
      if (linked && this.defsCache?.seq === head.seq && !(Array.isArray(entry.writes) ? entry.writes : []).some((w) => isObj(w) && isObj(w.define))) this.defsCache = { seq: head.seq + 1, parsed: this.defsCache.parsed };
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
      // Projections follow: every row of every view is marked stale, so the next publish rebuilds and
      // compares them all and announces what left.
      await this.staleAll((sql, params) => client.query(sql, params), await this.projectingFrom(client));
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

/** The facets a dictionary declares `transitions: yes` (4.2). */
function transitionsOf(dict: { facets: Map<string, { key: string; transitions?: boolean }> }): Set<string> {
  return new Set([...dict.facets.values()].filter((f) => f.transitions).map((f) => f.key));
}

/** A state copied one level down, so replayed entries apply to a fresh object while readers keep theirs. */
function copyState(st: State): State {
  return {
    records: new MemoryRecords(st.records),
    edges: new Map(st.edges),
    bindings: new Map(st.bindings),
    instructions: new Map([...st.instructions].map(([k, v]) => [k, [...v]])),
    observations: [...st.observations],
    reviews: [...st.reviews],
    runs: new Map(st.runs),
    installed: [...st.installed],
    reads: [...st.reads],
    definitions: new Map(st.definitions),
  };
}

/** What a store projects with, from the definitions in force: nothing when there is nothing to project. */
function projectingOf(p: Parsed): Projecting | undefined {
  if (!p.views.views.size && !p.dict.facets.size) return undefined;
  return { dict: p.dict, views: p.views, perms: p.perms };
}
