// bundle.ts: a package as one JSON document (docs/design/publishing.md; spec 4.6, 5.9, 6.10, 7.9, 10.6,
// 11.6, 12.7, 14.11). Writers turn what the text readers produced into the JSON forms; the printer turns
// the JSON forms back into the text form, so the text readers stay the one parser and a bundle is read by
// printing it and reading the text. The hash is over the canonical form without `hash` and `sig`; the
// signature is Ed25519 over the hash's bytes, as a log entry's is (8.5).

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { type Edge, type MenuItem, type Permissions, readAccess } from "./access.ts";
import { serialize } from "./canonical.ts";
import { type ClassDef, type ClassLine, type Dictionary, emptyDictionary, type Facet, type KindDef, type PartSlot, readDefinitions } from "./defs.ts";
import { facetJson } from "./dictionary.ts";
import { type Recipe, readRecipes, type Step } from "./migrate.ts";
import type { Json, JsonObject } from "./model.ts";
import { type PackageInfo, readPackages } from "./packages.ts";
import { readRules, type Rule } from "./rules.ts";
import { type Contract, type Keys, readContracts, sha256 } from "./store.ts";
import { type Filter, readViews, type Shape, type View, type ViewSet } from "./views.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Everything the readers make of one package's text. */
export type Parsed = { info: PackageInfo; dict: Dictionary; rules: Rule[]; contracts: Contract[]; views: ViewSet; perms: Permissions; edges: Edge[]; recipes: Recipe[] };

/** Read a package's text with every reader. */
export function parsePackage(source: string): Parsed {
  const [info] = readPackages(source);
  if (!info) throw new Error("no package header");
  const dict = readDefinitions(source);
  const { perms, edges } = readAccess(source);
  return { info, dict, rules: readRules(source), contracts: readContracts(source), views: readViews(source), perms, edges, recipes: readRecipes(source) };
}

// ─── Writers: the JSON forms ─────────────────────────────────────────────────

const PRECISION_CODE: { [p: string]: string } = { year: "y", month: "ym", day: "ymd", hour: "ymdh", minute: "ymdhm", second: "ymdhms", any: "any" };

export function kindJson(dict: Dictionary, k: KindDef): JsonObject {
  const o: JsonObject = { kind: k.name, levels: [...k.levels] };
  if (k.base) o.base = k.base;
  if (k.schema) o.schema = k.schema;
  const vary: JsonObject = {};
  for (const level of k.levels) {
    const keys = dict.vary.get(level);
    if (keys?.size) vary[level] = [...keys];
  }
  if (Object.keys(vary).length) o.vary = vary;
  if (k.follows) o.follows = { ...k.follows };
  const identify: JsonObject = {};
  const match: JsonObject = {};
  for (const level of k.levels) {
    const i = dict.identify.get(level);
    if (i?.length) identify[level] = [...i];
    const m = dict.match.get(level);
    if (m?.length) match[level] = m.map((g) => [...g]);
  }
  if (Object.keys(identify).length) o.identify = identify;
  if (Object.keys(match).length) o.match = match;
  const archive = dict.archive.get(k.name);
  if (archive) o.archive = archive;
  return o;
}

export function classLineJson(l: ClassLine): JsonObject {
  const o: JsonObject = { facet: l.facet };
  if (l.required) o.required = true;
  if (l.values) o.values = [...l.values];
  if (l.length !== undefined) o.length = String(l.length);
  if (l.pick !== undefined) o.pick = l.pick;
  if (l.range) o.range = { min: l.range.min, max: l.range.max };
  if (l.precision) o.precision = l.precision;
  if (l.level) o.level = l.level;
  if (l.when) o.when = l.when;
  if (l.frame) o.frame = l.frame;
  return o;
}

export function classJson(c: ClassDef): JsonObject {
  const o: JsonObject = { class: c.name };
  if (c.label) o.label = c.label;
  if (c.describe) o.describe = c.describe;
  if (c.for.length) o.for = [...c.for];
  if (c.uses.length) o.uses = [...c.uses];
  const lines: JsonObject[] = [];
  let section: string | undefined;
  for (const l of c.lines) {
    if (l.section !== section) {
      section = l.section;
      if (section) lines.push({ section });
    }
    lines.push(classLineJson(l));
  }
  o.facets = lines;
  if (c.parts.length) o.parts = c.parts.map((p: PartSlot): JsonObject => ({ slot: p.slot, wears: p.wears, pick: p.many ? "any" : "1", ...(p.fungible ? { fungible: true } : {}), ...(p.match ? { match: p.match } : {}) }));
  if (c.state && c.state !== "active") o.state = c.state;
  if (c.version) o.version = c.version;
  return o;
}

