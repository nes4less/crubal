// print-text.ts: the JSON form (spec chapter 3) back to canonical text (chapter 2.9). Full mode writes the
// envelope lines and sources, so reading the print gives the same pairs back.

import { blank, type Dictionary, type Facet } from "./defs.ts";
import { writeText } from "./lex.ts";
import type { Json, JsonObject, Record, Source, Wrapper } from "./model.ts";

export type PrintMode = "full" | "plain";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Detail pairs whose values are already spelled for the text form. */
function detailText(pairs: [string, string][]): string {
  if (!pairs.length) return "";
  return ` [${pairs.map(([k, v]) => `${k}: ${v}`).join(", ")}]`;
}

function sourcePairs(s: Source | undefined): [string, string][] {
  if (!s) return [];
  const out: [string, string][] = [["origin", writeText(s.origin, true)], ["via", writeText(s.via, true)]];
  if (s.owner) out.push(["owner", writeText(s.owner, true)]);
  return out;
}

const TEXT: Facet = blank("", "text");

/** Spellings that would read as another shape under this facet, so text holding them must be quoted. */
function otherShapes(f: Facet): string[] {
  const out = ["_", "-", "n/a", "N/A"];
  if (f.type === "yes-no") out.push("yes", "no", ...(f.words ?? []));
  return out;
}

/** One scalar, as the text form spells it, without detail. */
function scalarText(f: Facet, v: Json): string {
  if (typeof v === "boolean") {
    const [yes, no] = f.words ?? ["yes", "no"];
    return v ? yes : no;
  }
  if (typeof v === "string") return writeText(v, false, otherShapes(f));
  if (typeof v === "number") return String(v);
  if (isObj(v)) {
    if ("$empty" in v) return v.$empty === "unknown" ? "_" : "-";
    if ("$link" in v) return `&${v.$link}`;
    if ("$qty" in v) return `${v.$qty}${v.unit}`;
    if ("$money" in v) return `${v.$money}${v.currency}`;
    if ("$image" in v) return writeText(String(v.$image));
  }
  return JSON.stringify(v);
}

/** The detail pairs a value carries in itself: qualifiers and image fields. */
function ownDetail(v: Json): [string, string][] {
  if (!isObj(v)) return [];
  if ("$value" in v) {
    return Object.entries(v)
      .filter(([k]) => k !== "$value")
      .map(([k, q]) => [k, typeof q === "string" ? writeText(q, true) : scalarText(TEXT, q)]);
  }
  if ("$image" in v) {
    return Object.entries(v)
      .filter(([k]) => k !== "$image")
      .map(([k, x]) => [k, typeof x === "string" ? writeText(x, true) : String(x)]);
  }
  return [];
}

function core(v: Json): Json {
  return isObj(v) && "$value" in v ? (v.$value as Json) : v;
}

/** A list item's text form with its qualifiers and without its sources: the selector in an address. */
export function itemText(f: Facet, v: Json): string {
  return scalarText(f, core(v)) + detailText(ownDetail(v));
}

type Out = { lines: string[]; sources: { [a: string]: Source }; mode: PrintMode; dict: Dictionary };

function valueLine(f: Facet, v: Json, address: string, out: Out): string {
  const src = out.mode === "full" ? out.sources[address] : undefined;
  return scalarText(f, core(v)) + detailText([...ownDetail(v), ...sourcePairs(src)]);
}

function printFields(obj: JsonObject, within: Map<string, Facet> | null, prefix: string, depth: number, out: Out) {
  const pad = "  ".repeat(depth);
  for (const [key, v] of Object.entries(obj)) {
    const f = within ? within.get(key) : out.dict.facets.get(key);
    const address = prefix ? `${prefix}.${key}` : key;
    if (!f) {
      const [first = "", ...more] = (typeof v === "string" ? v : JSON.stringify(v)).split("\n");
      out.lines.push(first ? `${pad}${key}: ${first}` : `${pad}${key}:`);
      for (const m of more) out.lines.push(`${pad}  ${m}`);
      continue;
    }
    printValue(f, key, v, address, depth, out);
  }
}

