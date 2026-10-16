// model.ts: the JSON form's shapes (spec chapter 3). The JSON is the model: readers produce it, printers
// consume it, and canonical.ts hashes it.

import type { Dictionary } from "./defs.ts";
import { itemText } from "./print-text.ts";

export type Json = string | number | boolean | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export type Source = {
  origin: string;
  via: string;
  owner?: string;
  adopted?: boolean;
  /** Taken under terms (7.8): when the value lapses, whether it may flow on, whether the presenter may withdraw it. */
  until?: string;
  reshare?: boolean;
  revocable?: boolean;
};

/** A record's status (1.12): absent means active. */
export type Status = { state: "active" | "archived"; reason?: string; into?: string };

export type Record = {
  id: string;
  kind: string;
  level: string;
  /** Optional at every level (1.2): absent when the record stands alone. */
  of?: string;
  owner: string;
  /** The record this one belongs to for access (14.2). */
  within?: string;
  status?: Status;
  /** Per issuer of instructions, the last one applied (10.7). */
  applied?: { [issuer: string]: number };
  wears?: string[];
  created?: string;
  updated?: string;
  values: JsonObject;
  parts?: Json[];
  sources?: { [address: string]: Source };
};

export type Wrapper = {
  crubal: string;
  package?: string;
  prefixes?: { [prefix: string]: string };
  records: Record[];
};

const RECORD_MEMBERS = new Set(["id", "kind", "level", "of", "owner", "within", "status", "applied", "wears", "created", "updated", "values", "parts", "sources", "alternatives", "suggestions", "held"]);

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse CRUBAL JSON text (chapter 3): RFC 8259, with a member named twice in one object refused. JSON.parse
 * keeps the last of two equal names, so the text is scanned for them first; the scan follows strings and
 * brackets only and leaves everything else to JSON.parse.
 */
export function parseJson(text: string): Json {
  type Frame = { keys: Set<string> | null; expectKey: boolean; at: string };
  const stack: Frame[] = [];
  let i = 0;
  scan: while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const raw = text.slice(i, j + 1);
      i = j + 1;
      const top = stack.at(-1);
      if (top?.keys && top.expectKey) {
        let key: string;
        try {
          key = JSON.parse(raw) as string;
        } catch {
          break scan; // malformed: JSON.parse below says where
        }
        if (top.keys.has(key)) throw new Error(`member ${key} twice in the object at $${stack.slice(0, -1).map((f) => f.at).join("")}: a document never names a member twice`);
        top.keys.add(key);
        top.expectKey = false;
        top.at = `.${key}`;
      }
      continue;
    }
    if (c === "{") stack.push({ keys: new Set(), expectKey: true, at: "" });
    else if (c === "[") stack.push({ keys: null, expectKey: false, at: "[0]" });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack.at(-1);
      if (top?.keys) top.expectKey = true;
      else if (top) top.at = `[${Number(top.at.slice(1, -1)) + 1}]`;
    }
    i++;
  }
  return JSON.parse(text) as Json;
}

type Step = { key: string; selector?: string; quoted?: boolean };

/** An address's steps (1.10): `key` or `key[selector]`, `.`-separated outside brackets and quotes; undefined when malformed. */
function steps(address: string): Step[] | undefined {
  const out: Step[] = [];
  let i = 0;
  for (;;) {
    let key = "";
    while (i < address.length && address[i] !== "." && address[i] !== "[") key += address[i++];
    if (!key) return undefined;
    const step: Step = { key };
    if (address[i] === "[") {
      i++;
      if (address[i] === '"') {
        let j = i + 1;
        while (j < address.length && address[j] !== '"') j += address[j] === "\\" ? 2 : 1;
        if (j >= address.length) return undefined;
        try {
          step.selector = JSON.parse(address.slice(i, j + 1)) as string;
        } catch {
          return undefined;
        }
        step.quoted = true;
        i = j + 1;
      } else {
        const end = address.indexOf("]", i);
        if (end <= i) return undefined;
        step.selector = address.slice(i, end);
        i = end;
      }
      if (address[i] !== "]") return undefined;
      i++;
    }
    out.push(step);
    if (i === address.length) return out;
    if (address[i] !== ".") return undefined;
    i++;
  }
}

