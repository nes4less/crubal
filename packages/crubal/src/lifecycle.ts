// lifecycle.ts: a record's life (spec 1.12), values down the levels with an optional parent (1.7), and
// instructions (10.7). Folded keys are read from the record above; owned keys (the kind's `vary` steps and
// the classes' `level::` lines) belong to the lower record. Attaching folds values up, detaching copies them
// down, archiving snapshots them so history stays true, merging folds one record into another, and
// instructions change which keys lower records hold, pending per record until applied.

import { serialize } from "./canonical.ts";
import type { ClassDef, Dictionary, Facet } from "./defs.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import { MemoryRecords, type RecordSet } from "./records.ts";
import { readUnder } from "./read-text.ts";
import { land } from "./store.ts";
import { CrubalError, type Node, readTree } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Instruction = { issuer: string; n: number; op: "+" | "-"; key: string; to?: string; map: [string, string][] };

export type Store = {
  records: RecordSet;
  bindings: Map<string, string>;
  instructions: Map<string, Instruction[]>;
  review: JsonObject[];
};

type Extra = Record & { alternatives?: { [a: string]: JsonObject[] }; suggestions?: { [a: string]: JsonObject[] }; held?: { [a: string]: JsonObject } };

export function emptyStore(): Store {
  return { records: new MemoryRecords(), bindings: new Map(), instructions: new Map(), review: [] };
}

/** A record's values with everything above it read through (1.7); a record standing alone reads nothing. */
export function effective(records: RecordSet, r: Record): JsonObject {
  const up = r.of ? records.get(r.of) : undefined;
  return { ...(up ? effective(records, up) : {}), ...r.values };
}

const isObjV = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The parts a record reads (1.6, "units mirror parts"): the chain's top holds the parts; a record below holds
 * rows with the same keys carrying only the values that vary at its level. Read through, a lower record's
 * part is the part above with its own values over it; a row the record above lacks is its own.
 */
export function effectiveParts(records: RecordSet, r: Record): JsonObject[] {
  const up = r.of ? records.get(r.of) : undefined;
  const above = up ? effectiveParts(records, up) : [];
  const own = (r.parts ?? []).filter(isObjV);
  if (!above.length) return own;
  const byRow = new Map(above.map((p) => [String(p.$row), p]));
  for (const p of own) {
    const row = String(p.$row);
    const have = byRow.get(row);
    if (!have) {
      byRow.set(row, p);
      continue;
    }
    const wears = [...new Set([...(Array.isArray(have.wears) ? have.wears : []), ...(Array.isArray(p.wears) ? p.wears : [])])];
    byRow.set(row, { ...have, ...p, wears, values: { ...(isObjV(have.values) ? have.values : {}), ...(isObjV(p.values) ? p.values : {}) } });
  }
  return [...byRow.values()];
}

/** The keys a record owns on a part it mirrors (1.7 for parts): its level's vary step, and the part classes' `level::` lines at its level. */
export function ownedPartKeys(dict: Dictionary, r: Record, partWears: string[]): Set<string> {
  const keys = new Set(dict.vary.get(r.level) ?? []);
  for (const w of partWears) for (const l of classLines(dict, w)) if (l.level === r.level) keys.add(l.facet);
  return keys;
}

function classLines(dict: Dictionary, name: string, seen = new Set<string>()): ClassDef["lines"] {
  if (seen.has(name)) return [];
  seen.add(name);
  const c = dict.classes.get(name);
  if (!c) return [];
  return [...c.uses.flatMap((u) => classLines(dict, u, seen)), ...c.lines];
}

/** The keys a record owns (1.7): its level's vary step, and the `level::` lines of the classes above and on it. */
export function ownedKeys(dict: Dictionary, records: RecordSet, r: Record): Set<string> {
  const keys = new Set(dict.vary.get(r.level) ?? []);
  const up = r.of ? records.get(r.of) : undefined;
  for (const w of [...(up?.wears ?? []), ...(r.wears ?? [])]) for (const l of classLines(dict, w)) if (l.level === r.level) keys.add(l.facet);
  return keys;
}

function sourceFor(r: Record, key: string): Source | undefined {
  return r.sources?.[key] ?? r.sources?.["*"];
}

function setValue(r: Extra, key: string, v: Json, s: Source | undefined) {
  r.values = { ...r.values, [key]: v };
  if (s) r.sources = { ...(r.sources ?? {}), [key]: s };
}

