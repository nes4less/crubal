// publish.ts: cutting a version (docs/design/publishing.md; spec 4.8, 5.11, 10.5, 11.4, 11.5). A member
// that didn't change keeps its version; one that did takes the date. A breaking change needs a recipe step
// that covers it, from the previous version to this one; a recipe is refused when nothing broke.

import { checkRecipe } from "./migrate.ts";
import { bundleHash, bundleOf, type Parsed, parsePackage, signBundle } from "./bundle.ts";
import { serialize } from "./canonical.ts";
import type { Json, JsonObject } from "./model.ts";
import { CrubalError } from "./tree.ts";

const isObj = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: Json | undefined, b: Json | undefined) => serialize((a ?? null) as Json) === serialize((b ?? null) as Json);

export type Change = { member: string; kind: "unchanged" | "safe" | "minor" | "breaking" | "new" | "retired"; why: string[]; recipe?: string[] };

/** Where a member's JSON lives in a bundle, by its `member:name` key. */
const SECTIONS: { [member: string]: [string, string] } = { facet: ["facets", "facet"], class: ["classes", "class"], rule: ["rules", "rule"], contract: ["contracts", "contract"], view: ["views", "view"], shape: ["shapes", "shape"], filter: ["filters", "filter"], kind: ["kinds", "kind"], utility: ["utilities", "utility"] };

function membersOf(b: JsonObject): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  for (const [member, [section, key]] of Object.entries(SECTIONS)) for (const x of (b[section] as JsonObject[] | undefined) ?? []) if (isObj(x)) out.set(`${member}:${x[key]}`, x);
  return out;
}

const withoutVersion = (o: JsonObject): JsonObject => {
  const { version: _v, ...rest } = o;
  return rest;
};

