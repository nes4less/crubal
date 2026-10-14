// read-text.ts: CRUBAL data text (spec chapter 2) into the JSON form (chapter 3). The facet decides each
// value's shape (chapter 1.4); a key without a facet keeps its exact text as a raw value.

import type { Dictionary, Facet } from "./defs.ts";
import { type Piece, readList, readPiece, writeText } from "./lex.ts";
import { CrubalError, innerText, type Node, readTree } from "./tree.ts";
import { type Json, type JsonObject, type Record, type Source, type Wrapper } from "./model.ts";
import { itemText } from "./print-text.ts";

const RESERVED_DETAIL = new Set(["row", "origin", "via", "owner"]);
const IMAGE_FIELDS = new Set(["sha256", "w", "h", "type"]);
const ENVELOPE = new Set(["crubal:wears", "crubal:parts", "crubal:kind", "crubal:owner", "crubal:created", "crubal:updated"]);
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const ORIGINS = new Set(["observed", "declared", "derived", "reported"]);

type Ctx = { dict: Dictionary; sources: { [address: string]: Source } };

function sourceOf(detail: [string, Piece][], line: number): Source | null {
  const get = (n: string) => detail.find(([k]) => k === n)?.[1].text;
  const origin = get("origin");
  const via = get("via");
  const owner = get("owner");
  if (origin === undefined && via === undefined && owner === undefined) return null;
  if (!origin || !via) throw new CrubalError("a source needs both origin and via", line);
  if (!ORIGINS.has(origin)) throw new CrubalError(`unknown origin ${origin}`, line);
  const s: Source = { origin, via };
  if (owner) s.owner = owner;
  return s;
}

function isEmptyMark(p: Piece): "unknown" | "n/a" | null {
  if (p.quoted) return null;
  if (p.text === "_") return "unknown";
  if (p.text === "-" || p.text === "n/a" || p.text === "N/A") return "n/a";
  return null;
}

/** Read one scalar piece under its facet: the shape the facet decides, falling back to text. */
function scalar(f: Facet, p: Piece): Json {
  const t = p.text;
  switch (f.type) {
    case "link":
      return !p.quoted && t.startsWith("&") ? { $link: t.slice(1) } : t;
    case "number": {
      const unit = f.unit;
      if (!unit) return NUMBER.test(t) ? t : t;
      const m = t.match(/^(-?(?:0|[1-9]\d*)(?:\.\d+)?) ?(\S+)$/);
      if (m && (unit === "currency" || /^[A-Z]{3}$/.test(unit)) && /^[A-Z]{3}$/.test(m[2] ?? "")) {
        return { $money: m[1] as string, currency: m[2] as string };
      }
      if (m) return { $qty: m[1] as string, unit: m[2] as string };
      return t;
    }
    case "yes-no": {
      const [yes, no] = f.words ?? ["yes", "no"];
      if (!p.quoted && (t === "yes" || t === yes)) return true;
      if (!p.quoted && (t === "no" || t === no)) return false;
      return t;
    }
    case "image":
      return { $image: t };
    default:
      return t;
  }
}

/** A value with its detail: image fields, qualifiers (a `$value` wrapper), and its source. */
function value(f: Facet, p: Piece, ctx: Ctx, address: string | null, line: number): Json {
  let v = scalar(f, p);
  const qualifiers: JsonObject = {};
  for (const [name, d] of p.detail) {
    if (name === "row") throw new CrubalError("a row key belongs on the row's own line", line);
    if (RESERVED_DETAIL.has(name)) continue;
    if (f.type === "image" && IMAGE_FIELDS.has(name) && typeof v === "object" && v && "$image" in v) {
      (v as JsonObject)[name] = name === "w" || name === "h" ? Number(d.text) : d.text;
      continue;
    }
    const qf = ctx.dict.facets.get(name);
    qualifiers[name] = qf ? scalar(qf, d) : d.text;
  }
  if (Object.keys(qualifiers).length) v = { $value: v, ...qualifiers };
  const src = sourceOf(p.detail, line);
  if (src) {
    const at = address ?? "";
    ctx.sources[at] = src;
  }
  return v;
}

function addressItem(key: string, f: Facet, item: Json): string {
  return `${key}[${JSON.stringify(itemText(f, item))}]`;
}

