// store.ts: the Store level (spec chapters 8 and 9). Hash-linked logs (8.5), intake through a receive
// contract with raw bytes kept (9.1–9.4), landing values by the trust order with alternatives (8.4),
// matching parts before minting rows (9.2), and evidence validation with independence and vetoes (9.7).

import { createHash, createPublicKey, verify } from "node:crypto";
import { serialize } from "./canonical.ts";
import { type ClassLine, type Dictionary, type Facet, readClassLine, unquote } from "./defs.ts";
import { checkScalar, foldKey, foldValue } from "./dictionary.ts";
import { splitTop } from "./lex.ts";
import type { Json, JsonObject, Record, Source } from "./model.ts";
import { readUnder } from "./read-text.ts";
import { CrubalError, readTree } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

// ─── Logs (8.5) ──────────────────────────────────────────────────────────────

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A write's hash: SHA-256 of its canonical form; a redacted write's hash is what it carries (8.5.2). */
export function writeHash(w: Json): string {
  if (isObj(w) && typeof w.redacted === "string") return w.redacted.replace(/^sha256:/, "");
  return sha256(serialize(w));
}

/**
 * An entry's hash (8.5): SHA-256 of its canonical form without `sig`, each write replaced by `sha256:` and
 * its own hash, so a redacted write leaves the entry's hash where it was. A redacted entry's hash is what it
 * carries.
 */
export function entryHash(entry: JsonObject): string {
  if (typeof entry.redacted === "string") return entry.redacted.replace(/^sha256:/, "");
  const { sig: _sig, ...rest } = entry;
  if (Array.isArray(rest.writes)) rest.writes = rest.writes.map((w) => `sha256:${writeHash(w)}`);
  return sha256(serialize(rest));
}

/** Published keys by owner domain: `{ "test.example": { "alg": "Ed25519", "public": "<base64url>" } }`. */
/** A published signing key (11.7): with `from` and `until` when it was rotated, so it still verifies what it signed. */
export type Key = { alg: string; public: string; from?: string; until?: string };
export type Keys = { [owner: string]: Key | Key[] };

/** The owner's key in force at a moment: the one whose span holds `at`, else an undated one, else the latest. */
export function keyFor(keys: Keys, owner: string, at?: string): Key | undefined {
  const k = keys[owner];
  if (!k) return undefined;
  const list = Array.isArray(k) ? k : [k];
  if (at) {
    const spans = list.filter((x) => (!x.from || x.from <= at) && (!x.until || at < x.until));
    if (spans.length) return spans.at(-1);
  }
  return list.find((x) => !x.from && !x.until) ?? list.at(-1);
}

/** Does `sig` (base64url) verify over the entry's hash bytes with the owner's Ed25519 key? */
export function verifySig(entry: JsonObject, owner: string, keys: Keys): boolean {
  const k = keyFor(keys, owner, typeof entry.at === "string" ? entry.at : undefined);
  if (!k || k.alg !== "Ed25519" || typeof entry.sig !== "string") return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.public }, format: "jwk" });
  return verify(null, Buffer.from(entryHash(entry), "hex"), key, Buffer.from(entry.sig, "base64url"));
}

/** Check a chain's links, and, when the owner's key is known, every entry's signature (8.5). */
export function verifyChain(entries: JsonObject[], keys?: Keys): { valid: boolean; "breaks-at"?: string; reason?: string } {
  let owner = "";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as JsonObject;
    if (i > 0 && e.prev !== `sha256:${entryHash(entries[i - 1] as JsonObject)}`) return { valid: false, "breaks-at": String(e.log), reason: "link" };
    if (typeof e.owner === "string") owner = e.owner;
    if (keys?.[owner] && !verifySig(e, owner, keys)) return { valid: false, "breaks-at": String(e.log), reason: "signature" };
  }
  return { valid: true };
}

// ─── Receive contracts, as intake needs them (7.2, 7.3, 9.4) ─────────────────

export type MapLine = { from: string; to: string; values: [string, string][]; line: number; valueLines: number[] };