function dropValue(r: Extra, key: string) {
  const { [key]: _v, ...values } = r.values;
  r.values = values;
  if (r.sources?.[key]) {
    const { [key]: _s, ...sources } = r.sources;
    r.sources = sources;
  }
}

function suggest(r: Extra, key: string, v: Json, s: Source | undefined) {
  const bag = { ...(r.suggestions ?? {}) };
  bag[key] = [...(bag[key] ?? []), { value: v, origin: s?.origin ?? "reported", via: s?.via ?? "" }];
  r.suggestions = bag;
}

const empty = (v: Json | undefined) => v === undefined || (isObj(v) && "$empty" in v);

/**
 * Fold a lower record's folded-key values up into the record above (1.7): the same value is dropped and
 * read through; an empty above is filled; a different value is a conflict for the trust order. Without
 * `edit` on the record above, what would move up lands there as a suggestion and the lower record keeps
 * its value.
 */
export function foldUp(store: Records, lowerId: string, dict: Dictionary, mayEditUpper = true): void {
  const lower = store.records.get(lowerId) as Extra | undefined;
  const upper = lower?.of ? (store.records.get(lower.of) as Extra | undefined) : undefined;
  if (!lower || !upper) return;
  const owned = ownedKeys(dict, store.records, lower);
  let up: Extra = { ...upper };
  const low: Extra = { ...lower };
  const upValues = effective(store.records, upper);
  for (const [key, v] of Object.entries(lower.values)) {
    if (owned.has(key)) continue;
    const s = sourceFor(lower, key);
    const above = upValues[key];
    if (!empty(above) && serialize(above as Json) === serialize(v)) {
      dropValue(low, key);
      continue;
    }
    if (!mayEditUpper) {
      suggest(up, key, v, s);
      continue;
    }
    if (empty(above)) {
      setValue(up, key, v, s);
      dropValue(low, key);
      continue;
    }
    up = land(up, { outcomes: [{ from: key, to: key, outcome: "conflict", value: v }] }, s ?? { origin: "reported", via: "" }, dict.trust, dict.facetTrust) as Extra;
    dropValue(low, key);
  }
  store.records.set(up.id, up);
  store.records.set(low.id, low);
}

/** Attach a standing-alone record to the record above it, then fold its values up. */
export function attach(store: Store, lowerId: string, upperId: string, dict: Dictionary, mayEditUpper = true): void {
  const lower = store.records.get(lowerId);
  if (!lower) throw new Error(`no record ${lowerId}`);
  if (!store.records.has(upperId)) throw new Error(`no record ${upperId}`);
  store.records.set(lowerId, { ...lower, of: upperId });
  foldUp(store, lowerId, dict, mayEditUpper);
}

/** Copy every folded value onto the record, with its source, then clear `of`. */
function copyDown(store: Records, r: Extra, dict: Dictionary): Extra {
  const up = r.of ? store.records.get(r.of) : undefined;
  if (!up) return r;
  const owned = ownedKeys(dict, store.records, r);
  const out: Extra = { ...r, values: { ...r.values }, sources: { ...(r.sources ?? {}) } };
  for (const [key, v] of Object.entries(effective(store.records, up))) {
    if (owned.has(key) || out.values[key] !== undefined) continue;
    out.values[key] = v;
    const s = sourceAbove(store, up, key);
    if (s) (out.sources as { [a: string]: Source })[key] = s;
  }
  if (!Object.keys(out.sources ?? {}).length) delete out.sources;
  return out;
}

function sourceAbove(store: Records, r: Record, key: string): Source | undefined {
  if (r.values[key] !== undefined) return sourceFor(r, key);
  const up = r.of ? store.records.get(r.of) : undefined;
  return up ? sourceAbove(store, up, key) : undefined;
}

/** Detach: the record keeps working as it was. */
export function detach(store: Store, lowerId: string, dict: Dictionary): void {
  const r = store.records.get(lowerId) as Extra | undefined;
  if (!r?.of) return;
  const copied = copyDown(store, r, dict);
  delete copied.of;
  store.records.set(lowerId, copied);
}

function childrenOf(store: Records, id: string, along: "of" | "within"): Record[] {
  return store.records.childrenOf(id, along);
}

