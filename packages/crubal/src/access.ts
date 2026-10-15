// access.ts: who may do what to which record (spec chapter 14). Owners hold the key; everything else is an
// edge: who, relation, mode, on which record (and everything within it), what it grants, granted under
// which edge. Modes nest (admin > control > consume > view > none); you grant only what you hold; an edge
// is only as good as its grantor; packages declare the permission menu, presets and relations; gated edges
// turn writes into suggestions; emergency edges are the one grant not made inside the owner.

import { compareTime, evaluate, parseCondition } from "./conditions.ts";
import type { Dictionary } from "./defs.ts";
import { splitTop } from "./lex.ts";
import type { Json, JsonObject, Record } from "./model.ts";
import { CrubalError, type Node, readTree } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export const MODES = ["none", "view", "consume", "control", "admin"] as const;
export type Mode = (typeof MODES)[number];
export const VERBS = ["see", "edit", "run", "review", "archive", "merge", "apply", "install", "grant"] as const;
const rank = (m: string) => (MODES as readonly string[]).indexOf(m);

export type MenuItem = { name: string; verbs: { [verb: string]: string[] }; on?: string; line: number };
export type Preset = { name: string; items: string[]; audience: string; line: number };
export type Permissions = {
  name?: string;
  menu: Map<string, MenuItem>;
  presets: Map<string, Preset>;
  relations: Map<string, { only: boolean }>;
  /** `person` → the kinds and classes a person may own (14.1) */
  ownership: Map<string, string[]>;
  /** A platform's published emergency terms (11.7, 14.13). */
  emergency?: { approvers: number; longest: string };
};
export type Edge = {
  edge: string;
  who: string;
  relation: string;
  mode: Mode;
  on: string;
  grants: string[];
  where?: string;
  until?: string;
  gate?: string;
  reviewer?: string;
  by: string;
  emergency?: JsonObject;
  line: number;
};