export type Contract = {
  name: string;
  kind: string;
  origin: string;
  prefix?: string;
  reads: MapLine[];
  writes: MapLine[];
  /** A store contract's one map (7.3): `reads` and `writes` are derived from it. */
  stores: MapLine[];
  /** An offer's terms (7.8): reshare, expires, revocable, and what else the package names. */
  terms: { [term: string]: string };
  ignore: string[];
  keepRaw: string[];
  absorb: boolean;
  lands: string;
  line: number;
  /** needs: an unnamed class (7.2) */
  needs: ClassLine[];
  gives: string[];
  who?: string;
  when?: string;
  from?: string;
  to?: string;
  mode?: string;
  undo?: string;
  /** The field of their payload that is their own ID for the thing (9.2a). */
  ref?: string;
  /** For a send contract that carries projection streams (12.6.2): the views. */
  stream: string[];
  /** Every part as written, with its line, for the publish checks. */
  parts: { [k: string]: string };
  partLines: { [k: string]: number };
};

function readMap(lines: ReturnType<typeof readTree>): MapLine[] {
  return lines.map((l) => {
    const [from, to] = splitArrow(l.text, l.line);
    const values = l.children.map((c) => splitArrow(c.text, c.line).map(unq) as [string, string]);
    return { from, to, values, line: l.line, valueLines: l.children.map((c) => c.line) };
  });
}

function splitArrow(text: string, line: number): [string, string] {
  const at = text.indexOf(" -> ");
  if (at < 0) throw new CrubalError(`a map line is "from -> to": ${text}`, line);
  return [text.slice(0, at).trim(), text.slice(at + 4).trim()];
}

const unq = (s: string) => (s.startsWith('"') ? (JSON.parse(s) as string) : s);

/** Read `contract:` blocks. */
export function readContracts(source: string): Contract[] {
  const out: Contract[] = [];
  for (const node of readTree(source)) {
    if (node.kind !== "pair" || node.key !== "contract") continue;
    const c: Contract = {
      name: node.value.trim(),
      kind: "receive",
      origin: "",
      reads: [],
      writes: [],
      stores: [],
      terms: {},
      ignore: [],
      keepRaw: [],
      absorb: true,
      lands: "value",
      line: node.line,
      needs: [],
      gives: [],
      stream: [],
      parts: {},
      partLines: {},
    };
    for (const p of node.children) {
      if (!p.key) continue;
      c.partLines[p.key] = p.line;
      const list = () => splitTop(p.value, ",", p.line).filter(Boolean);
      if (p.key === "needs") {
        // Needs are an unnamed class (5.8): its lines, placed by the same sections (5.3.3, 7.7).
        if (p.value) c.needs = splitTop(p.value, ",", p.line).map((t) => readClassLine(t, p.line));
        else {
          let section: string | undefined;
          for (const l of p.children) {
            if (l.kind === "pair" && l.key === "section") {
              section = unq(l.value);
              continue;
            }
            c.needs.push(readClassLine(l.text, l.line, section));
          }
        }
        continue;
      }
      if (p.key === "gives") c.gives = list();
      else if (p.key === "who") c.who = p.value;
      else if (p.key === "when") c.when = p.value;
      else if (p.key === "from") c.from = p.value;
      else if (p.key === "to") c.to = p.value;
      else if (p.key === "mode") c.mode = p.value;
      else if (p.key === "undo") c.undo = p.value;
      else if (p.key === "ref") c.ref = p.value;
      else if (p.key === "stream") c.stream = list();
      else if (p.key === "terms") {
        // `terms:` with one term per line, or `terms: reshare no, expires 2027-01-01` on the line.
        for (const t of p.children) if (t.key) c.terms[t.key] = t.value.trim();
        for (const t of list()) { const [k, ...v] = t.trim().split(/[:\s]+/); if (k && v.length) c.terms[k] = v.join(" "); }
      }
      if (p.key === "kind") c.kind = p.value;
      else if (p.key === "origin") c.origin = p.value;
      else if (p.key === "prefix") c.prefix = p.value;
      else if (p.key === "reads") c.reads = readMap(p.children);
      else if (p.key === "writes") c.writes = readMap(p.children);
      else if (p.key === "stores") {
        // Written, ourAddress -> theirField; read, the same lines the other way, value maps too.
        c.stores = readMap(p.children);
        c.writes = c.stores.map((m) => ({ ...m, values: [...m.values] }));
        c.reads = c.stores.map((m) => ({ from: m.to, to: m.from, values: m.values.map(([ours, theirs]) => [theirs, ours] as [string, string]), line: m.line, valueLines: m.valueLines }));
      }
      else if (p.key === "ignore") c.ignore = list();
      else if (p.key === "keep-raw") c.keepRaw = list();
      else if (p.key === "absorb") c.absorb = p.value !== "no";
      else if (p.key === "lands") c.lands = p.value;
      // Free text the printer may have quoted (2.5) reads back as text; every other part is kept as written.
      if (!["kind", "origin", "prefix", "reads", "writes", "stores", "ignore", "keep-raw", "absorb", "lands", "gives", "who", "when", "from", "mode", "undo", "ref", "stream", "terms"].includes(p.key)) c.parts[p.key] = p.key === "label" || p.key === "describe" ? unquote(p.value) : p.value;
    }
    if (!c.origin) c.origin = c.kind === "form" ? "declared" : "reported";
    if (c.keepRaw.length && !c.prefix) throw new CrubalError(`${c.name} keeps raw fields, so it needs a prefix`, c.line);
    // A form's fields are its needs (7.7): with no reads of its own, each answer lands on its facet by name.
    if (c.kind === "form" && !c.reads.length && c.needs.length) c.reads = c.needs.map((l) => ({ from: l.facet, to: l.facet, values: [] as [string, string][], line: l.line, valueLines: [] }));
    out.push(c);
  }
  return out;
}

