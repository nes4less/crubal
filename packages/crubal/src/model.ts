// model.ts: the JSON form's shapes (spec chapter 3). The JSON is the model: readers produce it, printers
// consume it, and canonical.ts hashes it.

export type Json = string | number | boolean | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export type Source = { origin: string; via: string; owner?: string; adopted?: boolean };

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

export function checkWrapper(w: Wrapper): void {
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
  });
}