export function ruleJson(r: Rule): JsonObject {
  const o: JsonObject = { rule: r.name };
  if (r.for !== "everywhere") o.for = r.for;
  if (r.whenText) o.when = r.whenText;
  o.then = r.thenText;
  o.strength = r.strength;
  if (r.because) o.because = r.because;
  if (r.version) o.version = r.version;
  return o;
}

const mapJson = (m: Contract["reads"][number]): JsonObject => ({
  ...(m.from.startsWith('"') ? { literal: JSON.parse(m.from) as string } : { from: m.from }),
  to: m.to,
  ...(m.values.length ? { values: m.values.map(([from, to]) => ({ from, to })) } : {}),
});

export function contractJson(c: Contract): JsonObject {
  const o: JsonObject = { contract: c.name, kind: c.kind };
  for (const k of ["label", "describe", "for"]) if (c.parts[k] !== undefined) o[k] = c.parts[k] as string;
  if (c.needs.length) o.needs = c.needs.map(classLineJson);
  if (c.gives.length) o.gives = [...c.gives];
  if (c.stores.length) o.stores = c.stores.map(mapJson);
  else {
    if (c.writes.length) o.writes = c.writes.map(mapJson);
    if (c.reads.length) o.reads = c.reads.map(mapJson);
  }
  if (c.stream.length) o.stream = [...c.stream];
  for (const k of ["when", "who", "from", "to", "mode", "undo", "ref", "prefix"] as const) if (c[k]) o[k] = c[k] as string;
  // origin is a part of the kinds that bring values in (7.2); the reader defaults it for the rest.
  if (c.origin && ["receive", "form", "take"].includes(c.kind)) o.origin = c.origin;
  if (c.lands !== "value") o.lands = c.lands;
  if (!c.absorb) o.absorb = false;
  if (c.ignore.length) o.ignore = [...c.ignore];
  if (c.keepRaw.length) o["keep-raw"] = [...c.keepRaw];
  for (const [k, v] of Object.entries(c.parts)) {
    if (["label", "describe", "for", "needs", "gives", "writes", "reads", "stream", "when", "who", "from", "to", "mode", "undo", "ref", "origin", "prefix", "lands", "absorb", "ignore", "keep-raw", "kind"].includes(k)) continue;
    if (k === "retry") {
      const m = v.match(/^(\d+)\s+every\s+(\S+)$/);
      o.retry = m ? { times: m[1] as string, every: m[2] as string } : v;
    } else o[k] = v;
  }
  return o;
}

export function recipeJson(r: Recipe): JsonObject {
  const steps = r.steps.map((s: Step): JsonObject => {
    const o: JsonObject = { facet: s.facet };
    switch (s.verb) {
      case "rename":
      case "precision":
      case "retype":
        o[s.verb] = { from: s.from, to: s.to };
        break;
      case "merge":
        o.merge = { from: [...s.from], to: s.to };
        break;
      case "convert":
        o.convert = { from: s.from, to: s.to, rounding: s.rounding };
        break;
      case "split":
        o.split = { value: s.value, when: s.when.map((w) => ({ if: w.cond, to: w.to })), ...(s.else !== undefined ? { else: s.else } : {}) };
        break;
      case "move":
        o.move = { to: s.to };
        break;
      case "review":
        o.review = s.cond;
        break;
      case "recompute":
        o.recompute = true;
        break;
    }
    return o;
  });
  return { migration: { from: r.from, to: r.to }, steps };
}

export function shapeJson(s: Shape): JsonObject {
  return { shape: s.name, slots: s.slots.map((sl) => ({ ...(sl.from.startsWith('"') ? { template: JSON.parse(sl.from) as string } : { from: sl.from }), to: sl.to, ...(sl.required ? { required: true } : {}) })) };
}

