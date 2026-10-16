// views.ts: the Views level (spec chapter 12). Shapes map facets into display slots like a send
// contract's writes; views select records, curate, order and page them; filters are sub-indexes whose
// counts follow the other picks; audiences and show rules decide visibility, and roles narrow an audience;
// a view's read set decides which projection rows go stale.

import type { Access } from "./access.ts";
import { serialize } from "./canonical.ts";
import { evaluate, parseCondition } from "./conditions.ts";
import type { Dictionary, Facet } from "./defs.ts";
import { splitTop } from "./lex.ts";
import type { Json, JsonObject, Record } from "./model.ts";
import { MemoryRecords, type RecordSet } from "./records.ts";
import { Engine } from "./rules.ts";
import { CrubalError, readTree } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const unq = (s: string) => (s.trim().startsWith('"') ? (JSON.parse(s.trim()) as string) : s.trim());

export const AUDIENCES = ["public", "member", "staff", "owner"] as const;
const rankOf = (a: string) => {
  const i = (AUDIENCES as readonly string[]).indexOf(a);
  return i < 0 ? AUDIENCES.length : i;
};

export type Slot = { from: string; to: string; required: boolean; line: number };
export type Shape = { name: string; slots: Slot[]; line: number };
export type Bucket = { name: string; values?: string[]; range?: [number, number] };
export type Filter = { name: string; facet: string; buckets?: Bucket[]; dependent: string[]; line: number; bucketLines: number[] };
export type View = {
  name: string;
  line: number;
  level?: string;
  wears: string[];
  when?: string;
  list?: string;
  of?: string;
  pin: string[];
  hide: string[];
  order: { key: string; dir: "after" | "before" }[];
  page: number;
  shapes: string[];
  filters: string[];
  index: string[];
  indexLine: number;
  show: string;
  fresh: string;
  /** `administered`, `controlled`, `owned`, `relation <name>` or `none` (12.2); absent takes the default. */
  partition?: string;
  /** The dated version; a new version starts the view's stream over (12.6). */
  version?: string;
};
export type RoleDef = { name: string; audience: string; see: string[]; seeLine: number; line: number };
export type ViewSet = { shapes: Map<string, Shape>; filters: Map<string, Filter>; views: Map<string, View>; roles: Map<string, RoleDef>; shown: Map<string, string> };