function printValue(f: Facet, key: string, v: Json, address: string, depth: number, out: Out) {
  const pad = "  ".repeat(depth);
  if (isObj(v) && "$empty" in v) {
    out.lines.push(`${pad}${key}: ${valueLine(f, v, address, out)}`);
    return;
  }
  // Text holding a line break takes the block form (2.4.1): `key: |`, its detail on that line, the lines
  // below, an empty line written as `|`.
  if (f.type === "text" && !f.many && typeof v === "string" && v.includes("\n")) {
    const src = out.mode === "full" ? out.sources[address] : undefined;
    out.lines.push(`${pad}${key}: |${detailText(sourcePairs(src))}`);
    for (const l of v.split("\n")) out.lines.push(l === "" ? `${pad}  |` : `${pad}  ${l}`);
    return;
  }
  if (f.type === "compound") {
    const children = f.children ?? new Map<string, Facet>();
    out.lines.push(`${pad}${key}:`);
    if (!f.many || !Array.isArray(v)) {
      if (isObj(v)) printFields(v, children, address, depth + 1, out);
      return;
    }
    for (const row of v) {
      if (!isObj(row)) continue;
      const rowKey = f.identity ? linkTarget(row[f.identity]) : String(row.$row ?? "");
      const fields: JsonObject = {};
      if (f.identity && row[f.identity] !== undefined) fields[f.identity] = row[f.identity] as Json;
      for (const [k, x] of Object.entries(row)) if (k !== "$row" && !(k in fields)) fields[k] = x;
      const start = out.lines.length;
      if (!f.identity) out.lines.push(`${pad}  - [row: ${rowKey}]`);
      printFields(fields, children, `${address}[${rowKey}]`, depth + 2, out);
      if (f.identity) {
        const first = out.lines[start];
        if (first !== undefined) out.lines[start] = `${pad}  - ${first.trimStart()}`;
      }
    }
    return;
  }
  if (!f.many || !Array.isArray(v)) {
    out.lines.push(`${pad}${key}: ${valueLine(f, v, address, out)}`);
    return;
  }
  const items = v.map((item) => {
    const src = out.mode === "full" ? out.sources[`${key}[${JSON.stringify(itemText(f, item))}]`] : undefined;
    return scalarText(f, core(item)) + detailText([...ownDetail(item), ...sourcePairs(src)]);
  });
  const short = `${pad}${key}: ${items.join(", ")}`;
  if (short.length <= 100 && items.every((i) => !i.includes("\n"))) {
    out.lines.push(short);
    return;
  }
  out.lines.push(`${pad}${key}:`);
  for (const item of items) out.lines.push(`${pad}  - ${item}`);
}

function linkTarget(v: Json | undefined): string {
  return isObj(v) && "$link" in v ? String(v.$link) : String(v ?? "");
}

function printRecord(r: Record, fileOwner: string | undefined, out: Out) {
  const sources = r.sources ?? {};
  out.sources = sources;
  const star = out.mode === "full" ? detailText(sourcePairs(sources["*"])) : "";
  out.lines.push(`${r.level}: ${r.id}${r.of ? ` of ${r.of}` : ""}${star}`);
  if (r.owner !== fileOwner) out.lines.push(`  crubal:owner: ${r.owner}`);
  if (r.within) out.lines.push(`  crubal:within: ${r.within}`);
  if (r.status?.state === "archived") {
    const pairs: [string, string][] = [];
    if (r.status.reason) pairs.push(["reason", writeText(r.status.reason, true)]);
    if (r.status.into) pairs.push(["into", r.status.into]);
    out.lines.push(`  crubal:status: archived${detailText(pairs)}`);
  }
  if (r.applied && Object.keys(r.applied).length) {
    out.lines.push(`  crubal:applied:${detailText(Object.entries(r.applied).map(([k, n]) => [k, String(n)]))}`);
  }
  if (r.wears?.length) out.lines.push(`  crubal:wears: ${r.wears.join(", ")}`);
  if (out.mode === "full" && r.created) out.lines.push(`  crubal:created: ${r.created}`);
  if (out.mode === "full" && r.updated) out.lines.push(`  crubal:updated: ${r.updated}`);
  printFields(r.values, null, "", 1, out);
  if (r.parts?.length) {
    out.lines.push("  crubal:parts:");
    for (const part of r.parts) {
      if (!isObj(part)) continue;
      out.lines.push(`    - [row: ${part.$row}]`);
      const wears = part.wears;
      if (Array.isArray(wears) && wears.length) out.lines.push(`      crubal:wears: ${wears.join(", ")}`);
      if (isObj(part.values)) printFields(part.values, null, `parts[${part.$row}]`, 3, out);
    }
  }
}

/** Print a wrapper as text. */
export function printText(w: Wrapper, dict: Dictionary, mode: PrintMode = "full"): string {
  const out: Out = { lines: [], sources: {}, mode, dict };
  const owners = w.records.map((r) => r.owner);
  const fileOwner = owners[0];
  out.lines.push(`crubal: ${w.crubal}`);
  if (w.package) out.lines.push(`package: ${w.package}`);
  if (fileOwner) out.lines.push(`owner: ${fileOwner}`);
  for (const r of w.records) {
    out.lines.push("");
    printRecord(r, fileOwner, out);
  }
  return `${out.lines.join("\n")}\n`;
}