/** Split a field path into names: `aspects."Run Time"` → ["aspects", "Run Time"]. */
export function fieldPath(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i] as string;
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "." && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Write a payload's field name as a path segment, quoted when it isn't a plain name. */
function segment(name: string): string {
  return /^[A-Za-z_]\w*$/.test(name) ? name : JSON.stringify(name);
}

/** A value in one of chapter 3's object forms (`$link`, `$image`, `$qty`, `$money`, `$value`, `$empty`): a leaf, not a nesting. */
const valueObject = (v: Json): boolean => isObj(v) && Object.keys(v).some((k) => k.startsWith("$"));

function leaves(obj: Json, prefix = "", whole: (path: string) => boolean = () => false): [string, Json][] {
  if (!isObj(obj) || valueObject(obj)) return [[prefix, obj]];
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${segment(k)}` : segment(k);
    // An object at a path the contract maps as one field (a compound answer, chapter 3) is one leaf.
    return isObj(v) && !valueObject(v) && !whole(p) ? leaves(v, p, whole) : ([[p, v]] as [string, Json][]);
  });
}

function samePath(a: string, b: string): boolean {
  return serialize(fieldPath(a)) === serialize(fieldPath(b));
}

// ─── Intake (9.1–9.4) ────────────────────────────────────────────────────────

export type IntakeOutcome = { from: string; to?: string; outcome: string; value?: Json; cites?: JsonObject };

export type IntakeRecord = {
  intake: string;
  contract: string;
  for: string;
  received?: string;
  raw: { type: string; sha256: string; body: string };
  outcomes: IntakeOutcome[];
};

/** Fold one raw value through the map's value map, the aliases and the shapes, then check it (9.2). */
function foldIn(f: Facet, raw: Json, map: MapLine | undefined, dict: Dictionary): { value: Json; outcome: string; cites?: JsonObject } {
  // Chapter 3's forms arrive as values: a boolean for a yes-no, an object with a `$` key, and a list read item
  // by item. Anything else is text, read under the facet (chapter 2) after the map's value map and the aliases.
  let childProblem: string | undefined;
  const one = (r: Json): Json => {
    if (valueObject(r) || (typeof r === "boolean" && f.type === "yes-no")) return r;
    // A compound answer as an object (chapter 3): each child folded under its own facet; a child that
    // contradicts its facet contradicts the whole answer, and the outcome names the child.
    if (f.type === "compound" && isObj(r)) {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(r)) {
        const child = f.children?.get(k);
        if (!child) {
          out[k] = v;
          continue;
        }
        const folded = foldIn(child, v, undefined, dict);
        if (folded.outcome === "contradiction") childProblem = childProblem ?? child.key;
        out[k] = folded.value;
      }
      return out;
    }
    let text = typeof r === "string" ? r : serialize(r);
    const vm = map?.values.find(([theirs]) => theirs === text);
    if (vm) text = vm[1];
    return readUnder(f, text, dict) ?? text;
  };
  const read = Array.isArray(raw)
    ? raw.flatMap((r) => {
        const x = one(r);
        return Array.isArray(x) ? x : [x];
      })
    : one(raw);
  const value = foldValue(f, read, dict);
  const items = Array.isArray(value) ? value : [value];
  const checks = items.map((i) => checkScalar(f, i));
  if (childProblem) return { value, outcome: "contradiction", cites: { type: childProblem } };
  const outcome = checks.some((c) => c.outcome === "contradiction") ? "contradiction" : checks.some((c) => c.outcome === "new") ? "new" : "absorbed";
  const unit = checks.find((c) => c.cites?.unit)?.cites;
  return { value, outcome, ...(unit ? { cites: unit } : {}) };
}

/** Keep a payload's exact bytes (3.8): as text when they are valid UTF-8, otherwise as base64. */
export function rawOf(bytes: Uint8Array, type: string): { type: string; sha256: string; body?: string; base64?: string } {
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    return { type, sha256: hash, body: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { type, sha256: hash, base64: Buffer.from(bytes).toString("base64") };
  }
}

/** Replay an intake record from its kept bytes under the current contract (9.6); earlier outcomes stay. */
export function replay(intake: IntakeRecord & { replays?: JsonObject[] }, c: Contract, dict: Dictionary): IntakeRecord & { replays: JsonObject[] } {
  const again = receive(c, intake.raw.body, intake.for, dict, intake.intake);
  const replays = [...(intake.replays ?? []), { outcomes: again.outcomes as unknown as Json, contract: c.name }];
  return { ...intake, replays };
}

/** Review by key across every intake record (9.5), and candidate facets proposed by recurrence. */
export function reviewByKey(intakes: { for: string; outcomes: IntakeOutcome[] }[], recur = 5): { "by-key": JsonObject[]; proposals: JsonObject[] } {
  const groups = new Map<string, { objects: Set<string>; values: Set<string>; outcome: string }>();
  for (const i of intakes) {
    for (const o of i.outcomes) {
      if (o.outcome !== "unknown" && o.outcome !== "new") continue;
      // A unit question (11.9) is reviewed by spelling, across every facet it reached.
      const key = o.cites?.unit ? `unit:${String(o.cites.unit)}` : (o.to ?? o.from);
      const g = groups.get(key) ?? { objects: new Set<string>(), values: new Set<string>(), outcome: o.outcome };
      g.objects.add(i.for);
      if (o.value !== undefined) g.values.add(serialize(o.value));
      groups.set(key, g);
    }
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].objects.size - a[1].objects.size || a[0].localeCompare(b[0]));
  return {
    "by-key": rows.map(([key, g]) => ({ key, objects: g.objects.size, values: g.values.size, outcome: g.outcome })),
    // Only keys no facet holds become candidate facets; a facet's new values go to vocabulary review.
    proposals: rows.filter(([, g]) => g.outcome === "unknown" && g.objects.size >= recur).map(([key, g]) => ({ key, objects: g.objects.size, state: "candidate" })),
  };
}

/** Receive a raw payload through a contract: every field gets exactly one outcome. The bytes are kept. */
export function receive(c: Contract, body: string, forRecord: string, dict: Dictionary, intakeId = "I-1"): IntakeRecord {
  const payload = JSON.parse(body) as Json;
  const outcomes: IntakeOutcome[] = [];
  for (const [path, raw] of leaves(payload, "", (p) => c.reads.some((m) => samePath(m.from, p)))) {
    // An empty string is no answer (chapter 3: what is absent stays absent); an empty is written as `$empty`.
    if (raw === "") {
      outcomes.push({ from: path, outcome: "ignored" });
      continue;
    }
    if (!c.absorb || c.ignore.some((i) => samePath(i, path))) {
      outcomes.push({ from: path, outcome: "ignored" });
      continue;
    }
    const map = c.reads.find((m) => samePath(m.from, path));
    if (map) {
      const f = dict.facets.get(map.to);
      if (!f) {
        outcomes.push({ from: path, to: map.to, outcome: "unknown", value: raw });
        continue;
      }
      const { value, outcome, cites } = foldIn(f, raw, map, dict);
      outcomes.push({ from: path, to: map.to, outcome, value, ...(outcome === "contradiction" ? { cites: cites ?? { type: f.key } } : cites ? { cites } : {}) });
      continue;
    }
    if (c.keepRaw.some((k) => samePath(k, path))) {
      const name = fieldPath(path).at(-1) as string;
      if (!/^[A-Za-z_]\w*$/.test(name)) throw new CrubalError(`the raw field ${path} needs a map line: ${name} isn't a key name`, c.line);
      outcomes.push({ from: path, to: `${c.prefix}:${name}`, outcome: "unknown", value: raw });
      continue;
    }
    outcomes.push({ from: path, outcome: "unknown" });
  }
  return {
    intake: intakeId,
    contract: c.name,
    for: forRecord,
    raw: { type: "application/json", sha256: sha256(body), body },
    outcomes,
  };
}