/** Classify a facet's change (4.8). */
function facetChange(was: JsonObject, now: JsonObject): Change {
  const why: string[] = [];
  const recipe: string[] = [];
  const st: { kind: Change["kind"] } = { kind: "unchanged" };
  const bump = (k: Change["kind"], w: string, r?: string) => {
    const rank = { unchanged: 0, safe: 1, minor: 2, breaking: 3, new: 1, retired: 3 };
    if (rank[k] > rank[st.kind]) st.kind = k;
    why.push(w);
    if (r) recipe.push(r);
  };
  const vals = (o: JsonObject) => ((o.values as JsonObject[] | undefined) ?? []).map((v) => String(v.value));
  const aliases = (o: JsonObject) => [...((o.aliases as string[] | undefined) ?? []), ...((o.values as JsonObject[] | undefined) ?? []).flatMap((v) => (v.aliases as string[] | undefined) ?? [])];
  if (!same(was.type, now.type)) bump("breaking", "type changed", "merge + review");
  for (const k of ["label", "ask", "describe", "same-as"]) if (!same(was[k], now[k])) bump("safe", `${k} changed`);
  const addedAliases = aliases(now).filter((a) => !aliases(was).includes(a));
  const removedAliases = aliases(was).filter((a) => !aliases(now).includes(a));
  if (addedAliases.length) bump("safe", `alias added: ${addedAliases.join(", ")}`);
  if (removedAliases.length) bump("minor", `alias removed: ${removedAliases.join(", ")}`);
  const addedValues = vals(now).filter((v) => !vals(was).includes(v));
  const removedValues = vals(was).filter((v) => !vals(now).includes(v));
  if (addedValues.length) bump("safe", `value added: ${addedValues.join(", ")}`);
  if (removedValues.length) bump("breaking", `value removed: ${removedValues.join(", ")}`, "rename or merge");
  if (was.open !== true && now.open === true) bump("safe", "list opened");
  if (was.open === true && now.open !== true) bump("breaking", "list closed", "review");
  if (was.fixed !== true && now.fixed === true) bump("breaking", "list fixed", "review");
  const pickN = (o: JsonObject) => (o.pick === undefined ? 1 : o.pick === "any" ? Number.POSITIVE_INFINITY : Number(o.pick));
  if (pickN(now) > pickN(was)) bump("safe", "pick widened");
  if (pickN(now) < pickN(was)) bump("breaking", "pick narrowed", "review");
  const num = (v: Json | undefined) => (v === undefined ? undefined : Number(v));
  if (num(now.length) !== num(was.length)) bump((num(now.length) ?? Number.POSITIVE_INFINITY) >= (num(was.length) ?? Number.POSITIVE_INFINITY) ? "safe" : "breaking", "length changed", "review");
  if (!same(was.range, now.range)) {
    const wr = isObj(was.range) ? was.range : undefined;
    const nr = isObj(now.range) ? now.range : undefined;
    const wider = !nr || (wr && Number(nr.min) <= Number(wr.min) && Number(nr.max) >= Number(wr.max));
    bump(wider ? "safe" : "breaking", "range changed", wider ? undefined : "review");
  }
  const PREC = ["year", "month", "day", "hour", "minute", "second"];
  if (!same(was.precision, now.precision)) {
    const w = was.precision === undefined ? "any" : String(was.precision);
    const n = now.precision === undefined ? "any" : String(now.precision);
    bump(n === "any" || (w !== "any" && PREC.indexOf(n) >= PREC.indexOf(w)) ? "safe" : "breaking", "precision changed", "review");
  }
  if (num(now.places) !== num(was.places)) bump((num(now.places) ?? Number.POSITIVE_INFINITY) >= (num(was.places) ?? Number.POSITIVE_INFINITY) ? "safe" : "breaking", "places changed", "review");
  if (!same(was.unit, now.unit)) bump("breaking", "unit changed", "convert");
  if (was.required !== true && now.required === true) bump("breaking", "required added", "review");
  if (was.state !== "retired" && now.state === "retired") bump("retired", "retired", "review or move");
  if (was.state === "candidate" && (now.state ?? "active") === "active") bump("safe", "promoted");
  if (!same(was.combine, now.combine)) bump("breaking", "combine changed", "recompute");
  for (const k of ["unique", "na", "when", "to", "identity", "agree-by", "ordered", "ranked", "scored", "words", "qualifiers", "accepts", "zone", "facets", "transitions"]) if (!same(was[k], now[k])) bump(k === "unique" || k === "when" ? "breaking" : "safe", `${k} changed`, k === "unique" || k === "when" ? "review" : undefined);
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (k.includes(":") && !same(was[k], now[k])) bump("safe", `${k} changed`);
  return { member: `facet:${now.facet}`, kind: st.kind, why, ...(recipe.length ? { recipe } : {}) };
}