export function emptyPermissions(): Permissions {
  return { menu: new Map(), presets: new Map(), relations: new Map(), ownership: new Map() };
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** `run checkIn, see unit::price on: administered` → verbs and an optional scope. */
function readMenuItem(name: string, value: string, line: number): MenuItem {
  let text = value.trim();
  let on: string | undefined;
  const at = text.indexOf(" on: ");
  if (at >= 0) {
    on = text.slice(at + 5).trim();
    text = text.slice(0, at).trim();
  }
  const verbs: { [verb: string]: string[] } = {};
  let current: string | null = null;
  for (const piece of splitTop(text, ",", line)) {
    const [first = "", ...rest] = piece.split(/\s+/);
    if ((VERBS as readonly string[]).includes(first)) {
      current = first;
      verbs[current] = [...(verbs[current] ?? []), ...rest];
    } else if (current) verbs[current] = [...(verbs[current] ?? []), ...piece.split(/\s+/)];
    else throw new CrubalError(`a menu item starts with a verb (${VERBS.join(", ")}): ${piece}`, line);
  }
  return { name, verbs, ...(on ? { on } : {}), line };
}

/** Read `permissions:`, `ownership:`, `emergency:` and `edge:` blocks. */
export function readAccess(source: string): { perms: Permissions; edges: Edge[] } {
  const perms = emptyPermissions();
  const edges: Edge[] = [];
  for (const n of readTree(source)) {
    if (n.kind !== "pair" || !n.key) continue;
    if (n.key === "permissions") {
      perms.name = n.value.trim();
      for (const c of n.children) {
        if (c.key === "menu") for (const m of c.children) if (m.key) perms.menu.set(m.key, readMenuItem(m.key, m.value, m.line));
        if (c.key === "presets") {
          for (const p of c.children) {
            if (!p.key) continue;
            let text = p.value;
            let audience = "member";
            const at = text.indexOf(" audience: ");
            if (at >= 0) {
              audience = text.slice(at + 11).trim();
              text = text.slice(0, at);
            }
            perms.presets.set(p.key, { name: p.key, items: list(text), audience, line: p.line });
          }
        }
        if (c.key === "relations") {
          for (const r of list(c.value)) {
            const only = / only$/.test(r);
            perms.relations.set(r.replace(/ only$/, ""), { only });
          }
        }
      }
    } else if (n.key === "ownership") {
      for (const c of n.children) if (c.key) perms.ownership.set(c.key, list(c.value));
    } else if (n.key === "emergency") {
      const get = (k: string) => n.children.find((c) => c.key === k)?.value.trim();
      perms.emergency = { approvers: Number(get("approvers") ?? 2), longest: get("longest") ?? "PT24H" };
    } else if (n.key === "edge") {
      edges.push(readEdge(n));
    }
  }
  return { perms, edges };
}

function readEdge(n: Node): Edge {
  const get = (k: string) => n.children.find((c) => c.key === k);
  const v = (k: string) => get(k)?.value.trim();
  const e: Edge = {
    edge: n.value.trim(),
    who: v("who") ?? "",
    relation: v("relation") ?? "",
    mode: (v("mode") ?? "none") as Mode,
    on: v("on") ?? "",
    grants: list(v("grants") ?? ""),
    by: v("by") ?? "",
    line: n.line,
  };
  for (const k of ["where", "until", "gate", "reviewer"] as const) if (v(k)) e[k] = v(k) as string;
  const em = get("emergency");
  if (em) {
    const o: JsonObject = {};
    for (const c of em.children) if (c.key) o[c.key] = c.key === "approvals" ? list(c.value) : c.value.trim();
    e.emergency = o;
  }
  return e;
}

/** Is `who` a caller of another owner? Local callers are bare IDs; foreign ones carry their owner's domain. */
export function foreign(who: string, owner: string): boolean {
  const m = who.match(/^([a-z0-9.-]+\.[a-z]+):/);
  return !!m && m[1] !== owner;
}

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;
function durationMs(d: string): number {
  const m = d.match(ISO_DURATION);
  if (!m) return Number.NaN;
  return (Number(m[1] ?? 0) * 24 * 60 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 60_000;
}

export type Effective = { mode: Mode; items: Set<string>; relations: Set<string>; gated: boolean; edges: Edge[] };

export class Access {
  /** The edges; a store that journals (chapter 8.5) points this at its draft's edges. */
  edges = new Map<string, Edge>();
  readonly dict: Dictionary;
  readonly perms: Permissions;
  readonly records: Map<string, Record>;
  readonly owner: string;
  readonly now: string | undefined;
  constructor(dict: Dictionary, perms: Permissions, records: Map<string, Record>, edges: Edge[], owner: string, now?: string) {
    this.dict = dict;
    this.perms = perms;
    this.records = records;
    this.owner = owner;
    this.now = now;
    for (const e of edges) this.edges.set(e.edge, e);
  }

  /** The records up a record's `within` chain, nearest first (14.2). */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur = this.records.get(id)?.within;
    while (cur && !out.includes(cur) && out.length < 1000) {
      out.push(cur);
      cur = this.records.get(cur)?.within;
    }
    return out;
  }

  /** Refuse a `within` cycle (14.12). */
  checkWithin(): void {
    for (const r of this.records.values()) {
      const seen = new Set<string>([r.id]);
      let cur = r.within;
      while (cur) {
        if (seen.has(cur)) throw new CrubalError(`${r.id} is within itself through ${cur}`);
        seen.add(cur);
        cur = this.records.get(cur)?.within;
      }
    }
  }

  /** A merged record resolves through `into` (1.12), for edges on it and reaches into it. */
  surviving(id: string): string {
    let cur = id;
    for (let i = 0; i < 100; i++) {
      const r = this.records.get(cur);
      if (!r || r.status?.reason !== "merged" || !r.status.into) return cur;
      cur = r.status.into;
    }
    return cur;
  }

  covers(e: Edge, recordId: string): boolean {
    const on = this.surviving(e.on);
    const target = this.surviving(recordId);
    return on === target || this.ancestors(target).includes(on);
  }

  /** Does the edge's `where` hold for this record (14.4)? It narrows per record covered. */
  holds(e: Edge, recordId: string): boolean {
    if (!e.where) return true;
    const r = this.records.get(recordId);
    const vals: JsonObject = { ...(r?.values ?? {}), id: recordId, ...(r?.status ? { status: r.status.state } : {}) };
    return evaluate(parseCondition(e.where), vals) === true;
  }

  /** Is an edge live (14.4, 14.5): not lapsed, and its grantor live and covering it? */
  live(e: Edge, seen = new Set<string>()): boolean {
    if (seen.has(e.edge)) return false;
    seen.add(e.edge);
    if (e.until && this.now) {
      const c = compareTime(e.until, this.now);
      if (c !== "undetermined" && c <= 0) return false;
    }
    if (e.by === "owner" || e.by === "platform") return true;
    const g = this.edges.get(e.by);
    return !!g && this.live(g, seen) && this.covers(g, e.on);
  }

  /** Does the caller hold the key to this record: the owner, or a hosted person over a record they own? */
  owns(callerId: string, recordId: string): boolean {
    if (callerId === this.owner) return true;
    const owner = this.records.get(recordId)?.owner;
    return !!owner && (owner === callerId || owner === `${this.owner}:${callerId}`);
  }

  /**
   * The audience a caller belongs to (12.4, 14.4): the owner; staff for anyone with a control or admin
   * edge, or an emergency edge; member for anyone the owner has admitted by any live edge; else public.
   */
  audienceOf(callerId: string): string {
    if (callerId === this.owner) return "owner";
    const mine = [...this.edges.values()].filter((e) => e.who === callerId && this.live(e));
    if (mine.some((e) => e.mode === "control" || e.mode === "admin" || e.by === "platform" || e.relation === "emergency")) return "staff";
    return mine.length ? "member" : "public";
  }

  /** The menu items a list of grants expands to (presets open up). */
  expand(grants: string[]): Set<string> {
    const out = new Set<string>();
    for (const g of grants) {
      const p = this.perms.presets.get(g);
      if (p) for (const i of p.items) out.add(i);
      else out.add(g);
    }
    return out;
  }

  /** A caller's access to a record from every live edge on it or an ancestor (14.4). */
  effective(callerId: string, recordId: string): Effective {
    if (this.owns(callerId, recordId)) return { mode: "admin", items: new Set(this.perms.menu.keys()), relations: new Set(["owner"]), gated: false, edges: [] };
    const mine = [...this.edges.values()].filter((e) => e.who === callerId && this.covers(e, recordId) && this.live(e) && this.holds(e, recordId));
    let mode: Mode = "none";
    const items = new Set<string>();
    const relations = new Set<string>();
    let gated = mine.some((e) => e.mode !== "none");
    for (const e of mine) {
      relations.add(e.relation);
      if (rank(e.mode) > rank(mode)) mode = e.mode;
      if (e.mode === "control") for (const i of this.expand(e.grants)) items.add(i);
      if (e.mode !== "none" && !e.gate) gated = false;
    }
    if (mode === "admin") for (const k of this.perms.menu.keys()) items.add(k);
    return { mode, items, relations, gated, edges: mine };
  }

  /** Does the caller stand in a view's partition to the record (12.6, 14.10)? */
  standsIn(callerId: string, recordId: string, partition: string): boolean {
    if (!partition || partition === "none") return true;
    const eff = this.effective(callerId, recordId);
    if (partition === "owned") return this.owns(callerId, recordId);
    if (partition === "administered") return eff.mode === "admin";
    if (partition === "controlled") return rank(eff.mode) >= rank("control");
    const rel = partition.match(/^relation (\S+)$/);
    if (rel) return eff.relations.has(rel[1] as string);
    return false;
  }

  private scopeOk(item: MenuItem, callerId: string, recordId: string, eff: Effective): boolean {
    if (!item.on) return true;
    if (item.on === "owned") return this.owns(callerId, recordId);
    if (item.on === "administered") return eff.mode === "admin";
    const rel = item.on.match(/^relation (\S+)$/);
    if (rel) return eff.relations.has(rel[1] as string);
    const r = this.records.get(recordId);
    const caller = this.records.get(callerId);
    const cond = item.on.replace(/caller\.(\w+)/g, (_, k: string) => JSON.stringify(String(caller?.values[k] ?? "")));
    const vals: JsonObject = { ...(r?.values ?? {}), id: recordId };
    return evaluate(parseCondition(cond), vals) === true;
  }

  /** May the caller do `verb` to `target` on the record (14.4, 14.6)? */
  may(callerId: string, verb: string, target: string, recordId: string): boolean {
    const eff = this.effective(callerId, recordId);
    if (eff.mode === "admin") return true;
    if (eff.mode === "control") {
      for (const name of eff.items) {
        const item = this.perms.menu.get(name);
        if (!item) continue;
        const targets = item.verbs[verb];
        if (!targets || !(targets.includes(target) || targets.includes("*"))) continue;
        if (this.scopeOk(item, callerId, recordId, eff)) return true;
      }
      return false;
    }
    if (eff.mode === "consume") {
      // Take part: run what the package opens to consumers on their own part (the record the consume edge
      // sits on directly), and see what the views show. Changing anything else is a contract's job.
      if (verb === "see") return true;
      return verb === "run" && eff.edges.some((e) => e.mode === "consume" && e.on === recordId);
    }
    if (eff.mode === "view") return verb === "see";
    return false;
  }

  /** May the caller do `verb` to `target` on any record at all: by a live admin edge, or a control edge carrying it? */
  mayAnywhere(callerId: string, verb: string, target: string): boolean {
    if (callerId === this.owner) return true;
    for (const e of this.edges.values()) {
      if (e.who !== callerId || !this.live(e)) continue;
      if (e.mode === "admin") return true;
      if (e.mode !== "control") continue;
      for (const name of this.expand(e.grants)) {
        const t = this.perms.menu.get(name)?.verbs[verb];
        if (t && (t.includes(target) || t.includes("*"))) return true;
      }
    }
    return false;
  }

  /** The live gated edge a caller's access comes through, when every granting edge is gated (14.7). */
  gated(callerId: string, recordId: string): Edge | null {
    const eff = this.effective(callerId, recordId);
    if (!eff.gated) return null;
    return eff.edges.find((e) => e.gate && e.mode !== "none") ?? null;
  }

  /** Refuse an edge the store may not write (14.12, 14.13). */
  checkEdge(e: Edge): void {
    if (!(MODES as readonly string[]).includes(e.mode)) throw new CrubalError(`${e.edge}: a mode is ${MODES.join(", ")}, not ${e.mode}`, e.line);
    if (e.by === "platform") {
      this.checkEmergency(e);
      return;
    }
    if (e.grants.length && e.mode !== "control") throw new CrubalError(`${e.edge}: only a control edge carries grants`, e.line);
    const rel = this.perms.relations.get(e.relation);
    if (this.perms.relations.size && !rel) throw new CrubalError(`${e.edge}: the relation ${e.relation} isn't declared`, e.line);
    if (rel?.only && e.mode !== "none") throw new CrubalError(`${e.edge}: ${e.relation} is a relation only, so its mode is none`, e.line);
    for (const g of e.grants) if (!this.perms.presets.has(g) && !this.perms.menu.has(g)) throw new CrubalError(`${e.edge}: ${g} is neither a preset nor a menu item`, e.line);
    if (foreign(e.who, this.owner) && e.by !== "owner") throw new CrubalError(`${e.edge}: only the owner may grant an edge to another owner's caller`, e.line);
    if (e.by === "owner") return;
    const g = this.edges.get(e.by);
    if (!g) throw new CrubalError(`${e.edge}: granted under ${e.by}, which isn't an edge`, e.line);
    if (rank(e.mode) > rank(g.mode)) throw new CrubalError(`${e.edge}: ${g.edge} holds ${g.mode}, so it can't grant ${e.mode}`, e.line);
    if (!this.covers(g, e.on)) throw new CrubalError(`${e.edge}: ${e.on} is outside ${g.edge}'s reach`, e.line);
    if (g.mode === "control") {
      const held = this.expand(g.grants);
      const grantTargets = new Set([...held].flatMap((n) => this.perms.menu.get(n)?.verbs.grant ?? []));
      const mayGrant = (name: string) => grantTargets.has("*") || grantTargets.has(name);
      for (const name of this.expand(e.grants)) {
        if (!held.has(name)) throw new CrubalError(`${e.edge}: ${g.edge} doesn't hold ${name}`, e.line);
        if (!mayGrant(name)) throw new CrubalError(`${e.edge}: ${g.edge} may not grant ${name}`, e.line);
      }
      if (e.mode !== "none" && !e.grants.length && !mayGrant(e.mode)) throw new CrubalError(`${e.edge}: ${g.edge} may not grant ${e.mode}`, e.line);
    }
  }

  /** Refuse an emergency edge outside the platform's published terms (14.13). */
  checkEmergency(e: Edge): void {
    const terms = this.perms.emergency;
    if (!terms) throw new CrubalError(`${e.edge}: no emergency terms are published, so no emergency edge can be made`, e.line);
    const em = e.emergency;
    if (!em) throw new CrubalError(`${e.edge}: an emergency edge carries its kind, reason, reference and approvals`, e.line);
    if (em.kind !== "legal" && em.kind !== "incident") throw new CrubalError(`${e.edge}: an emergency is legal or incident`, e.line);
    if (!em.reason || !em.reference) throw new CrubalError(`${e.edge}: an emergency edge states its reason and reference`, e.line);
    const approvals = Array.isArray(em.approvals) ? em.approvals.map(String) : [];
    if (approvals.length < terms.approvers) throw new CrubalError(`${e.edge}: ${approvals.length} approvals, the terms require ${terms.approvers}`, e.line);
    if (approvals.includes(e.who)) throw new CrubalError(`${e.edge}: the requester can't approve their own edge`, e.line);
    if (e.mode !== "view" && e.mode !== "control") throw new CrubalError(`${e.edge}: an emergency edge is view or control, never ${e.mode}`, e.line);
    for (const name of this.expand(e.grants)) if (this.perms.menu.get(name)?.verbs.grant) throw new CrubalError(`${e.edge}: an emergency edge never grants`, e.line);
    if (!e.until) throw new CrubalError(`${e.edge}: an emergency edge has an until`, e.line);
    const at = typeof em.at === "string" ? Date.parse(em.at) : Number.NaN;
    if (!Number.isNaN(at) && Date.parse(e.until) - at > durationMs(terms.longest)) throw new CrubalError(`${e.edge}: outlasts the terms' longest, ${terms.longest}`, e.line);
  }

  /** Refuse a person owning a record the package doesn't let a person own (14.1, 14.12). */
  checkOwnership(r: Record): void {
    if (!foreign(r.owner, "") || r.owner.split(":")[0] !== this.owner) return; // a domain owner, or another owner's record
    const allowed = this.perms.ownership.get("person") ?? [];
    const names = [r.kind, ...(r.wears ?? [])];
    if (!names.some((n) => allowed.includes(n))) throw new CrubalError(`${r.id}: a person may own ${allowed.join(", ") || "nothing"}, not a ${r.kind}`);
  }
}

/** Publish checks for a permission block (14.6). */
export function checkPermissions(perms: Permissions, dict: Dictionary, contracts: Set<string> = new Set(), views: Set<string> = new Set()): void {
  for (const item of perms.menu.values()) {
    for (const [verb, targets] of Object.entries(item.verbs)) {
      if (!(VERBS as readonly string[]).includes(verb)) throw new CrubalError(`${item.name}: unknown verb ${verb}`, item.line);
      for (const t of targets) {
        if (t === "*") continue;
        const key = t.replace(/^\w+::/, "");
        const known =
          dict.facets.has(key) || dict.classes.has(t) || dict.levels.has(t) || contracts.has(t) || views.has(t) || perms.menu.has(t) || perms.presets.has(t) ||
          ["arrivals", "vocabulary", "migrations", "gated", "unit", "product", "group"].includes(t);
        if (!known && verb !== "grant") throw new CrubalError(`${item.name}: ${verb} names ${t}, which isn't a facet, class, view, contract or queue`, item.line);
        if (verb === "grant" && !perms.menu.has(t) && !perms.presets.has(t)) throw new CrubalError(`${item.name}: grant names ${t}, which isn't a menu item or preset`, item.line);
      }
    }
  }
  for (const p of perms.presets.values()) for (const i of p.items) if (!perms.menu.has(i)) throw new CrubalError(`${p.name}: ${i} isn't a menu item`, p.line);
}