/** Read a facet's value from its node: one value, a list, or a compound. */
function readValue(f: Facet, node: Node, ctx: Ctx, address: string): Json | undefined {
  const raw = node.value;
  // An empty is the whole value (chapter 1.5).
  if (raw && node.children.length === 0 && /^(_|-|n\/a|N\/A)( \[.*\])?$/.test(raw.trim())) {
    const whole = readPiece(raw, node.line);
    const empty = isEmptyMark(whole);
    if (empty) {
      const src = sourceOf(whole.detail, node.line);
      if (src) ctx.sources[address] = src;
      return { $empty: empty };
    }
  }
  if (f.type === "compound") return readCompound(f, node, ctx, address);
  if (!f.many) {
    if (!raw) return undefined;
    return value(f, readPiece(raw, node.line), ctx, address, node.line);
  }
  const pieces: { p: Piece; line: number }[] = raw
    ? readList(raw, node.line).map((p) => ({ p, line: node.line }))
    : node.children.map((c) => {
        if (c.kind !== "item") throw new CrubalError("a list's lines start with \"- \"", c.line);
        return { p: readPiece(c.value, c.line), line: c.line };
      });
  const out: Json[] = [];
  for (const { p, line } of pieces) {
    if (isEmptyMark(p) || (!p.quoted && p.text === "")) throw new CrubalError("an empty can't be a list item", line);
    const tmp: Ctx = { dict: ctx.dict, sources: {} };
    const v = value(f, p, tmp, "", line);
    out.push(v);
    if (tmp.sources[""]) ctx.sources[addressItem(f.key, f, v)] = tmp.sources[""];
  }
  return out.length ? out : undefined;
}

function readFields(children: Node[], within: Map<string, Facet> | null, ctx: Ctx, prefix: string): JsonObject {
  const obj: JsonObject = {};
  const seen = new Set<string>();
  for (const c of children) {
    if (c.kind !== "pair" || !c.key) throw new CrubalError(`expected "key: value": ${c.text}`, c.line);
    if (seen.has(c.key)) throw new CrubalError(`the key ${c.key} twice`, c.line);
    seen.add(c.key);
    const f = within ? within.get(c.key) : ctx.dict.facets.get(c.key);
    const address = prefix ? `${prefix}.${c.key}` : c.key;
    if (!f) {
      obj[c.key] = c.children.length ? `${c.value}\n${innerText(c)}` : c.value;
      continue;
    }
    const v = readValue(f, c, ctx, address);
    if (v !== undefined) obj[c.key] = v;
  }
  return obj;
}

function rowKeyOf(item: Node): { key: string | null; rest: Node[] } {
  if (!item.value) return { key: null, rest: item.children };
  const p = readPiece(item.value, item.line);
  if (p.text !== "") throw new CrubalError(`a row starts with "[row: key]" or its first pair: ${item.value}`, item.line);
  const row = p.detail.find(([k]) => k === "row");
  if (!row || p.detail.length !== 1) throw new CrubalError("a row's own line holds only [row: key]", item.line);
  return { key: row[1].text, rest: item.children };
}

function readCompound(f: Facet, node: Node, ctx: Ctx, address: string): Json | undefined {
  const children = f.children ?? new Map<string, Facet>();
  if (!f.many) return readFields(node.children, children, ctx, address);
  const rows: Json[] = [];
  const keys = new Set<string>();
  for (const item of node.children) {
    if (item.kind !== "item") throw new CrubalError("a compound's rows start with \"- \"", item.line);
    const { key: written, rest } = rowKeyOf(item);
    if (written && f.identity) {
      throw new CrubalError(`a row key on ${f.key}, whose row keys come from ${f.identity}`, item.line);
    }
    let key = written;
    if (f.identity) {
      const idNode = rest.find((c) => c.key === f.identity);
      const target = idNode?.value.trim();
      if (!target?.startsWith("&")) throw new CrubalError(`a row of ${f.key} needs its ${f.identity}`, item.line);
      key = target.slice(1);
    }
    if (!key) throw new CrubalError(`a row of ${f.key} needs [row: key]`, item.line);
    if (keys.has(key)) throw new CrubalError(`the row key ${key} twice in one list`, item.line);
    keys.add(key);
    const row = readFields(rest, children, ctx, `${address}[${key}]`);
    rows.push(f.identity ? row : { $row: key, ...row });
  }
  return rows.length ? rows : undefined;
}

