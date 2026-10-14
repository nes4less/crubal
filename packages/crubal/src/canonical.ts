// canonical.ts: canonical JSON (spec chapter 3.9). Sets are sorted, ordered lists keep their order, and
// the result is serialized RFC 8785 style: object keys sorted by UTF-16 code units, no white space.

import type { Dictionary, Facet } from "./defs.ts";
import type { Json, JsonObject, Wrapper } from "./model.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Serialize with sorted keys. Numbers in CRUBAL JSON are strings, so JSON.stringify's number form is enough. */
export function serialize(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  if (isObj(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(v[k] as Json)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function sortSets(v: Json, f: Facet | undefined, dict: Dictionary): Json {
  if (!f) return v;
  if (Array.isArray(v)) {
    const items = v.map((item) => (f.type === "compound" ? fields(item, f.children, dict) : item));
    return f.ordered ? items : [...items].sort((a, b) => (serialize(a) < serialize(b) ? -1 : serialize(a) > serialize(b) ? 1 : 0));
  }
  if (f.type === "compound") return fields(v, f.children, dict);
  return v;
}

function fields(v: Json, within: Map<string, Facet> | undefined | null, dict: Dictionary): Json {
  if (!isObj(v)) return v;
  const out: JsonObject = {};
  for (const [k, x] of Object.entries(v)) {
    const f = within ? within.get(k) : dict.facets.get(k);
    out[k] = sortSets(x, f, dict);
  }
  return out;
}

/** The canonical form of a wrapper, as a string. */
export function canonical(w: Wrapper, dict: Dictionary): string {
  const records = w.records.map((r) => {
    const out: JsonObject = { ...(r as unknown as JsonObject) };
    out.values = fields(r.values, null, dict);
    if (r.parts) {
      out.parts = r.parts.map((p) => (isObj(p) && isObj(p.values) ? { ...p, values: fields(p.values, null, dict) } : p));
    }
    return out;
  });
  return serialize({ ...(w as unknown as JsonObject), records } as JsonObject);
}