/** Classify a class's change (5.11). */
function classChange(was: JsonObject, now: JsonObject): Change {
  const why: string[] = [];
  const st: { kind: Change["kind"] } = { kind: "unchanged" };
  const bump = (k: Change["kind"], w: string) => {
    const rank = { unchanged: 0, safe: 1, minor: 2, breaking: 3, new: 1, retired: 3 };
    if (rank[k] > rank[st.kind]) st.kind = k;
    why.push(w);
  };
  const lines = (o: JsonObject) => new Map(((o.facets as JsonObject[] | undefined) ?? []).filter((l) => typeof l.facet === "string").map((l) => [`${l.level ? `${l.level}::` : ""}${l.facet}`, l]));
  for (const k of ["label", "describe"]) if (!same(was[k], now[k])) bump("safe", `${k} changed`);
  const wl = lines(was);
  const nl = lines(now);
  for (const [k, l] of nl) {
    const w = wl.get(k);
    if (!w) {
      bump(l.level && !wl.has(k.replace(/^\w+::/, "")) ? "safe" : "safe", `line added: ${k}`);
      continue;
    }
    if (w.required !== true && l.required === true) bump("breaking", `${k} made required`);
    if (Array.isArray(l.values) && (!Array.isArray(w.values) || (w.values as string[]).some((v) => !(l.values as string[]).includes(v)))) bump("breaking", `${k} values narrowed`);
    if (Array.isArray(w.values) && Array.isArray(l.values) && (l.values as string[]).some((v) => !(w.values as string[]).includes(v))) bump("safe", `${k} values widened`);
    if (l.length !== undefined && (w.length === undefined || Number(l.length) < Number(w.length))) bump("breaking", `${k} length narrowed`);
    if (!same(w.when, l.when)) bump("safe", `${k} when changed`);
  }
  for (const k of wl.keys()) if (!nl.has(k)) {
    // A plain line removed leaves values unasked (safe); a level line removed stops projecting the key to the
    // records below, and that change MUST carry its instruction (10.7).
    if (k.includes("::")) bump("breaking", `projection stopped: ${k}`);
    else bump("safe", `line removed: ${k} (values become unasked)`);
  }
  const wf = (was.for as string[] | undefined) ?? [];
  const nf = (now.for as string[] | undefined) ?? [];
  if (wf.length && nf.length && wf.some((k) => !nf.includes(k))) bump("breaking", "for narrowed");
  if (!wf.length && nf.length) bump("breaking", "for narrowed");
  const wu = (was.uses as string[] | undefined) ?? [];
  const nu = (now.uses as string[] | undefined) ?? [];
  if (nu.some((u) => !wu.includes(u))) bump("safe", "used class added");
  if (wu.some((u) => !nu.includes(u))) bump("safe", "used class removed");
  const slots = (o: JsonObject) => ((o.parts as JsonObject[] | undefined) ?? []).map((p) => String(p.slot));
  if (slots(was).some((s) => !slots(now).includes(s))) bump("breaking", "part slot removed");
  if (!same(was.parts, now.parts) && st.kind === "unchanged") bump("safe", "parts changed");
  if (was.state !== "retired" && now.state === "retired") bump("retired", "retired");
  const order = (o: JsonObject) => ((o.facets as JsonObject[] | undefined) ?? []).map((l) => l.section ?? l.facet).join("|");
  if (order(was) !== order(now) && st.kind === "unchanged") bump("safe", "order or sections changed");
  return { member: `class:${now.class}`, kind: st.kind, why, ...(st.kind === "breaking" ? { recipe: ["review"] } : {}) };
}

/** A show rule: its `then` is `key shown to audience` (12.4), visibility and never a test of data. */
const isShow = (rule: JsonObject): boolean => / shown to /.test(String(rule.then ?? ""));

/** Classify every member against the previous bundle. */
export function classify(previous: JsonObject | undefined, next: JsonObject): Change[] {
  const was = previous ? membersOf(previous) : new Map<string, JsonObject>();
  const now = membersOf(next);
  const out: Change[] = [];
  for (const [key, n] of now) {
    const w = was.get(key);
    if (!w) {
      // A new must rule breaks data that breaks it (4.8); every other new member is safe. A show rule
      // (`shown to`, 12.4) decides who sees a value and tests no data, so it never breaks any.
      const hard = key.startsWith("rule:") && n.strength === "must" && !isShow(n) && !!previous;
      out.push({ member: key, kind: hard ? "breaking" : "new", why: ["new"], ...(hard ? { recipe: ["review"] } : {}) });
      continue;
    }
    if (same(withoutVersion(w), withoutVersion(n))) {
      out.push({ member: key, kind: "unchanged", why: [] });
      continue;
    }
    if (key.startsWith("facet:")) out.push(facetChange(w, n));
    else if (key.startsWith("class:")) out.push(classChange(w, n));
    else if (key.startsWith("rule:")) {
      const hard = n.strength === "must" && w.strength !== "must" && !isShow(n);
      out.push({ member: key, kind: hard ? "breaking" : "safe", why: ["changed"], ...(hard ? { recipe: ["review"] } : {}) });
    }
    else out.push({ member: key, kind: "safe", why: ["changed"] });
  }
  for (const key of was.keys()) if (!now.has(key)) out.push({ member: key, kind: "retired", why: ["removed"], recipe: ["review or move"] });
  return out;
}

export type PublishOptions = { previous?: JsonObject; date: string; key?: { d: string; x: string }; records?: Json[] };

/**
 * Cut a version: versions by diff, the recipe check, `previous`, hash and signature. Throws a CrubalError
 * naming what is missing. Returns the bundle and the classification.
 */