export function filterJson(f: Filter): JsonObject {
  const o: JsonObject = { filter: f.name, facet: f.facet };
  if (f.buckets) o.buckets = f.buckets.map((b): JsonObject => (b.range ? { name: b.name, range: { min: String(b.range[0]), max: String(b.range[1]) } } : { name: b.name, values: [...(b.values ?? [])] }));
  if (f.dependent.length) o.dependent = [...f.dependent];
  return o;
}

export function viewJson(v: View): JsonObject {
  const select: JsonObject = {};
  if (v.level) select.level = v.level;
  if (v.wears.length) select.wears = [...v.wears];
  if (v.when) select.when = v.when;
  if (v.list) select.list = v.list;
  const o: JsonObject = { view: v.name, select };
  if (v.partition) o.partition = v.partition;
  if (v.of) o.of = v.of;
  if (v.pin.length) o.pin = [...v.pin];
  if (v.hide.length) o.hide = [...v.hide];
  if (v.order.length) o.order = v.order.map((x) => ({ key: x.key, dir: x.dir }));
  if (v.page !== 24) o.page = String(v.page);
  o.shape = v.shapes.length === 1 ? (v.shapes[0] as string) : [...v.shapes];
  if (v.filters.length) o.filters = [...v.filters];
  if (v.index.length) o.index = [...v.index];
  if (v.show !== "public") o.show = v.show;
  if (v.fresh !== "write") o.fresh = v.fresh;
  if (v.version) o.version = v.version;
  return o;
}

/** The `role:` blocks, from the presets and menu items the access reader made of them (12.4). */
export function rolesJson(perms: Permissions): JsonObject[] {
  const out: JsonObject[] = [];
  for (const p of perms.presets.values()) {
    const own = p.items.filter((i) => i.startsWith(`${p.name}.`));
    if (!own.length || own.length !== p.items.length) continue;
    const may: JsonObject = {};
    for (const i of own) {
      const item = perms.menu.get(i);
      if (item) for (const [verb, targets] of Object.entries(item.verbs)) may[verb] = [...targets];
    }
    out.push({ role: p.name, audience: p.audience, may });
  }
  return out;
}

export function permissionsJson(perms: Permissions): JsonObject | undefined {
  const roleItems = new Set(rolesJson(perms).flatMap((r) => Object.keys(r.may as JsonObject).map((v) => `${r.role}.${v}`)));
  const menu: JsonObject = {};
  for (const m of perms.menu.values()) if (!roleItems.has(m.name)) menu[m.name] = { verbs: Object.fromEntries(Object.entries(m.verbs).map(([v, t]) => [v, [...t]])), ...(m.on ? { on: m.on } : {}) };
  const presets: JsonObject = {};
  for (const p of perms.presets.values()) if (!roleItems.has(`${p.name}.${Object.keys((perms.menu.get(p.items[0] ?? "") as MenuItem | undefined)?.verbs ?? {})[0]}`) && !p.items.every((i) => roleItems.has(i))) presets[p.name] = { items: [...p.items], audience: p.audience };
  const relations: JsonObject = {};
  for (const [r, v] of perms.relations) relations[r] = v.only ? { only: true } : {};
  if (!perms.name && !Object.keys(menu).length && !Object.keys(relations).length) return undefined;
  return { permissions: perms.name ?? "", menu, presets, relations };
}