/** Whether an address names a place in the record's values or parts (3.7). `*` is the record itself. */
export function addressNames(r: Record, address: string, dict?: Dictionary): boolean {
  if (address === "*") return true;
  const st = steps(address);
  if (!st?.length) return false;
  const [first, ...rest] = st as [Step, ...Step[]];
  if (first.key === "parts") {
    if (first.selector === undefined || first.quoted) return false;
    const part = (r.parts ?? []).find((p) => isObj(p) && String(p.$row) === first.selector);
    if (!isObj(part)) return false;
    return rest.length ? walk(isObj(part.values) ? part.values : {}, rest, dict) : true;
  }
  return walk(r.values, st, dict);
}

function walk(values: JsonObject, st: Step[], dict: Dictionary | undefined): boolean {
  let cur: Json | undefined = values;
  for (const s of st) {
    if (!isObj(cur)) return false;
    let v: Json | undefined = cur[s.key];
    if (v === undefined) return false;
    if (s.selector !== undefined) {
      if (!Array.isArray(v)) return false;
      const sel = s.selector;
      const facet = dict?.facets.get(s.key);
      const hit: Json | undefined = v.find((item) => {
        // A plain list item by its text form (1.10); without the dictionary, by its core value.
        if (s.quoted) return facet ? itemText(facet, item) === sel : String(isObj(item) ? (item.$value ?? item.$qty ?? item.$money ?? item.$link ?? "") : item) === sel.replace(/ \[.*\]$/, "");
        // A row by its key: written as `$row`, or derived from the identity child, which is a link (1.6).
        return isObj(item) && (String(item.$row) === sel || Object.values(item).some((x) => isObj(x) && x.$link === sel));
      });
      if (hit === undefined) return false;
      v = hit;
    }
    cur = v;
  }
  return true;
}

/** Refuse JSON the spec forbids: `null` anywhere (chapter 3), unknown record members (3.2). */
export function checkJson(doc: unknown, path = "$"): void {
  if (doc === null) throw new Error(`null at ${path}: CRUBAL JSON never holds null`);
  if (Array.isArray(doc)) {
    doc.forEach((d, i) => checkJson(d, `${path}[${i}]`));
    return;
  }
  if (typeof doc === "object") {
    for (const [k, v] of Object.entries(doc as object)) checkJson(v, `${path}.${k}`);
  }
}

/**
 * Check a wrapper read from JSON: no null, the members 3.2 lists, and every source address naming a place in
 * the record (3.7). With the dictionary, a quoted list selector is matched by the item's text form; without
 * it, by the item's core value.
 */
export function checkWrapper(w: Wrapper, dict?: Dictionary): void {
  checkJson(w);
  if (!/^\d+$/.test(String(w.crubal)) || Number(w.crubal) > 2) throw new Error(`written in CRUBAL ${w.crubal}; this reader knows 2`);
  if (!Array.isArray(w.records)) throw new Error("a wrapper needs records");
  w.records.forEach((r, i) => {
    for (const k of Object.keys(r)) {
      if (!RECORD_MEMBERS.has(k)) throw new Error(`records[${i}] has an unknown member ${k}`);
    }
    for (const k of ["id", "kind", "level", "owner", "values"] as const) {
      if (r[k] === undefined) throw new Error(`records[${i}] needs ${k}`);
    }
    for (const address of Object.keys(r.sources ?? {})) {
      if (!addressNames(r, address, dict)) throw new Error(`records[${i}].sources: ${address} names nothing in values or parts`);
    }
  });
}