// ─── Landing values: trust and alternatives (8.4, 9.3) ───────────────────────

const DEFAULT_TRUST = ["person", "observed", "declared", "reported", "derived"];

/** Who a source is, for the trust order (11.3): a person, a contract, a party's domain, and its origin. */
export type Who = { source: Source; person?: boolean; contract?: string };

function matchAt(who: Who, order: string[]): number {
  const hits = [who.person ? "person" : "", who.contract ?? "", who.source.owner ?? "", who.source.origin].filter(Boolean);
  const at = order.findIndex((e) => hits.includes(e));
  return at;
}

/** A source's rank under a facet's order then the package's (lower wins). */
function rank(who: Who, trust: string[], facetOrder: string[] = []): number {
  const f = matchAt(who, facetOrder);
  if (f >= 0) return f;
  const p = matchAt(who, trust);
  return facetOrder.length + (p >= 0 ? p : trust.length);
}

function sourceAt(r: Record, address: string): Source | undefined {
  return r.sources?.[address] ?? r.sources?.["*"];
}

/**
 * Land an intake record's outcomes on a record. Absorbed and conflicting values go through the trust
 * order: the winner is current, the loser is kept as an alternative. Equal values are agreement.
 */
export function land(
  r: Record,
  intake: { outcomes: IntakeOutcome[]; contract?: string; /** a person's write through a form (11.3): ranks as `person` */ person?: boolean },
  source: Source,
  trust: string[] = DEFAULT_TRUST,
  facetTrust: Map<string, string[]> = new Map(),
): Record {
  const order = trust.length ? trust : DEFAULT_TRUST;
  const incoming: Who = { source, ...(intake.contract ? { contract: intake.contract } : {}), ...(intake.person ? { person: true } : {}) };
  const out: Record & { alternatives?: { [a: string]: JsonObject[] } } = {
    ...r,
    values: { ...r.values },
    sources: { ...(r.sources ?? {}) },
  };
  for (const o of intake.outcomes) {
    if (!o.to || o.value === undefined || !["absorbed", "conflict", "new"].includes(o.outcome)) continue;
    const current = out.values[o.to];
    if (current === undefined || (isObj(current) && current.$empty === "unknown")) {
      out.values[o.to] = o.value;
      (out.sources as { [a: string]: Source })[o.to] = source;
      continue;
    }
    if (serialize(current) === serialize(o.value)) continue; // agreement: the current source stays
    const was = sourceAt(out, o.to) as Source;
    const fo = facetTrust.get(o.to) ?? [];
    const incomingWins = rank(incoming, order, fo) < rank({ source: was }, order, fo);
    const loser: JsonObject = incomingWins ? { value: current, origin: was.origin, via: was.via } : { value: o.value, origin: source.origin, via: source.via };
    if (incomingWins) {
      out.values[o.to] = o.value;
      (out.sources as { [a: string]: Source })[o.to] = source;
    }
    out.alternatives = { ...(out.alternatives ?? {}) };
    out.alternatives[o.to] = [...(out.alternatives[o.to] ?? []), loser];
  }
  return out;
}

