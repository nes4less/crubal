// lifecycle.ts: a record's life (spec 1.12), values down the levels with an optional parent (1.7), and
// instructions (10.7). Folded keys are read from the record above; owned keys (the kind's `vary` steps and
// the classes' `level::` lines) belong to the lower record. Attaching folds values up, detaching copies them
// down, archiving snapshots them so history stays true, merging folds one record into another, and
// instructions change which keys lower records hold, pending per record until applied.

import { serialize } from "./canonical.ts";
import type { ClassDef, Dictionary, Facet } from "./defs.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import { readUnder } from "./read-text.ts";
import { land } from "./store.ts";
import { type Node, readTree } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type Instruction = { issuer: string; n: number; op: "+" | "-"; key: string; to?: string; map: [string, string][] };

export type Store = {
  records: Map<string, Record>;
  bindings: Map<string, string>;
  instructions: Map<string, Instruction[]>;
  review: JsonObject[];
};

type Extra = Record & { alternatives?: { [a: string]: JsonObject[] }; suggestions?: { [a: string]: JsonObject[] }; held?: { [a: string]: JsonObject } };

export function emptyStore(): Store {
  return { records: new Map(), bindings: new Map(), instructions: new Map(), review: [] };
}

/** A record's values with everything above it read through (1.7); a record standing alone reads nothing. */
export function effective(records: Map<string, Record>, r: Record): JsonObject {
  const up = r.of ? records.get(r.of) : undefined;
  return { ...(up ? effective(records, up) : {}), ...r.values };
}

function classLines(dict: Dictionary, name: string, seen = new Set<string>()): ClassDef["lines"] {
  if (seen.has(name)) return [];
  seen.add(name);
  const c = dict.classes.get(name);
  if (!c) return [];
  return [...c.uses.flatMap((u) => classLines(dict, u, seen)), ...c.lines];
}

/** The keys a record owns (1.7): its level's vary step, and the `level::` lines of the classes above and on it. */
export function ownedKeys(dict: Dictionary, records: Map<string, Record>, r: Record): Set<string> {
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
export function foldUp(store: Store, lowerId: string, dict: Dictionary, mayEditUpper = true): void {
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
function copyDown(store: Store, r: Extra, dict: Dictionary): Extra {
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

function sourceAbove(store: Store, r: Record, key: string): Source | undefined {
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

function childrenOf(store: Store, id: string, along: "of" | "within"): Record[] {
  return [...store.records.values()].filter((r) => r[along] === id);
}

/** Archive (1.12): snapshot folded values, set the status, cascade as the package says. */
export function archive(store: Store, id: string, reason: string, dict: Dictionary, into?: string): void {
  const r = store.records.get(id) as Extra | undefined;
  if (!r) throw new Error(`no record ${id}`);
  const snap = copyDown(store, r, dict);
  snap.status = { state: "archived", reason, ...(into ? { into } : {}) };
  store.records.set(id, snap);
  const rule = dict.archive.get(r.kind) ?? "independent";
  const along: ("of" | "within")[] = rule === "cascade of" ? ["of"] : rule === "cascade within" ? ["within"] : rule === "cascade both" ? ["of", "within"] : [];
  for (const a of along) for (const c of childrenOf(store, id, a)) if (!c.status) archive(store, c.id, "parent archived", dict);
}

/** Unarchive: back to active; an attached record's copied values fold up again; the cascade is undone. */
export function unarchive(store: Store, id: string, dict: Dictionary): void {
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

/** The issuers whose instructions reach a record: the record above, and the class versions above and on it. */
export function issuersFor(store: Store, r: Record): string[] {
  const out: string[] = [];
  if (r.of) out.push(r.of);
  const up = r.of ? store.records.get(r.of) : undefined;
  const worn = new Set([...(up?.wears ?? []), ...(r.wears ?? [])]);
  for (const issuer of store.instructions.keys()) {
    const m = issuer.match(/^class:([^/]+)\//);
    if (m && worn.has(m[1] as string)) out.push(issuer);
  }
  return out;
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