/** Read shapes, filters, views (with a body), roles and `shown to` rules. */
export function readViews(source: string): ViewSet {
  const set: ViewSet = { shapes: new Map(), filters: new Map(), views: new Map(), roles: new Map(), shown: new Map() };
  for (const n of readTree(source)) {
    if (n.kind !== "pair" || !n.key) continue;
    const name = n.value.trim();
    const get = (k: string) => n.children.find((c) => c.key === k);
    if (n.key === "shape") {
      const slots = (get("slots")?.children ?? []).map((l) => {
        const at = l.text.lastIndexOf(" -> ");
        if (at < 0) throw new CrubalError(`a slot is "from -> slot": ${l.text}`, l.line);
        let from = l.text.slice(0, at).trim();
        const required = from.startsWith("!");
        if (required) from = from.slice(1);
        return { from, to: l.text.slice(at + 4).trim(), required, line: l.line };
      });
      set.shapes.set(name, { name, slots, line: n.line });
    } else if (n.key === "filter") {
      const b = get("buckets");
      const buckets = b?.children.map((c): Bucket => {
        // A bucket line is `name: values`; the name may be quoted, with spaces ("Like new": NM, VG).
        const m = c.text.match(/^("(?:[^"\\]|\\.)*"|[^:]+):\s+(.*)$/);
        if (!m) throw new CrubalError(`a bucket is "name: values": ${c.text}`, c.line);
        const label = unq(m[1] as string);
        const rest = (m[2] as string).trim();
        const range = rest.match(/^(-?[\d.]+)\.\.(-?[\d.]+)$/);
        return range ? { name: label, range: [Number(range[1]), Number(range[2])] } : { name: label, values: splitTop(rest, ",", c.line).map(unq) };
      });
      set.filters.set(name, {
        name,
        facet: get("facet")?.value ?? name,
        ...(buckets ? { buckets } : {}),
        dependent: (get("dependent")?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        line: n.line,
        bucketLines: b?.children.map((c) => c.line) ?? [],
      });
    } else if (n.key === "view" && n.children.length) {
      const sel = get("select");
      const s = (k: string) => sel?.children.find((c) => c.key === k)?.value;
      const list = (k: string) => (get(k)?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      set.views.set(name, {
        name,
        line: n.line,
        ...(s("level") ? { level: s("level") as string } : {}),
        wears: (s("wears") ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        ...(s("when") ? { when: s("when") as string } : {}),
        ...(s("list") ? { list: s("list") as string } : {}),
        ...(get("of") ? { of: get("of")?.value as string } : {}),
        pin: list("pin"),
        hide: list("hide"),
        order: list("order").map((o) => {
          const [key = "", dir] = o.split(/\s+/);
          return { key, dir: dir === "after" ? "after" : "before" };
        }),
        page: Number(get("page")?.value ?? 24),
        shapes: list("shape"),
        filters: list("filters"),
        index: list("index"),
        indexLine: get("index")?.line ?? n.line,
        show: get("show")?.value ?? "public",
        fresh: get("fresh")?.value ?? "write",
        ...(get("partition") ? { partition: get("partition")?.value.trim() as string } : {}),
        ...(get("version") ? { version: get("version")?.value.trim() as string } : {}),
      });
    } else if (n.key === "role") {
      const see = get("may")?.children.find((c) => c.key === "see");
      set.roles.set(name, {
        name,
        audience: get("audience")?.value ?? "member",
        see: (see?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        seeLine: see?.line ?? n.line,
        line: n.line,
      });
    } else if (n.key === "rule") {
      const then = get("then")?.value ?? "";
      const m = then.match(/^(\S+) shown to (\S+)$/);
      if (m) set.shown.set(m[1] as string, m[2] as string);
    }
  }
  return set;
}

/** Can an audience see a facet? (`shown to` names the lowest audience that may.) */
function visibleTo(set: ViewSet, facet: string, audience: string): boolean {
  const min = set.shown.get(facet.replace(/^\w+::/, ""));
  return !min || rankOf(audience) >= rankOf(min);
}

/** The keys a slot's source reads. */
function slotKeys(from: string): string[] {
  if (from.startsWith('"')) return [...(JSON.parse(from) as string).matchAll(/\{([^{}]+)\}/g)].flatMap((m) => (m[1] as string).split("??").map((k) => k.trim().replace(/\?$/, "")));
  const agg = from.match(/^(?:count|least|most|sum|best|worst|join) of (\S+)$/);
  return [agg ? (agg[1] as string) : from];
}

// ─── Publish checks (12.8) ───────────────────────────────────────────────────

export function checkViews(set: ViewSet, dict: Dictionary): void {
  const defined = (k: string) => dict.facets.has(k.replace(/^\w+::/, "").replace(/^parts\[\*\]\./, ""));
  for (const f of set.filters.values()) {
    if (!defined(f.facet)) throw new CrubalError(`the filter ${f.name} reads ${f.facet}, which isn't a facet`, f.line);
    const facet = dict.facets.get(f.facet.replace(/^\w+::/, ""));
    const seen = new Map<string, string>();
    f.buckets?.forEach((b, i) => {
      for (const v of b.values ?? []) {
        if (facet?.values && !facet.values.some((x) => x.value === v)) throw new CrubalError(`${v} is not a value of ${facet.key}`, f.bucketLines[i]);
        const other = seen.get(v);
        if (other) throw new CrubalError(`${v} is in both ${other} and ${b.name}`, f.bucketLines[i]);
        seen.set(v, b.name);
      }
    });
  }
  for (const s of set.shapes.values()) {
    for (const sl of s.slots) for (const k of slotKeys(sl.from)) if (!sl.from.startsWith('"') || k) if (!defined(k) && k !== "id") throw new CrubalError(`the slot ${sl.to} reads ${k}, which isn't a facet`, sl.line);
  }
  for (const v of set.views.values()) {
    for (const s of v.shapes) if (s !== "crubal:portable" && !set.shapes.has(s)) throw new CrubalError(`${v.name} names the shape ${s}, which doesn't exist`, v.line);
    for (const f of v.filters) if (!set.filters.has(f)) throw new CrubalError(`${v.name} names the filter ${f}, which doesn't exist`, v.line);
    for (const i of v.index) if (!v.filters.includes(i)) throw new CrubalError(`${v.name} indexes ${i}, which isn't one of its filters`, v.indexLine);
    for (const c of v.wears) if (!dict.classes.has(c)) throw new CrubalError(`${v.name} selects by ${c}, which isn't a class`, v.line);
    if (v.show === "public") {
      const reads = [
        ...v.shapes.flatMap((s) => (set.shapes.get(s)?.slots ?? []).flatMap((sl) => slotKeys(sl.from))),
        ...v.filters.map((f) => set.filters.get(f)?.facet ?? f),
      ];
      const hidden = reads.find((k) => !visibleTo(set, k, "public"));
      if (hidden) throw new CrubalError(`the public view ${v.name} reads ${hidden}, which show rules hide from public`, v.line);
    }
  }
  for (const r of set.roles.values()) {
    for (const k of r.see) {
      if (!defined(k)) throw new CrubalError(`${r.name} grants see: ${k}, which isn't a facet`, r.seeLine);
      if (!visibleTo(set, k, r.audience)) throw new CrubalError(`${r.name} grants see: ${k}, which the ${r.audience} audience can't see`, r.seeLine);
    }
  }
}

// ─── Projecting (12.2–12.6) ──────────────────────────────────────────────────

export type ProjectOptions = {
  audience?: string;
  caller?: Record;
  context?: Record;
  picks?: { [filter: string]: string[] };
  page?: number;
  /** Access (chapter 14) for partitioned views: the index serves a caller only the rows their edges match. */
  access?: Access;
  /** Only these records: a projector rebuilding the rows a write made stale (12.6) asks for them alone. */
  only?: string[];
};
export type Projection = { rows: JsonObject[]; records: string[]; counts: { [filter: string]: { [bucket: string]: number } }; pages: number; indexable: boolean };
/** One entry of a view's projection stream (12.6, 12.7). */
export type StreamEntry = { projection: string; audience: string; seq: number; record: string; row?: JsonObject; buckets?: JsonObject; sort?: string[]; pin?: number; removed?: true; reset?: true };

/** A view's partition: what it declares, else `controlled` above member and `none` otherwise (12.2). */
export function partitionOf(v: View): string {
  return v.partition ?? (rankOf(v.show) > rankOf("member") ? "controlled" : "none");
}

function plainText(v: Json): string {
  if (typeof v === "string") return v;
  if (isObj(v) && "$link" in v) return `&${v.$link}`;
  if (isObj(v) && "$value" in v) return plainText(v.$value as Json);
  return serialize(v);
}

function label(key: string): string {
  const words = key.replace(/^.*:/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class Views {
  readonly dict: Dictionary;
  readonly set: ViewSet;
  private records: RecordSet = new MemoryRecords();
  private engine: Engine;

  /** Over a record set of the caller's (a store's working set), or an empty memory set to `put` into. */
  constructor(dict: Dictionary, set: ViewSet, records?: RecordSet) {
    this.dict = dict;
    this.set = set;
    if (records) this.records = records;
    this.engine = new Engine(dict, []);
  }

  put(r: Record) {
    this.records.set(r.id, r);
  }

  private effective(r: Record): JsonObject {
    const up = r.of ? this.records.get(r.of) : undefined;
    return { ...(up ? this.effective(up) : {}), ...r.values };
  }

  /** The classes a record wears, those of the records above it included (5.5). */
  private wearsOf(r: Record): string[] {
    const up = r.of ? this.records.get(r.of) : undefined;
    return [...(up ? this.wearsOf(up) : []), ...(r.wears ?? [])];
  }

  private below(r: Record, level: string): Record[] {
    return this.records.childrenOf(r.id, "of", level);
  }

  /** The values an address reads, as a list: own values, or a lower level's (`unit::price`). */
  private valuesAt(r: Record, address: string): Json[] {
    const m = address.match(/^(\w+)::(.+)$/);
    // A level prefix reads the records below at that level, or the record itself when it sits there
    // (a standing-alone lower record answers for its own level, 1.7).
    if (m && r.level === m[1]) return this.valuesAt(r, m[2] as string);
    if (m) return this.below(r, m[1] as string).flatMap((u) => this.valuesAt(u, m[2] as string));
    const v = this.effective(r)[address];
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  }

  /** Is a value fit for this audience's eyes? New, unknown and held values never reach the public. */
  private fit(key: string, v: Json, audience: string): boolean {
    if (audience !== "public") return true;
    if (isObj(v) && "$empty" in v) return v.$empty === "n/a";
    const f = this.dict.facets.get(key.replace(/^\w+::/, ""));
    if (f?.type === "choice" && typeof v === "string") return (f.values ?? []).some((x) => x.value === v);
    return true;
  }

  private canSee(key: string, audience: string, caller?: Record): boolean {
    if (!visibleTo(this.set, key, audience)) return false;
    if (!caller || rankOf(audience) <= rankOf("member")) return true;
    // Above member, a person sees what members see plus what their roles grant (default deny).
    if (visibleTo(this.set, key, "member")) return true;
    const held = caller.values.roles;
    const names = (Array.isArray(held) ? held : held ? [held] : []).map((x) => (isObj(x) && "$link" in x ? String(x.$link) : String(x)));
    return names.some((n) => {
      const role = this.set.roles.get(n);
      return role && role.see.includes(key.replace(/^\w+::/, "")) && rankOf(role.audience) <= rankOf(audience);
    });
  }

  private slot(r: Record, s: Slot, audience: string, caller?: Record): Json | undefined {
    const keys = slotKeys(s.from);
    if (!keys.every((k) => this.canSee(k, audience, caller))) return undefined;
    if (s.from.startsWith('"')) return this.engine.template(s.from, this.effective(r));
    const agg = s.from.match(/^(count|least|most|sum|best|worst|join) of (\S+)$/);
    if (agg) {
      const items = this.valuesAt(r, agg[2] as string).filter((v) => !(isObj(v) && "$empty" in v));
      if (agg[1] === "count") return String(items.length);
      if (!items.length) return undefined;
      const amount = (v: Json) => Number(isObj(v) ? (v.$money ?? v.$qty ?? NaN) : v);
      const sorted = [...items].sort((a, b) => amount(a) - amount(b));
      if (agg[1] === "least") return sorted[0];
      if (agg[1] === "most") return sorted.at(-1);
      return items;
    }
    const f = this.dict.facets.get(s.from.replace(/^\w+::/, ""));
    const v = s.from.includes("::") ? this.valuesAt(r, s.from) : this.effective(r)[s.from];
    if (v === undefined) return undefined;
    if (Array.isArray(v)) {
      const kept = v.filter((x) => this.fit(s.from, x, audience));
      return kept.length ? (f?.many || s.from.includes("::") ? kept : kept[0]) : undefined;
    }
    return this.fit(s.from, v, audience) ? v : undefined;
  }

  /**
   * What a condition reads of a record (6.3): the envelope under `crubal:`, and bare `id` and `status`
   * too unless a facet of that name holds a value, which then wins.
   */
  private conditionValues(r: Record): JsonObject {
    const status = r.status?.state ?? "active";
    return { id: r.id, status, "crubal:id": r.id, "crubal:status": status, ...this.effective(r) };
  }

  /** The values of the view's order keys as text, and the pin position: what an index orders rows by (12.7). */
  sortOf(v: View, r: Record): { sort: string[]; pin?: number } {
    const vals = this.effective(r);
    const sort = v.order.map((o) => plainText((vals[o.key] ?? "") as Json));
    const at = v.pin.indexOf(r.id);
    return at >= 0 ? { sort, pin: at + 1 } : { sort };
  }

  /** The buckets a record falls into, per filter of the view (12.6): what an index counts from. */
  bucketsFor(v: View, r: Record): JsonObject {
    const out: JsonObject = {};
    for (const fname of v.filters) {
      const f = this.set.filters.get(fname);
      if (!f) continue;
      const names = this.bucketsOf(f).filter((b) => this.inBucket(r, f, b)).map((b) => b.name);
      if (names.length) out[fname] = names;
    }
    return out;
  }

  private inBucket(r: Record, f: Filter, b: Bucket): boolean {
    return this.valuesAt(r, f.facet).some((v) => {
      const t = plainText(v);
      if (b.values) return b.values.includes(t);
      if (b.range) return Number.parseFloat(t) >= b.range[0] && Number.parseFloat(t) <= b.range[1];
      return false;
    });
  }

  private bucketsOf(f: Filter): Bucket[] {
    if (f.buckets) return f.buckets;
    const facet = this.dict.facets.get(f.facet.replace(/^\w+::/, ""));
    return (facet?.values ?? []).map((v) => ({ name: v.value, values: [v.value] }));
  }

  /** The records a view selects, curated and ordered, before filters and paging. */
  select(v: View, opts: ProjectOptions = {}): Record[] {
    const audience = opts.audience ?? v.show;
    const pool = opts.only ? opts.only.flatMap((id) => this.records.get(id) ?? []) : v.level ? this.records.atLevel(v.level) : this.records.all();
    let rows = pool.filter((r) => {
      if (v.level && r.level !== v.level) return false;
      // An archived record is left out unless the view selects on status explicitly (1.12).
      if (r.status?.state === "archived" && !(v.when && /\bstatus\b/.test(v.when))) return false;
      if (v.wears.some((w) => !this.wearsOf(r).includes(w))) return false;
      if (v.hide.includes(r.id)) return false;
      const vals = this.conditionValues(r);
      if (v.when && evaluate(parseCondition(v.when), vals) !== true) return false;
      if (v.of) {
        const ctx = opts.context;
        if (!ctx) return false;
        const cvals: JsonObject = this.conditionValues(ctx);
        const cond = v.of.replace(/context\.(\w+)/g, (_, k: string) => JSON.stringify(cvals[k] === undefined ? "" : plainText(cvals[k] as Json)));
        if (evaluate(parseCondition(cond), vals) !== true) return false;
      }
      return true;
    });
    // A record whose required slot is empty is dropped from the view.
    const shape = this.set.shapes.get(v.shapes[0] ?? "");
    rows = rows.filter((r) => (shape?.slots ?? []).every((s) => !s.required || this.slot(r, s, audience, opts.caller) !== undefined));
    const cmp = (a: Record, b: Record) => {
      for (const o of v.order) {
        const x = plainText((this.effective(a)[o.key] ?? "") as Json);
        const y = plainText((this.effective(b)[o.key] ?? "") as Json);
        if (x !== y) return (x < y ? -1 : 1) * (o.dir === "after" ? -1 : 1);
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    const pinned = v.pin.map((id) => rows.find((r) => r.id === id)).filter((r): r is Record => !!r);
    return [...pinned, ...rows.filter((r) => !v.pin.includes(r.id)).sort(cmp)];
  }

  /** The roles whose `see` a slot needs above member (12.6 role marks): none when members may see it. */
  private marksFor(s: Slot, audience: string): string[] {
    if (rankOf(audience) <= rankOf("member")) return [];
    const keys = slotKeys(s.from);
    if (keys.every((k) => visibleTo(this.set, k, "member"))) return [];
    return [...this.set.roles.values()].filter((r) => rankOf(r.audience) <= rankOf(audience) && keys.every((k) => visibleTo(this.set, k, "member") || r.see.includes(k.replace(/^\w+::/, "")))).map((r) => r.name).sort();
  }

  /** A view's projection for an audience (or a caller), with filter counts and a page. */
  project(name: string, opts: ProjectOptions = {}): Projection {
    const v = this.set.views.get(name);
    if (!v) throw new Error(`no view ${name}`);
    // A caller's audience is read off their edges (14.4) when access is at hand; a stated value otherwise.
    const audience = opts.caller ? (opts.access ? opts.access.audienceOf(opts.caller.id) : String(opts.caller.values.audience ?? "member")) : (opts.audience ?? v.show);
    const partition = partitionOf(v);
    let all = this.select(v, { ...opts, audience });
    // A partitioned view serves a caller only the rows their edges match (12.6, 14.10).
    if (partition !== "none" && opts.access && opts.caller) all = all.filter((r) => (opts.access as Access).standsIn((opts.caller as Record).id, r.id, partition));
    const picks = opts.picks ?? {};
    const passes = (r: Record, except?: string) =>
      Object.entries(picks).every(([fname, chosen]) => {
        if (fname === except) return true;
        const f = this.set.filters.get(fname);
        return !f || this.bucketsOf(f).some((b) => chosen.includes(b.name) && this.inBucket(r, f, b));
      });
    const counts: Projection["counts"] = {};
    for (const fname of v.filters) {
      const f = this.set.filters.get(fname);
      if (!f) continue;
      const pool = all.filter((r) => passes(r, fname));
      counts[fname] = Object.fromEntries(this.bucketsOf(f).map((b) => [b.name, pool.filter((r) => this.inBucket(r, f, b)).length]));
    }
    const chosen = all.filter((r) => passes(r));
    const pages = Math.max(1, Math.ceil(chosen.length / v.page));
    const page = opts.page ?? 1;
    const onPage = chosen.slice((page - 1) * v.page, page * v.page);
    const pickList = Object.entries(picks).filter(([, c]) => c.length);
    const indexable = page === 1 && (pickList.length === 0 || (pickList.length === 1 && v.index.includes(pickList[0]?.[0] as string) && pickList[0]?.[1].length === 1));
    const shapeName = v.shapes[0] ?? "";
    const rows = onPage.map((r): JsonObject => {
      if (shapeName === "crubal:portable") return { record: r.id, values: this.portable(r, audience, opts.caller) };
      const row: JsonObject = { record: r.id };
      const marks: JsonObject = {};
      for (const s of this.set.shapes.get(shapeName)?.slots ?? []) {
        const val = this.slot(r, s, audience, opts.caller);
        if (val !== undefined) row[s.to] = val;
        const m = opts.caller ? [] : this.marksFor(s, audience);
        if (val !== undefined && m.length) marks[s.to] = m.length === 1 ? (m[0] as string) : m;
      }
      if (Object.keys(marks).length) row.marks = marks;
      // A partitioned view's row carries its record's ancestors, so an index can match edges to it.
      if (partition !== "none" && opts.access) row.ancestors = opts.access.ancestors(r.id);
      return row;
    });
    return { rows, records: onPage.map((r) => r.id), counts, pages, indexable };
  }

  private streams = new Map<string, { version: string; rows: Map<string, string>; seq: number; log: StreamEntry[]; published: boolean }>();

  /** A view's version, as its stream names it. */
  versionOf(name: string): string {
    return this.set.views.get(name)?.version ?? "";
  }

  /** A new version of a view: its stream starts over at the next publish (12.6). */
  revise(name: string, version: string) {
    const v = this.set.views.get(name);
    if (!v) throw new Error(`no view ${name}`);
    v.version = version;
  }

  /**
   * The projection stream (12.6): the entries since the last publish of this view for this audience, one
   * per row that is new or changed, and one removal per row that left. Numbered per view and audience; a
   * new version of the view starts over at 1, its first entry marked `reset`.
   */
  stream(name: string, opts: Omit<ProjectOptions, "page" | "picks"> = {}): StreamEntry[] {
    const v = this.set.views.get(name);
    if (!v) throw new Error(`no view ${name}`);
    const audience = opts.audience ?? v.show;
    const key = `${name}|${audience}`;
    const version = v.version ?? "";
    const projection = version ? `${name} /${version}` : name;
    const had = this.streams.get(key);
    const last = had && had.version === version ? had : { version, rows: new Map<string, string>(), seq: 0, log: [] as StreamEntry[], published: false };
    const reset = !!had && had.version !== version;
    const now = new Map<string, JsonObject>();
    for (let page = 1; ; page++) {
      const p = this.project(name, { ...opts, audience, page });
      for (const row of p.rows) now.set(String(row.record), row);
      if (page >= p.pages) break;
    }
    const out: StreamEntry[] = [];
    const next = { version, rows: new Map<string, string>(), seq: last.seq, log: [...last.log], published: true };
    for (const [id, row] of now) {
      const rec = this.records.get(id);
      const buckets = rec ? this.bucketsFor(v, rec) : {};
      const order = rec ? this.sortOf(v, rec) : { sort: [] };
      const s = serialize({ row, buckets, order: order as unknown as Json });
      next.rows.set(id, s);
      if (last.rows.get(id) !== s) out.push({ projection, audience, seq: ++next.seq, record: id, row, ...(Object.keys(buckets).length ? { buckets } : {}), ...(order.sort.length ? { sort: order.sort } : {}), ...(order.pin ? { pin: order.pin } : {}) });
    }
    for (const id of last.rows.keys()) if (!now.has(id)) out.push({ projection, audience, seq: ++next.seq, record: id, removed: true });
    if (reset && out[0]) out[0].reset = true;
    next.log.push(...out);
    this.streams.set(key, next);
    return out;
  }

  /** The current version's entries after `seq`, for an index resuming from its cursor (12.6.2). */
  entriesSince(name: string, seq: number, audience?: string): StreamEntry[] {
    const v = this.set.views.get(name);
    const s = this.streams.get(`${name}|${audience ?? v?.show ?? "public"}`);
    return (s?.log ?? []).filter((e) => e.seq > seq);
  }

  /** The portable shape (12.1): key, label, type and value for every value the audience may see. */
  portable(r: Record, audience = "public", caller?: Record): Json[] {
    return Object.entries(r.values).flatMap(([key, v]) => {
      if (!this.canSee(key, audience, caller)) return [];
      const f: Facet | undefined = this.dict.facets.get(key);
      return [{ key, label: f?.label ?? label(key), type: f?.type ?? "raw", value: v }];
    });
  }

  /** The keys a view reads (12.6), with level prefixes kept. */
  readSet(name: string): Set<string> {
    const v = this.set.views.get(name);
    if (!v) return new Set();
    const keys: string[] = [];
    if (v.when) keys.push(...parseConditionKeys(v.when));
    if (v.of) keys.push(...parseConditionKeys(v.of.replace(/context\.\w+/g, '""')));
    keys.push(...v.order.map((o) => o.key));
    for (const s of v.shapes) for (const sl of this.set.shapes.get(s)?.slots ?? []) keys.push(...slotKeys(sl.from));
    for (const f of v.filters) keys.push(this.set.filters.get(f)?.facet ?? f);
    for (const k of [...keys]) if (this.set.shown.has(k)) keys.push(k);
    return new Set(keys.filter((k) => k !== "id"));
  }

  /** Which of a view's rows a write makes stale: the written record, or what reads it through. */
  staleAfter(name: string, write: Record): string[] {
    const v = this.set.views.get(name);
    if (!v) return [];
    const reads = this.readSet(name);
    const out = new Set<string>();
    // The envelope is in every read set (12.6): a status, wears, within or of change stales the row.
    const was = this.records.get(write.id);
    const envelope = (["status", "wears", "within", "of"] as const).some((m) => serialize((write[m] ?? "") as Json) !== serialize((was?.[m] ?? "") as Json));
    if (envelope) out.add(write.id);
    for (const key of Object.keys(write.values)) {
      if (reads.has(key) && (!v.level || write.level === v.level)) out.add(write.id);
      if (reads.has(`${write.level}::${key}`) && write.of) out.add(write.of);
      if (reads.has(key) && v.level && write.level !== v.level) {
        for (const r of this.records.childrenOf(write.id, "of", v.level)) out.add(r.id);
      }
    }
    return [...out];
  }
}

function parseConditionKeys(text: string): string[] {
  const out: string[] = [];
  const walk = (e: ReturnType<typeof parseCondition>) => {
    if (e.op === "test") out.push(e.path.replace(/^(count|least|most|sum) of /, ""));
    else if (e.op === "not") walk(e.a);
    else {
      walk(e.a);
      walk(e.b);
    }
  };
  walk(parseCondition(text));
  return out;
}