// ─── Matching parts before minting rows (9.2) ────────────────────────────────

export type PartMatch = { parts: JsonObject[]; review: JsonObject[] };

/** Bind incoming parts to existing ones: by the slot's match child, else review, else a new row. */
export function matchParts(r: Record, incoming: { slot: string; [k: string]: Json }[], dict: Dictionary): PartMatch {
  const slots = (r.wears ?? []).flatMap((w) => dict.classes.get(w)?.parts ?? []);
  const existing = (r.parts ?? []).filter(isObj).map((p) => ({ p, matched: false }));
  const result = new Map<string, JsonObject>(existing.map(({ p }) => [String(p.$row), { $row: p.$row as Json }]));
  const review: JsonObject[] = [];
  const minted: JsonObject[] = [];
  const keys = existing.map(({ p }) => String(p.$row));
  const mint = () => {
    const m = keys.map((k) => k.match(/^(\D+)(\d+)$/)).find(Boolean);
    const prefix = m?.[1] ?? "r";
    let n = Math.max(0, ...keys.map((k) => Number(k.match(/(\d+)$/)?.[1] ?? 0))) + 1;
    while (keys.includes(`${prefix}${n}`)) n++;
    keys.push(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  for (const inc of incoming) {
    const slot = slots.find((s) => s.slot === inc.slot);
    const inSlot = existing.filter(({ p }) => Array.isArray(p.wears) && slot && p.wears.includes(slot.wears));
    const by = slot?.match;
    const want = by && typeof inc[by] === "string" ? foldKey(inc[by] as string) : null;
    const hit = want ? inSlot.find(({ p, matched }) => !matched && isObj(p.values) && foldKey(String(p.values[by as string] ?? "")) === want) : undefined;
    const label = String(by ? inc[by] : inc.slot);
    if (hit) {
      hit.matched = true;
      result.set(String(hit.p.$row), { $row: hit.p.$row as Json, matched: by as string, from: label });
      continue;
    }
    const could = inSlot.filter((x) => !x.matched);
    if (could.length) {
      const names = could.map(({ p }) => String(p.$row)).join(", ");
      review.push({ address: "parts", from: label, reason: `could be the same part as ${names} (${inc.slot}); not matched by ${by ?? "identity"}` });
      continue;
    }
    minted.push({ $row: mint(), new: true, from: label });
  }
  return { parts: [...result.values(), ...minted], review };
}

// ─── Evidence (9.7) ──────────────────────────────────────────────────────────

export type Observation = JsonObject & { obs: string; on: string; address: string; supports: string };

/** Validate a value from observations: independent witnesses for and against, vetoes, and the state. */
export function validate(r: Record, address: string, observations: Observation[], confirmAt = 2, splitAt = 3): JsonObject {
  const current = serialize(r.values[address] ?? "");
  const mine = observations.filter((o) => o.supports === r.id && o.address === address);
  const witness = (o: Observation) => `${o.on}|${o["evidence-type"] ?? ""}`;
  const forW = new Set<string>();
  const againstW = new Set<string>();
  const vetoes: Observation[] = [];
  const against = new Map<string, { value: Json; instances: Set<string> }>();
  for (const o of mine) {
    if (o.veto !== undefined) {
      if (serialize(o.veto) === current) vetoes.push(o);
      continue;
    }
    if (serialize(o.value as Json) === current) forW.add(witness(o));
    else {
      againstW.add(witness(o));
      const k = serialize(o.value as Json);
      const g = against.get(k) ?? { value: o.value as Json, instances: new Set<string>() };
      g.instances.add(o.on);
      against.set(k, g);
    }
  }
  const out: JsonObject = {
    record: r.id,
    address,
    "witnesses-for": forW.size,
    "witnesses-against": againstW.size,
    vetoes: vetoes.length,
  };
  if (vetoes.length) {
    out.state = "contradicted";
    out.cites = { veto: (vetoes[0] as Observation).obs };
  } else if (againstW.size) out.state = "contradicted";
  else if (forW.size >= confirmAt) out.state = "confirmed";
  else out.state = "unobserved";
  out.alternatives = [...against.values()].map((g) => ({ value: g.value, origin: "observed" }));
  out["split-proposed"] = [...against.values()].some((g) => g.instances.size >= splitAt);
  out.clusters = [...against.values()].map((g) => ({ value: g.value, instances: [...g.instances].sort() }));
  return out;
}

/**
 * Version splits proposed (9.7.3): for each value an address's observations contradict, a cluster of at
 * least `splitAt` instances agreeing with each other is a review item `split:<record>`; nothing splits
 * on its own.
 */
export function proposeSplit(records: Record[], observations: Observation[], splitAt = 3): JsonObject[] {
  const out: JsonObject[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    const key = `${o.supports}|${o.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = records.find((x) => x.id === o.supports);
    if (!r) continue;
    const v = validate(r, o.address, observations, 2, splitAt);
    for (const c of (v.clusters as { value: Json; instances: string[] }[]) ?? []) {
      if (c.instances.length >= splitAt) out.push({ key: `split:${r.id}`, record: r.id, address: o.address, value: c.value, instances: c.instances });
    }
  }
  return out;
}