/**
 * Adopt a value (8.2): it stops following its rule or presenter; the source gains `adopted`. A `must`
 * production refuses; a `should` one is flagged (the caller decides what to do with the flag).
 */
export function adopt(store: Store, id: string, address: string, rules: { produces?: { key: string }; strength: string; name: string }[] = []): { flagged?: string } {
  const r = store.records.get(id);
  if (!r) throw new CrubalError(`no record ${id}`);
  if (r.values[address] === undefined) throw new CrubalError(`${id} has no value at ${address} to adopt`);
  const rule = rules.find((x) => x.produces?.key === address);
  if (rule?.strength === "must") throw new CrubalError(`${address} is produced by ${rule.name}, a must rule: it can't be adopted`);
  const was = (r.sources?.[address] ?? r.sources?.["*"] ?? { origin: "reported", via: "" }) as Source;
  store.records.set(id, { ...r, sources: { ...(r.sources ?? {}), [address]: { ...was, adopted: true } } });
  return rule?.strength === "should" ? { flagged: rule.name } : {};
}

/**
 * Split (1.12): a new record minted beside the origin, the named children moved under it (`of`), the
 * named values written on it with the origin's sources where it has them, the named bindings moved. The
 * reverse of a merge names what the merge brought; a version split names the instances that disagreed.
 */
export function split(store: Store, fromId: string, into: string, what: { children?: string[]; values?: JsonObject; bindings?: string[] }, source: Source = { origin: "declared", via: "split" }): Record {
  const origin = store.records.get(fromId);
  if (!origin) throw new CrubalError(`no record ${fromId}`);
  if (store.records.has(into)) throw new CrubalError(`${into} exists`);
  const values: JsonObject = {};
  const sources: { [a: string]: Source } = {};
  for (const [k, v] of Object.entries(what.values ?? {})) {
    values[k] = v;
    const own = origin.sources?.[k] ?? origin.sources?.["*"];
    sources[k] = origin.values[k] !== undefined && serialize(origin.values[k] as Json) === serialize(v) && own ? { ...own } : { ...source };
  }
  const next: Record = { id: into, kind: origin.kind, level: origin.level, owner: origin.owner, values, sources };
  if (origin.of) next.of = origin.of;
  if (origin.within) next.within = origin.within;
  if (origin.wears) next.wears = [...origin.wears];
  store.records.set(into, next);
  for (const id of what.children ?? []) {
    const c = store.records.get(id);
    if (!c) throw new CrubalError(`no record ${id}`);
    if (c.of !== fromId) throw new CrubalError(`${id} isn't of ${fromId}`);
    store.records.set(id, { ...c, of: into });
  }
  for (const key of what.bindings ?? []) {
    if (store.bindings.get(key) !== fromId) throw new CrubalError(`${key} isn't bound to ${fromId}`);
    store.bindings.set(key, into);
  }
  return next;
}

/** Give an adopted value back (8.2): the mark goes, and the next rule run or update replaces it. */
export function giveBack(store: Store, id: string, address: string): void {
  const r = store.records.get(id);
  if (!r) throw new CrubalError(`no record ${id}`);
  const s = r.sources?.[address];
  if (!s?.adopted) throw new CrubalError(`${id} hasn't adopted ${address}`);
  const { adopted: _a, ...rest } = s;
  store.records.set(id, { ...r, sources: { ...(r.sources ?? {}), [address]: rest as Source } });
}

/** Adopt another owner's whole record (8.2): a new record of ours, every value with its source, linked by crubal:clonedFrom. */
export function clone(store: Store, fromId: string, newId: string, owner: string): Record {
  const r = store.records.get(fromId);
  if (!r) throw new CrubalError(`no record ${fromId}`);
  if (store.records.has(newId)) throw new CrubalError(`${newId} exists`);
  const sources: { [a: string]: Source } = {};
  for (const k of Object.keys(r.values)) {
    const s = (r.sources?.[k] ?? r.sources?.["*"] ?? { origin: "reported", via: "" }) as Source;
    sources[k] = { ...s, ...(s.owner || r.owner === owner ? {} : { owner: r.owner }) };
  }
  const link = `${r.owner === owner ? "" : `${r.owner}:`}${fromId}`;
  const next: Record = { id: newId, kind: r.kind, level: r.level, owner, values: { ...r.values, "crubal:clonedFrom": { $link: link } }, sources: { ...sources, "crubal:clonedFrom": { origin: "declared", via: "clone" } } };
  if (r.wears) next.wears = [...r.wears];
  if (r.parts) next.parts = structuredClone(r.parts);
  store.records.set(newId, next);
  return next;
}