function readParts(node: Node, ctx: Ctx): Json[] {
  const parts: Json[] = [];
  const keys = new Set<string>();
  for (const item of node.children) {
    if (item.kind !== "item") throw new CrubalError("parts are list items", item.line);
    const { key, rest } = rowKeyOf(item);
    if (!key) throw new CrubalError("every part needs [row: key]", item.line);
    if (keys.has(key)) throw new CrubalError(`the row key ${key} twice in one list`, item.line);
    keys.add(key);
    const wearsNode = rest.find((c) => c.key === "crubal:wears");
    const values = readFields(rest.filter((c) => c !== wearsNode), null, ctx, `parts[${key}]`);
    const part: JsonObject = { $row: key };
    if (wearsNode) part.wears = readList(wearsNode.value, wearsNode.line).map((p) => p.text);
    part.values = values;
    parts.push(part);
  }
  return parts;
}

/** Read CRUBAL data text into a border wrapper (spec chapter 3.8). */
export function readText(source: string, dict: Dictionary): Wrapper {
  const nodes = readTree(source);
  const wrapper: Wrapper = { crubal: "2", records: [] };
  let owner: string | undefined;
  for (const node of nodes) {
    if (node.kind !== "pair" || !node.key) throw new CrubalError(`unexpected line: ${node.text}`, node.line);
    if (node.key === "crubal") {
      wrapper.crubal = node.value;
      continue;
    }
    if (node.key === "package") {
      wrapper.package = node.value;
      continue;
    }
    if (node.key === "owner") {
      owner = node.value;
      continue;
    }
    const kind = dict.levels.get(node.key);
    if (!kind) throw new CrubalError(`an unknown top-level key ${node.key}`, node.line);
    wrapper.records.push(readRecord(node, kind, owner));
  }
  return wrapper;

  function readRecord(node: Node, kind: string, fileOwner: string | undefined): Record {
    const head = readPiece(node.value, node.line);
    const m = head.text.match(/^(\S+)(?: of (\S+))?$/);
    if (!m) throw new CrubalError(`a record header is "level: id" or "level: id of parent": ${node.value}`, node.line);
    const ctx: Ctx = { dict, sources: {} };
    const star = sourceOf(head.detail, node.line);
    if (star) ctx.sources["*"] = star;

    const rec: Record = { id: m[1] as string, kind, level: node.key as string, owner: fileOwner ?? "", values: {} };
    if (m[2]) rec.of = m[2];
    const seen = new Set<string>();
    const valueNodes: Node[] = [];
    for (const c of node.children) {
      if (c.kind !== "pair" || !c.key) throw new CrubalError(`expected "key: value": ${c.text}`, c.line);
      if (seen.has(c.key)) throw new CrubalError(`the key ${c.key} twice in one record`, c.line);
      seen.add(c.key);
      if (!ENVELOPE.has(c.key)) {
        valueNodes.push(c);
        continue;
      }
      if (c.key === "crubal:wears") rec.wears = readList(c.value, c.line).map((p) => p.text);
      else if (c.key === "crubal:parts") rec.parts = readParts(c, ctx);
      else if (c.key === "crubal:owner") rec.owner = c.value;
      else if (c.key === "crubal:created") rec.created = c.value;
      else if (c.key === "crubal:updated") rec.updated = c.value;
      else if (c.key === "crubal:kind" && c.value !== kind) {
        throw new CrubalError(`crubal:kind ${c.value} disagrees with the level's kind ${kind}`, c.line);
      }
    }
    rec.values = readFields(valueNodes, null, ctx, "");
    if (Object.keys(ctx.sources).length) rec.sources = ctx.sources;
    return orderRecord(rec);
  }
}

/** Members in the order chapter 3.2 lists them, so output reads the same every time. */
function orderRecord(r: Record): Record {
  const o: JsonObject = { id: r.id, kind: r.kind, level: r.level };
  if (r.of) o.of = r.of;
  o.owner = r.owner;
  if (r.wears) o.wears = r.wears;
  if (r.created) o.created = r.created;
  if (r.updated) o.updated = r.updated;
  o.values = r.values;
  if (r.parts) o.parts = r.parts;
  if (r.sources) o.sources = r.sources as unknown as JsonObject;
  return o as unknown as Record;
}

export { writeText };