export function publish(source: string | Parsed, o: PublishOptions): { bundle: JsonObject; changes: Change[] } {
  const parsed = typeof source === "string" ? parsePackage(source) : source;
  const b = bundleOf(parsed);
  if (o.records?.length) b.records = o.records;
  const changes = classify(o.previous, b);
  const prevMembers = (o.previous?.members ?? {}) as JsonObject;
  const members: JsonObject = {};
  // Versions: unchanged keeps the previous version; everything else takes the date (`.2`… for a second cut that day).
  let suffix = "";
  if (o.previous && String(o.previous.version).split(".")[0] === o.date) suffix = `.${Number(String(o.previous.version).split(".")[1] ?? 1) + 1}`;
  const version = `${o.date}${suffix}`;
  for (const [member, [section, key]] of Object.entries(SECTIONS)) {
    for (const x of (b[section] as JsonObject[] | undefined) ?? []) {
      const name = `${member}:${x[key]}`;
      const change = changes.find((c) => c.member === name);
      const keep = change?.kind === "unchanged" && typeof prevMembers[name] === "string";
      const v = keep ? String(prevMembers[name]) : version;
      x.version = v;
      members[name] = v;
    }
  }
  b.members = members;
  b.version = version;
  // Recipes (10.5 (5), 11.4): a breaking member needs a step that covers it, in a recipe from the previous version.
  // Every recipe's own checks (10.5 (2) to (4)) against the version it reaches: the corpus ran them, publish didn't.
  for (const r of parsed.recipes) checkRecipe(r, parsed.dict);
  const recipes = (b.recipes as JsonObject[] | undefined) ?? [];
  const from = o.previous ? `${b.package} /${o.previous.version}` : undefined;
  const to = `${b.package} /${version}`;
  const covering = recipes.filter((r) => isObj(r.migration) && r.migration.from === from && (r.migration.to === to || String(r.migration.to).startsWith(`${b.package} /`)));
  const covered = new Set(covering.flatMap((r) => ((r.steps as JsonObject[]) ?? []).map((s) => `facet:${s.facet}`)));
  const anyReview = covering.some((r) => ((r.steps as JsonObject[]) ?? []).some((s) => s.review !== undefined));
  const breaking = changes.filter((c) => c.kind === "breaking" || c.kind === "retired");
  for (const c of breaking) {
    // A class that stops projecting a key carries the instruction for it (10.7), under the version it reaches.
    const stopped = c.why.filter((w) => w.startsWith("projection stopped: ")).map((w) => w.slice("projection stopped: ".length));
    if (stopped.length) {
      const name = c.member.slice("class:".length);
      const issuers = [`class:${name}/${version}`, `class:${name}/${o.date}`];
      const have = issuers.flatMap((i) => parsed.instructions.get(i) ?? []);
      for (const line of stopped) {
        const key = line.replace(/^\w+::/, "");
        if (!have.some((i) => i.op === "-" && i.key === key)) throw new CrubalError(`${c.member} stops projecting ${line} and carries no instruction for it: needs \`instructions: class:${name}/${version}\` with \`-${key}\` (10.7)`);
      }
      if (c.why.every((w) => w.startsWith("projection stopped: "))) continue;
    }
    const ok = c.member.startsWith("facet:") ? covered.has(c.member) : anyReview || covered.size > 0;
    if (!ok) throw new CrubalError(`${c.member} is a breaking change (${c.why.join("; ")}) and no recipe from ${from ?? "the previous version"} covers it: needs ${c.recipe?.join(", ") ?? "a step"}`);
  }
  // A recipe of fills and recomputes alone is a backfill (10.3): it may ride a version where nothing broke.
  const backfill = (r: JsonObject) => ((r.steps as JsonObject[]) ?? []).every((s) => isObj(s.fill) || s.recompute === true);
  if (!breaking.length && covering.some((r) => !backfill(r))) throw new CrubalError(`a recipe from ${from} is present but nothing broke`);
  for (const r of covering) (r.migration as JsonObject).to = to;
  if (o.previous) b.previous = String(o.previous.version);
  if (o.key) return { bundle: signBundle(b, o.key.d, o.key.x), changes };
  return { bundle: { ...b, hash: `sha256:${bundleHash(b)}` }, changes };
}
