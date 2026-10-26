// forms.ts: a form as data (spec 7.7, docs/design/index-and-forms.md). A form is a contract with a person;
// its fields are the contract's needs, in their order and sections, each carrying what its facet says and
// what the record says: the current value, its state (6.3.2) and whether this caller may edit it (14.6,
// 14.7). A held arrival's candidates ride along so the person decides on the spot (9.2a). Nothing here
// writes: submitting is the form's run.

import type { Access } from "./access.ts";
import type { Arrival } from "./arrival.ts";
import { evaluate, parseCondition } from "./conditions.ts";
import { type ClassLine, type Dictionary, type Facet, type PartSlot } from "./defs.ts";
import { resolve } from "./dictionary.ts";
import { effective, effectiveParts, ownedPartKeys } from "./lifecycle.ts";
import type { Json, JsonObject, Record } from "./model.ts";
import type { RecordSet } from "./records.ts";
import type { Contract } from "./store.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A key's label when its facet has none: split at capitals (4.2). */
function label(key: string): string {
  const bare = key.replace(/^.*:/, "");
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

export type FormOptions = {
  caller?: string;
  access?: Access;
  /** The records the form's record reads through (1.7); the record alone otherwise. */
  records?: RecordSet;
  /** A held arrival (9.2a): its candidates are offered. */
  arrival?: Arrival;
};

type Extra = Record & { alternatives?: { [a: string]: Json[] }; suggestions?: { [a: string]: Json[] }; held?: { [a: string]: JsonObject } };

/** A value's states (6.3.2), as the rules engine reads them. */
function statesOf(r: Extra | undefined, f: Facet | undefined, key: string): string[] {
  if (!r) return [];
  const s: string[] = [];
  if (r.alternatives?.[key]?.length) s.push("conflicted");
  if (r.suggestions?.[key]?.length) s.push("suggested");
  if (r.held?.[key]) s.push("held");
  const v = r.values[key];
  if (f?.type === "choice" && typeof v === "string" && !(f.values ?? []).some((x) => x.value === v)) s.push("new");
  if (r.sources?.[key]?.adopted) s.push("adopted");
  return s;
}

/** One field: the facet's settings narrowed by the line, and the record's answer. */
function field(line: { facet: string; required?: boolean; values?: string[]; length?: number; pick?: string; range?: { min: string; max: string }; precision?: string; level?: string; when?: string; frame?: string }, dict: Dictionary, r: Extra | undefined, vals: JsonObject, o: FormOptions, recordId: string | undefined): JsonObject {
  const f = dict.facets.get(line.facet);
  const key = line.level ? `${line.level}::${line.facet}` : line.facet;
  const out: JsonObject = { key, label: f?.label ?? label(line.facet), type: f?.type ?? "raw" };
  if (f?.ask) out.ask = f.ask;
  if (line.required || f?.required) out.required = true;
  const allowed = line.values ?? f?.values?.map((v) => v.value);
  if (f?.type === "choice" && allowed) {
    out.values = allowed.map((v): JsonObject => {
      const cv = f.values?.find((x) => x.value === v);
      return { value: v, ...(cv?.aliases.length ? { aliases: [...cv.aliases] } : {}) };
    });
    if (f.open && !line.values) out.open = true;
    for (const k of ["fixed", "ranked", "scored"] as const) if (f[k]) out[k] = true;
  }
  const pick = line.pick ?? f?.pick ?? "1";
  if (pick !== "1") out.pick = pick;
  if (f?.ordered) out.ordered = true;
  if (f?.unit) out.unit = f.unit;
  if (f?.accepts.length) out.accepts = [...f.accepts];
  if (f?.places !== undefined) out.places = String(f.places);
  if (f?.precision && f.precision !== "any") out.precision = f.precision;
  if (line.precision) out.precision = line.precision;
  if (f?.zone) out.zone = f.zone;
  if (f?.words) out.words = [...f.words];
  const length = line.length ?? f?.length;
  if (length !== undefined) out.length = String(length);
  const range = line.range ?? f?.range;
  if (range) out.range = [range.min, range.max];
  if (f?.qualifiers.length) out.qualifiers = [...f.qualifiers];
  if (f?.to) out.to = f.to;
  if (line.frame) out.frame = line.frame;
  if (line.when) {
    out.when = line.when;
    const asked = evaluate(parseCondition(line.when), vals);
    if (asked !== true) out.asked = false;
  }
  // The record's answer: a level-prefixed key is this record's only when it sits at that level.
  const mine = !line.level || r?.level === line.level;
  if (mine) {
    const current = vals[line.facet];
    if (current !== undefined) out.current = current;
    const st = statesOf(r, f, line.facet);
    if (st.length) out.state = st;
  }
  let editable = mine;
  if (editable && o.access && o.caller && recordId) editable = o.access.may(o.caller, "edit", line.facet, recordId);
  out.editable = editable;
  if (editable && o.access && o.caller && recordId) {
    const gate = o.access.gated(o.caller, recordId);
    if (gate) out.gated = gate.edge;
  }
  return out;
}

/** The form a contract makes for a record and a caller. */
export function formOf(c: Contract, record: Record | undefined, dict: Dictionary, o: FormOptions = {}): JsonObject {
  const r = record as Extra | undefined;
  const vals: JsonObject = r ? (o.records ? effective(o.records, r) : { ...r.values }) : {};
  const out: JsonObject = { contract: c.name };
  if (record) out.record = record.id;
  if (c.parts.label) out.label = c.parts.label;
  out.origin = c.origin || "declared";
  // Fields in the needs' order, under their sections (5.3.3).
  const sections: { title?: string; fields: JsonObject[] }[] = [];
  for (const l of c.needs as (ClassLine & { precision?: string })[]) {
    const title = l.section;
    let s = sections.at(-1);
    if (!s || s.title !== title) {
      s = { ...(title ? { title } : {}), fields: [] };
      sections.push(s);
    }
    s.fields.push(field(l, dict, r, vals, o, record?.id));
  }
  out.sections = sections.map((s): JsonObject => ({ ...(s.title ? { title: s.title } : {}), fields: s.fields }));
  // Parts (5.6): rows per slot of the record's worn classes, the slot's class lines as fields. A record below
  // the chain's top mirrors the parts above (1.6): it is asked only the lines its level owns on each part; the
  // rest show as read through and take no edit.
  const mirrored = r && o.records ? effectiveParts(o.records, r) : (r?.parts ?? []).filter(isObj);
  if (r && mirrored.length) {
    const up = r.of && o.records ? o.records.get(r.of) : undefined;
    const worn = [...new Set([...(up?.wears ?? []), ...(r.wears ?? [])])];
    const slots: PartSlot[] = worn.flatMap((w) => dict.classes.get(w)?.parts ?? []);
    const parts: JsonObject[] = [];
    for (const slot of slots) {
      const rows = mirrored.filter((p) => Array.isArray(p.wears) && p.wears.includes(slot.wears));
      if (!rows.length) continue;
      const lines = resolve(dict, [slot.wears]);
      const owned = r.of ? ownedPartKeys(dict, r, [slot.wears]) : undefined;
      parts.push({
        slot: slot.slot,
        wears: slot.wears,
        ...(slot.fungible ? { fungible: true } : {}),
        rows: rows.map((p): JsonObject => {
          const pv = (isObj(p.values) ? p.values : {}) as JsonObject;
          const fields = lines
            .filter((ln) => !ln.levels.length || ln.levels.includes(r.level))
            .map((ln) => {
              const f = field({ facet: ln.facet, ...(ln.required ? { required: true } : {}), ...(ln.values ? { values: ln.values } : {}), ...(ln.length !== undefined ? { length: ln.length } : {}), ...(ln.pick ? { pick: ln.pick } : {}), ...(ln.range ? { range: ln.range } : {}), ...(ln.when ? { when: ln.when } : {}) }, dict, { ...r, values: pv, alternatives: undefined, suggestions: undefined, held: undefined } as Extra, pv, o, record?.id);
              if (owned && !owned.has(ln.facet)) f.editable = false;
              return f;
            });
          if (slot.fungible && !owned) fields.push({ key: "crubal:count", label: "Count", type: "number", editable: true, ...(pv["crubal:count"] !== undefined ? { current: pv["crubal:count"] } : {}) });
          return { row: String(p.$row), fields };
        }),
      });
    }
    if (parts.length) out.parts = parts;
  }
  if (o.arrival?.outcome === "held" && o.arrival.candidates?.length) {
    out.candidates = o.arrival.candidates.map((id): JsonObject => ({ record: id, ...(o.arrival?.archived?.includes(id) ? { archived: true } : {}) }));
    if (o.arrival.ref !== undefined) out.ref = o.arrival.ref;
  }
  out.submit = { run: c.name, ...(record ? { record: record.id } : {}) };
  return out;
}