/** Archive (1.12): snapshot folded values, set the status, cascade as the package says. */
/** What the lifecycle operations touch: the record set. A store's draft and a commit's draft both qualify. */
export type Records = Pick<Store, "records">;

export function archive(store: Records, id: string, reason: string, dict: Dictionary, into?: string): void {
  const r = store.records.get(id) as Extra | undefined;
  if (!r) throw new Error(`no record ${id}`);
  const snap: Extra = { ...copyDown(store, r, dict) };
  snap.status = { state: "archived", reason, ...(into ? { into } : {}) };
  store.records.set(id, snap);
  const rule = dict.archive.get(r.kind) ?? "independent";
  const along: ("of" | "within")[] = rule === "cascade of" ? ["of"] : rule === "cascade within" ? ["within"] : rule === "cascade both" ? ["of", "within"] : [];
  for (const a of along) for (const c of childrenOf(store, id, a)) if (!c.status) archive(store, c.id, "parent archived", dict);
}

/** Unarchive: back to active; an attached record's copied values fold up again; the cascade is undone. */
export function unarchive(store: Records, id: string, dict: Dictionary): void {
  const r = store.records.get(id) as Extra | undefined;
  if (!r?.status) return;
  const { status: _s, ...rest } = r;
  store.records.set(id, rest as Extra);
  if (rest.of) foldUp(store, id, dict, true);
  for (const along of ["of", "within"] as const) for (const c of childrenOf(store, id, along)) if (c.status?.reason === "parent archived") unarchive(store, c.id, dict);
}

/** Merge: the loser's values fold into the survivor under the trust order; the loser is archived as merged. */
export function merge(store: Store, loserId: string, survivorId: string, dict: Dictionary): void {
  const loser = store.records.get(loserId) as Extra | undefined;
  let survivor = store.records.get(survivorId) as Extra | undefined;
  if (!loser || !survivor) throw new Error(`merge needs both ${loserId} and ${survivorId}`);
  for (const [key, v] of Object.entries(loser.values)) {
    const s = sourceFor(loser, key) ?? { origin: "reported", via: "" };
    const current = survivor.values[key];
    const outcome = empty(current) ? "absorbed" : serialize(current as Json) === serialize(v) ? "absorbed" : "conflict";
    survivor = land(survivor, { outcomes: [{ from: key, to: key, outcome, value: v }] }, s, dict.trust, dict.facetTrust) as Extra;
  }
  store.records.set(survivorId, survivor);
  for (const c of childrenOf(store, loserId, "of")) store.records.set(c.id, { ...c, of: survivorId });
  for (const c of childrenOf(store, loserId, "within")) store.records.set(c.id, { ...c, within: survivorId });
  for (const [k, v] of store.bindings) if (v === loserId) store.bindings.set(k, survivorId);
  store.records.set(loserId, { ...loser, status: { state: "archived", reason: "merged", into: survivorId } });
}

// ─── Instructions (10.7) ─────────────────────────────────────────────────────

const unq = (s: string) => (s.trim().startsWith('"') ? (JSON.parse(s.trim()) as string) : s.trim());

/** Read instruction lines (`+key`, `-key`, `-key -> other` with value maps below) for one issuer. */
export function readInstructions(issuer: string, lines: Node[], from = 0): Instruction[] {
  return lines.map((l, i) => {
    const text = l.text.trim().replace(/^\d+:\s*/, "");
    const op = text[0] === "+" ? "+" : text[0] === "-" ? "-" : null;
    if (!op) throw new Error(`an instruction is +key, -key or -key -> other: ${text}`);
    const body = text.slice(1).trim();
    const at = body.indexOf(" -> ");
    const key = at < 0 ? body : body.slice(0, at).trim();
    const to = at < 0 ? undefined : body.slice(at + 4).trim();
    const map = l.children.map((c): [string, string] => {
      const m = c.text.indexOf(" -> ");
      if (m < 0) throw new Error(`a value map is "theirs -> ours": ${c.text}`);
      return [unq(c.text.slice(0, m)), unq(c.text.slice(m + 4))];
    });
    return { issuer, n: from + i + 1, op, key, ...(to ? { to } : {}), map };
  });
}