/** The whole package as the JSON document, without `hash` and `sig`. */
export function bundleOf(p: Parsed): JsonObject {
  const { info, dict } = p;
  const o: JsonObject = { crubal: String(info.crubal), package: info.name, version: info.version, owner: info.owner, id: `${info.owner}/${info.name}` };
  for (const k of ["label", "describe", "licence"]) if (info.header[k]) o[k] = info.header[k] as string;
  if (info.extends.length) o.extends = info.extends.map((e) => ({ package: e.name, version: e.version }));
  if (info.prefixes.size) o.prefixes = Object.fromEntries([...info.prefixes].map(([k, v]) => [k, v.target]));
  if (info.header.units) {
    const [pkg = "", ver = ""] = info.header.units.split(/\s+\//).map((s) => s.trim());
    o.units = { package: pkg, version: ver };
  }
  for (const k of ["confirm", "split", "recur"]) if (info.header[k]) o[k] = info.header[k] as string;
  if (dict.trust.length) o.trust = [...dict.trust];
  if (dict.facetTrust.size) o["facet-trust"] = Object.fromEntries([...dict.facetTrust].map(([k, v]) => [k, [...v]]));
  if (Object.keys(info.terms).length) o.terms = { ...info.terms };
  const members: JsonObject = {};
  const facets = [...dict.facets.values()].filter((f) => !f.key.includes(":") || info.name === "core");
  for (const f of facets) if (f.version) members[`facet:${f.key}`] = f.version;
  for (const c of dict.classes.values()) if (c.version) members[`class:${c.name}`] = c.version;
  for (const r of p.rules) if (r.version) members[`rule:${r.name}`] = r.version;
  for (const c of p.contracts) if (c.parts.version) members[`contract:${c.name}`] = c.parts.version;
  for (const v of p.views.views.values()) if (v.version) members[`view:${v.name}`] = v.version;
  o.members = members;
  if (dict.kinds.size) o.kinds = [...dict.kinds.values()].map((k) => kindJson(dict, k));
  if (facets.length) o.facets = facets.map(facetJson);
  if (dict.classes.size) o.classes = [...dict.classes.values()].map(classJson);
  if (p.rules.length) o.rules = p.rules.map(ruleJson);
  if (p.contracts.length) o.contracts = p.contracts.map(contractJson);
  if (p.views.shapes.size) o.shapes = [...p.views.shapes.values()].map(shapeJson);
  if (p.views.filters.size) o.filters = [...p.views.filters.values()].map(filterJson);
  if (p.views.views.size) o.views = [...p.views.views.values()].map(viewJson);
  const roles = rolesJson(p.perms);
  if (roles.length) o.roles = roles;
  const perms = permissionsJson(p.perms);
  if (perms) o.permissions = perms;
  if (p.perms.ownership.size) o.ownership = Object.fromEntries([...p.perms.ownership].map(([k, v]) => [k, [...v]]));
  if (p.perms.emergency) o.emergency = { approvers: String(p.perms.emergency.approvers), longest: p.perms.emergency.longest };
  if (p.recipes.length) o.recipes = p.recipes.map(recipeJson);
  return o;
}

// ─── Printer: the JSON forms back to the text form ───────────────────────────

/** Quote a value when the text form would otherwise misread it (2.5). */
export function q(s: string): string {
  if (s === "" || /^[&_\-\["{]|^\.\.\.$/.test(s) || /, |: | \/\/|[\n\r\t]/.test(s) || /^\s|\s$/.test(s) || /^-?\d/.test(s) && false) return JSON.stringify(s);
  return s;
}
const list = (xs: Json[] | undefined) => (xs ?? []).map((x) => q(String(x))).join(", ");
const str = (v: Json | undefined) => (v === undefined ? undefined : typeof v === "string" ? v : String(v));

function facetText(f: JsonObject, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const out = [`${pad}facet: ${f.facet}`];
  const line = (k: string, v: string | undefined) => { if (v !== undefined) out.push(`${pad}  ${k}: ${v}`); };
  line("type", str(f.type));
  for (const k of ["label", "ask", "describe"]) if (typeof f[k] === "string") line(k, q(f[k] as string));
  line("pick", str(f.pick));
  if (f.ordered === true) line("ordered", "yes");
  line("state", str(f.state));
  if (Array.isArray(f.qualifiers)) line("qualifiers", list(f.qualifiers));
  if (Array.isArray(f.aliases)) line("aliases", list(f.aliases));
  if (Array.isArray(f["same-as"])) line("same-as", list(f["same-as"]));
  line("agree-by", str(f["agree-by"]));
  line("length", str(f.length));
  line("unit", str(f.unit));
  if (Array.isArray(f.accepts)) line("accepts", list(f.accepts));
  if (isObj(f.range)) line("range", `${f.range.min}..${f.range.max}${f.range.step ? ` step ${f.range.step}` : ""}`);
  line("places", str(f.places));
  line("precision", str(f.precision));
  line("zone", str(f.zone));
  if (Array.isArray(f.words)) line("words", list(f.words));
  if (Array.isArray(f.values)) {
    const vals = f.values.map((v) => (isObj(v) ? [q(String(v.value)), ...((v.aliases as string[] | undefined) ?? []).map((a) => `~${q(a)}`)].join(" ") : q(String(v))));
    if (f.open === true) vals.push("...");
    line("values", vals.join(", "));
  }
  for (const k of ["fixed", "ranked", "scored", "required", "na", "unique"]) if (f[k] === true) line(k, "yes");
  line("to", str(f.to));
  if (Array.isArray(f.facets)) {
    out.push(`${pad}  facets:`);
    for (const c of f.facets) if (isObj(c)) out.push(...facetText(c, depth + 2));
  }
  line("identity", str(f.identity));
  if (typeof f.when === "string") line("when", f.when);
  line("combine", str(f.combine));
  line("version", str(f.version));
  for (const [k, v] of Object.entries(f)) if (k.includes(":")) line(k, str(v));
  return out;
}

/** A class line's text from its settings (5.3), the shorthand marks in their order (4.5). */
export function lineText(l: JsonObject, type?: string): string {
  let s = `${l.required === true ? "!" : ""}${l.level ? `${l.level}::` : ""}${l.facet}`;
  if (Array.isArray(l.values)) s += `{${l.values.map((v) => q(String(v)).replace(/\|/g, "\\|")).join("|")}}`;
  if (l.length !== undefined) s += `$${l.length}`;
  if (l.pick !== undefined) s += l.pick === "any" ? "*" : `*${l.pick}`;
  if (isObj(l.range)) s += ` ${l.range.min}..${l.range.max}`;
  if (typeof l.precision === "string") s += `@${type === "time" ? (l.precision === "second" ? "hms" : "hm") : (PRECISION_CODE[l.precision] ?? l.precision)}`;
  if (typeof l.frame === "string") s += ` frame: ${l.frame}`;
  if (typeof l.when === "string") s += ` when ${l.when}`;
  return s;
}

const kv = (pad: string, k: string, v: Json | undefined) => (v === undefined ? [] : [`${pad}${k}: ${Array.isArray(v) ? list(v) : q(String(v))}`]);

function kindText(k: JsonObject): string[] {
  const out = [`kind: ${k.kind}`, ...kv("  ", "levels", k.levels), ...kv("  ", "base", k.base)];
  if (typeof k.schema === "string") out.push(`  schema: ${k.schema}`);
  else if (isObj(k.schema)) out.push("  schema:", ...Object.entries(k.schema).map(([l, t]) => `    ${l}: ${t}`));
  for (const block of ["vary", "identify"]) if (isObj(k[block])) out.push(`  ${block}:`, ...Object.entries(k[block] as JsonObject).map(([l, keys]) => `    ${l}: ${(keys as string[]).join(", ")}`));
  if (isObj(k.follows)) out.push("  follows:", ...Object.entries(k.follows).map(([a, b]) => `    ${a}: ${b}`));
  if (isObj(k.match)) out.push("  match:", ...Object.entries(k.match).map(([l, groups]) => `    ${l}: ${(groups as string[][]).map((g) => g.join(" + ")).join("; ")}`));
  out.push(...kv("  ", "archive", k.archive));
  return out;
}

function classText(c: JsonObject): string[] {
  const out = [`class: ${c.class}`, ...kv("  ", "label", c.label), ...kv("  ", "describe", c.describe), ...kv("  ", "for", c.for), ...kv("  ", "uses", c.uses), ...kv("  ", "state", c.state), ...kv("  ", "version", c.version)];
  if (Array.isArray(c.facets)) {
    out.push("  facets:");
    for (const l of c.facets) if (isObj(l)) out.push(typeof l.section === "string" ? `    section: ${q(l.section)}` : `    ${lineText(l)}`);
  }
  if (Array.isArray(c.parts)) {
    out.push("  parts:");
    for (const p of c.parts) if (isObj(p)) out.push(`    ${p.slot}: ${p.wears}${p.pick === "any" ? " *" : ""}${p.fungible === true ? " fungible: yes" : ""}${p.match ? ` match: ${p.match}` : ""}`);
  }
  return out;
}

const mapText = (m: JsonObject): string[] => [`    ${typeof m.literal === "string" ? JSON.stringify(m.literal) : m.from} -> ${m.to}`, ...((m.values as JsonObject[] | undefined) ?? []).map((v) => `      ${q(String(v.from))} -> ${q(String(v.to))}`)];

function contractText(c: JsonObject): string[] {
  const out = [`contract: ${c.contract}`, ...kv("  ", "kind", c.kind)];
  for (const k of ["label", "describe", "for"]) out.push(...kv("  ", k, c[k]));
  if (Array.isArray(c.needs)) out.push("  needs:", ...c.needs.map((l) => `    ${lineText(l as JsonObject)}`));
  for (const k of ["writes", "reads", "stores"]) if (Array.isArray(c[k])) out.push(`  ${k}:`, ...(c[k] as JsonObject[]).flatMap(mapText));
  for (const k of ["gives", "stream", "when", "who", "from", "to", "mode", "undo", "ref", "origin", "prefix", "lands", "ignore", "keep-raw"]) out.push(...kv("  ", k, c[k]));
  if (c.absorb === false) out.push("  absorb: no");
  for (const [k, v] of Object.entries(c)) {
    if (["contract", "kind", "label", "describe", "for", "needs", "writes", "reads", "stores", "gives", "stream", "when", "who", "from", "to", "mode", "undo", "ref", "origin", "prefix", "lands", "ignore", "keep-raw", "absorb"].includes(k)) continue;
    if (k === "retry" && isObj(v)) out.push(`  retry: ${v.times} every ${v.every}`);
    else out.push(...kv("  ", k, v));
  }
  return out;
}

function ruleText(r: JsonObject): string[] {
  return [`rule: ${r.rule}`, ...kv("  ", "for", r.for), ...(typeof r.when === "string" ? [`  when: ${r.when}`] : []), `  then: ${r.then}`, ...kv("  ", "strength", r.strength), ...kv("  ", "because", r.because), ...kv("  ", "version", r.version)];
}

function recipeText(r: JsonObject): string[] {
  const m = r.migration as JsonObject;
  const out = [`migration: ${m.from} -> ${m.to}`];
  let facet: string | undefined;
  for (const s of (r.steps as JsonObject[]) ?? []) {
    if (s.facet !== facet) {
      facet = String(s.facet);
      out.push(`  facet: ${facet}`);
    }
    for (const verb of ["rename", "precision", "retype"]) if (isObj(s[verb])) out.push(`    ${verb}: ${q(String((s[verb] as JsonObject).from))} -> ${q(String((s[verb] as JsonObject).to))}`);
    if (isObj(s.merge)) out.push(`    merge: ${list(s.merge.from as Json[])} -> ${q(String(s.merge.to))}`);
    if (isObj(s.convert)) out.push(`    convert: ${s.convert.from} -> ${s.convert.to}`, ...(s.convert.rounding && s.convert.rounding !== "nearest" ? [`    rounding: ${s.convert.rounding}`] : []));
    if (isObj(s.split)) out.push(`    split: ${q(String(s.split.value))}`, ...((s.split.when as JsonObject[]) ?? []).map((w) => `      when: ${w.if} -> ${q(String(w.to))}`), ...(s.split.else !== undefined ? [`      else: ${q(String(s.split.else))}`] : []));
    if (isObj(s.move)) out.push(`    move: -> ${s.move.to}`);
    if (typeof s.review === "string") out.push(`    review: ${s.review}`);
    if (s.recompute === true) out.push("    recompute");
  }
  return out;
}

const shapeText = (s: JsonObject): string[] => [`shape: ${s.shape}`, "  slots:", ...((s.slots as JsonObject[]) ?? []).map((sl) => `    ${sl.required === true ? "!" : ""}${typeof sl.template === "string" ? JSON.stringify(sl.template) : sl.from} -> ${sl.to}`)];

function filterText(f: JsonObject): string[] {
  const out = [`filter: ${f.filter}`, `  facet: ${f.facet}`];
  if (Array.isArray(f.buckets)) out.push("  buckets:", ...f.buckets.map((b) => { const bb = b as JsonObject; const name = /[\s:]/.test(String(bb.name)) ? JSON.stringify(bb.name) : String(bb.name); return isObj(bb.range) ? `    ${name}: ${bb.range.min}..${bb.range.max}` : `    ${name}: ${list(bb.values as Json[])}`; }));
  out.push(...kv("  ", "dependent", f.dependent));
  return out;
}

function viewText(v: JsonObject): string[] {
  const sel = (v.select ?? {}) as JsonObject;
  const out = [`view: ${v.view}`, "  select:", ...kv("    ", "level", sel.level), ...kv("    ", "wears", sel.wears), ...(typeof sel.when === "string" ? [`    when: ${sel.when}`] : []), ...kv("    ", "list", sel.list)];
  if (!Object.keys(sel).length) out.pop();
  out.push(...kv("  ", "partition", v.partition), ...(typeof v.of === "string" ? [`  of: ${v.of}`] : []), ...kv("  ", "pin", v.pin), ...kv("  ", "hide", v.hide));
  if (Array.isArray(v.order)) out.push(`  order: ${(v.order as JsonObject[]).map((o) => `${o.key} ${o.dir}`).join(", ")}`);
  out.push(...kv("  ", "page", v.page), ...kv("  ", "shape", v.shape), ...kv("  ", "filters", v.filters), ...kv("  ", "index", v.index), ...kv("  ", "show", v.show), ...kv("  ", "fresh", v.fresh), ...kv("  ", "version", v.version));
  return out;
}

const roleText = (r: JsonObject): string[] => [`role: ${r.role}`, `  audience: ${r.audience}`, "  may:", ...Object.entries((r.may as JsonObject) ?? {}).map(([verb, t]) => `    ${verb}: ${(t as string[]).join(", ")}`)];

function permissionsText(p: JsonObject): string[] {
  const out = [`permissions: ${p.permissions}`];
  const menu = (p.menu ?? {}) as JsonObject;
  if (Object.keys(menu).length) out.push("  menu:", ...Object.entries(menu).map(([name, item]) => { const it = item as JsonObject; const verbs = Object.entries((it.verbs as JsonObject) ?? {}).map(([v, t]) => `${v} ${(t as string[]).join(" ")}`).join(", "); return `    ${name}: ${verbs}${it.on ? ` on: ${it.on}` : ""}`; }));
  const presets = (p.presets ?? {}) as JsonObject;
  if (Object.keys(presets).length) out.push("  presets:", ...Object.entries(presets).map(([name, pr]) => `    ${name}: ${((pr as JsonObject).items as string[]).join(", ")} audience: ${(pr as JsonObject).audience}`));
  const rel = (p.relations ?? {}) as JsonObject;
  if (Object.keys(rel).length) out.push(`  relations: ${Object.entries(rel).map(([r, v]) => ((v as JsonObject).only === true ? `${r} only` : r)).join(", ")}`);
  return out;
}

/** The text form of a bundle: the package header, then every member, in the long form. */
export function printBundle(b: JsonObject): string {
  const out: string[] = [`package: ${b.package} /${b.version}`];
  out.push(...kv("  ", "owner", b.owner), ...kv("  ", "label", b.label), ...kv("  ", "describe", b.describe), `  crubal: ${b.crubal ?? "2"}`, ...kv("  ", "licence", b.licence));
  if (Array.isArray(b.extends)) out.push(`  extends: ${(b.extends as JsonObject[]).map((e) => `${e.package} /${e.version}`).join(", ")}`);
  if (isObj(b.prefixes)) out.push("  prefixes:", ...Object.entries(b.prefixes).map(([k, v]) => `    ${k}: ${v}`));
  if (isObj(b.units)) out.push(`  units: ${b.units.package} /${b.units.version}`);
  for (const k of ["confirm", "split", "recur"]) out.push(...kv("  ", k, b[k]));
  if (isObj(b.terms)) out.push("  terms:", ...Object.entries(b.terms).map(([a, t]) => `    ${a}: ${t}`));
  out.push("");
  if (Array.isArray(b.trust)) out.push("trust:", ...(b.trust as string[]).map((t) => `  ${t}`), "");
  if (isObj(b["facet-trust"])) out.push("facet-trust:", ...Object.entries(b["facet-trust"]).map(([k, v]) => `  ${k}: ${(v as string[]).join(", ")}`), "");
  const blocks = (key: string, fn: (x: JsonObject) => string[]) => { for (const x of (b[key] as JsonObject[] | undefined) ?? []) out.push(...fn(x), ""); };
  blocks("kinds", kindText);
  blocks("facets", (f) => facetText(f, 0));
  blocks("classes", classText);
  blocks("rules", ruleText);
  blocks("contracts", contractText);
  blocks("recipes", recipeText);
  blocks("shapes", shapeText);
  blocks("filters", filterText);
  blocks("views", viewText);
  blocks("roles", roleText);
  if (isObj(b.permissions)) out.push(...permissionsText(b.permissions), "");
  if (isObj(b.ownership)) out.push("ownership:", ...Object.entries(b.ownership).map(([k, v]) => `  ${k}: ${(v as string[]).join(", ")}`), "");
  if (isObj(b.emergency)) out.push("emergency:", `  approvers: ${b.emergency.approvers}`, `  longest: ${b.emergency.longest}`, "");
  return `${out.join("\n").trimEnd()}\n`;
}

/** Read a bundle: print it to text and read the text, so there is one parser. */
export function readBundle(b: JsonObject): Parsed & { text: string } {
  const text = printBundle(b);
  return { ...parsePackage(text), text };
}

/** Read a bundle's definitions into a dictionary that already holds what the package extends. */
export function readBundleInto(b: JsonObject, into: Dictionary = emptyDictionary()): Dictionary {
  return readDefinitions(printBundle(b), into);
}

/** An empty Parsed to read packages onto, in order. */
export function emptyParsed(): Parsed {
  const { perms } = readAccess("");
  return { info: { name: "", version: "", owner: "", line: 0, crubal: 2, crubalLine: 0, extends: [], prefixes: new Map(), trust: [], dict: emptyDictionary(), contracts: [], header: {}, terms: {} }, dict: emptyDictionary(), rules: [], contracts: [], views: { shapes: new Map(), filters: new Map(), views: new Map(), roles: new Map(), shown: new Map() }, perms, edges: [], recipes: [] };
}

/**
 * Read a bundle onto what is already read (the packages it extends, or the installed packages before the
 * owner's own definitions): the dictionary grows, and a member of the same name replaces the earlier one.
 */
export function readBundleOnto(bundle: JsonObject, base: Parsed): Parsed {
  const text = printBundle(bundle);
  readDefinitions(text, base.dict);
  const [info] = readPackages(text);
  if (info) base.info = { ...info, dict: base.dict, terms: Object.keys(info.terms).length ? info.terms : base.info.terms };
  const byName = <T extends { name: string }>(have: T[], next: T[]) => [...have.filter((h) => !next.some((n) => n.name === h.name)), ...next];
  base.rules = byName(base.rules, readRules(text));
  base.contracts = byName(base.contracts, readContracts(text));
  const views = readViews(text);
  for (const k of ["shapes", "filters", "views", "roles", "shown"] as const) for (const [key, val] of views[k]) (base.views[k] as Map<string, unknown>).set(key, val);
  const { perms, edges } = readAccess(text);
  if (perms.name) base.perms.name = perms.name;
  for (const [k, v] of perms.menu) base.perms.menu.set(k, v);
  for (const [k, v] of perms.presets) base.perms.presets.set(k, v);
  for (const [k, v] of perms.relations) base.perms.relations.set(k, v);
  for (const [k, v] of perms.ownership) base.perms.ownership.set(k, v);
  if (perms.emergency) base.perms.emergency = perms.emergency;
  base.edges.push(...edges);
  base.recipes.push(...readRecipes(text));
  return base;
}

// ─── Hash, sign, verify ──────────────────────────────────────────────────────

export function bundleHash(b: JsonObject): string {
  const { hash: _h, sig: _s, ...rest } = b;
  return sha256(serialize(rest));
}

/** Sign a bundle with the owner's Ed25519 private key (the JWK `d`, base64url); sets `hash` and `sig`. */
export function signBundle(b: JsonObject, privateD: string, publicX: string): JsonObject {
  const hash = bundleHash(b);
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: publicX, d: privateD }, format: "jwk" });
  const sig = edSign(null, Buffer.from(hash, "hex"), key).toString("base64url");
  return { ...b, hash: `sha256:${hash}`, sig };
}

/** Check a bundle's hash and, with the owner's published key, its signature. */
export function verifyBundle(b: JsonObject, keys?: Keys): { valid: boolean; reason?: string } {
  const hash = bundleHash(b);
  if (b.hash !== `sha256:${hash}`) return { valid: false, reason: "hash" };
  const owner = String(b.owner ?? "");
  const k = keys?.[owner];
  if (!k) return keys ? { valid: false, reason: "no key" } : { valid: true };
  if (k.alg !== "Ed25519" || typeof b.sig !== "string") return { valid: false, reason: "signature" };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.public }, format: "jwk" });
  return edVerify(null, Buffer.from(hash, "hex"), key, Buffer.from(b.sig, "base64url")) ? { valid: true } : { valid: false, reason: "signature" };
}