/** Read `instructions: <issuer>` blocks. */
export function readInstructionBlocks(source: string): Map<string, Instruction[]> {
  const out = new Map<string, Instruction[]>();
  for (const n of readTree(source)) {
    if (n.kind !== "pair" || n.key !== "instructions") continue;
    const issuer = n.value.trim();
    out.set(issuer, [...(out.get(issuer) ?? []), ...readInstructions(issuer, n.children, out.get(issuer)?.length ?? 0)]);
  }
  return out;
}

/** Issue instructions from a record or a class version; they are numbered on from the issuer's last. */
export function issue(store: Store, issuer: string, lines: Node[]): Instruction[] {
  const have = store.instructions.get(issuer) ?? [];
  const added = readInstructions(issuer, lines, have.length);
  store.instructions.set(issuer, [...have, ...added]);
  return added;
}

/**
 * The issuers whose instructions reach a record, in the order they apply (10.7): the record above, then
 * its kind's versions, then the class versions above and on it, each group by name then version.
 */
export function issuersFor(store: Store, r: Record): string[] {
  const out: string[] = [];
  if (r.of) out.push(r.of);
  const up = r.of ? store.records.get(r.of) : undefined;
  const worn = new Set([...(up?.wears ?? []), ...(r.wears ?? [])]);
  const kinds: string[] = [];
  const classes: string[] = [];
  for (const issuer of store.instructions.keys()) {
    const k = issuer.match(/^kind:([^/]+)\//);
    if (k && k[1] === r.kind) kinds.push(issuer);
    const c = issuer.match(/^class:([^/]+)\//);
    if (c && worn.has(c[1] as string)) classes.push(issuer);
  }
  return [...out, ...kinds.sort(), ...classes.sort()];
}

/** The instructions a record hasn't applied yet, in issuer order then number. */
export function pending(store: Store, r: Record): Instruction[] {
  return issuersFor(store, r).flatMap((issuer) => (store.instructions.get(issuer) ?? []).filter((i) => i.n > (r.applied?.[issuer] ?? 0)));
}

function plain(v: Json): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (isObj(v)) {
    if ("$value" in v) return plain(v.$value as Json);
    if ("$link" in v) return `&${v.$link}`;
    if ("$qty" in v) return `${v.$qty}${v.unit}`;
    if ("$money" in v) return `${v.$money}${v.currency}`;
    if ("$empty" in v) return v.$empty === "unknown" ? "_" : "-";
  }
  return serialize(v);
}

/** Apply a record's pending instructions, in order; an archived record is skipped. */
export function apply(store: Store, id: string, dict: Dictionary): Instruction[] {
  const r = store.records.get(id) as Extra | undefined;
  if (!r || r.status?.state === "archived") return [];
  const todo = pending(store, r);
  const out: Extra = { ...r, values: { ...r.values }, sources: { ...(r.sources ?? {}) }, applied: { ...(r.applied ?? {}) } };
  for (const i of todo) {
    const via = `${i.issuer}#${i.n}`;
    if (i.op === "+") {
      if (out.values[i.key] === undefined) setValue(out, i.key, { $empty: "unknown" }, { origin: "declared", via });
    } else {
      const v = out.values[i.key];
      const s = sourceFor(out, i.key);
      dropValue(out, i.key);
      if (i.to && v !== undefined) {
        const f: Facet | undefined = dict.facets.get(i.to);
        if (!i.map.length) setValue(out, i.to, v, s);
        else {
          const hit = i.map.find(([theirs]) => theirs === plain(v));
          if (!hit) {
            store.review.push({ record: id, address: i.key, instruction: `${via} -${i.key} -> ${i.to}`, value: v, reason: "no value map for this value", held: true });
            out.held = { ...(out.held ?? {}), [i.key]: { value: v, instruction: via } };
          } else if (hit[1] === "-") setValue(out, i.to, { $empty: "n/a" }, s);
          else setValue(out, i.to, (f ? readUnder(f, hit[1], dict) : undefined) ?? hit[1], s);
        }
      }
    }
    (out.applied as { [k: string]: number })[i.issuer] = i.n;
  }
  if (!Object.keys(out.sources ?? {}).length) delete out.sources;
  if (!Object.keys(out.applied ?? {}).length) delete out.applied;
  store.records.set(id, out);
  return todo;
}
