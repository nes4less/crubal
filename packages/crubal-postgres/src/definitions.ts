// definitions.ts: what the engine runs with, built from the store (docs/design/publishing.md): the installed
// bundles in install order (extended before extending, because a dependency is installed first), then the
// owner's working package, every `define` write as the member now stands. The publish checks run on the
// result, so a definition that breaks the set is refused before it is written.

import { checkPermissions } from "@cruba/crubal";
import { emptyParsed, type Parsed, readBundleOnto } from "@cruba/crubal";
import { checkPackage } from "@cruba/crubal";
import { checkContracts } from "@cruba/crubal";
import type { JsonObject } from "@cruba/crubal";
import { unitsExtensionText } from "@cruba/crubal";
import { extendUnits, resetUnits } from "@cruba/crubal";
import { checkRules } from "@cruba/crubal";
import { checkViews } from "@cruba/crubal";
import type { Client } from "./db.ts";

type Row = { [column: string]: unknown };

/** The owner's working package as one bundle: the define writes grouped by member kind, in log order. */
/** The owner's units extension (11.9), from the last `units` define write. */
export function unitsExtensionOf(definitions: Iterable<JsonObject>): JsonObject[] {
  let measures: JsonObject[] = [];
  for (const d of definitions) if (d.units === "extension" && Array.isArray(d.measures)) measures = d.measures as JsonObject[];
  return measures;
}

export function workingBundle(owner: string, definitions: Iterable<JsonObject>): JsonObject {
  // The member kinds that carry another kind's word come first (a filter names its facet, a view its shape,
  // a contract its kind), so each define is filed under what it is (G11).
  const sections: { [member: string]: string } = { filter: "filters", view: "views", contract: "contracts", facet: "facets", class: "classes", rule: "rules", kind: "kinds", shape: "shapes" };
  const b: JsonObject = { crubal: "2", package: "working", version: "working", owner, id: `${owner}/working` };
  // In log order, by member key: a later define of the same member replaces the earlier, a retired one
  // (8.5, 11.4) takes it out, so the working package holds each member once as it now stands.
  const members = new Map<string, { section: string; def: JsonObject }>();
  for (const d of definitions) {
    const member = Object.keys(sections).find((m) => typeof d[m] === "string");
    if (member) {
      const key = `${member}:${String(d[member])}`;
      if (d.retired === true) members.delete(key);
      else members.set(key, { section: sections[member] as string, def: d });
      continue;
    }
    if (typeof d.permissions === "string") {
      if (d.retired === true) delete b.permissions;
      else b.permissions = d;
    }
    if (d.ownership !== undefined) b.ownership = d.ownership;
  }
  for (const { section, def } of members.values()) {
    const list = (b[section] as JsonObject[] | undefined) ?? [];
    list.push(def);
    b[section] = list;
  }
  return b;
}

/** Build the definitions in force: installed bundles in order, then the working package. */
export async function definitionsOf(client: Client, owner: string, extra: JsonObject[] = []): Promise<Parsed> {
  const base = emptyParsed();
  const installed = (await client.query("select json from installed where owner = $1 order by ord", [owner])).rows as Row[];
  for (const row of installed) {
    const w = row.json as JsonObject;
    const { rows } = await client.query("select json from bundles where owner = $1 and package = $2 and version = $3", [owner, String(w.package), String(w.version)]);
    const bundle = (rows[0] as Row | undefined)?.json as JsonObject | undefined;
    if (!bundle) throw new Error(`${w.package} /${w.version} is installed but its bundle is missing`);
    readBundleOnto(bundle, base);
  }
  const defs = (await client.query("select json from definitions where owner = $1 order by ord", [owner])).rows as Row[];
  // `extra`: define writes not yet committed, so a trial (store.define) is checked as the package would stand.
  const working = [...defs.map((r) => r.json as JsonObject), ...extra];
  if (working.length) readBundleOnto(workingBundle(owner, working), base);
  // The units table in force: the standard table plus this owner's extension (one owner per process for now).
  const measures = unitsExtensionOf(working);
  resetUnits();
  if (measures.length) extendUnits(unitsExtensionText(measures));
  (base as Parsed & { units?: JsonObject[] }).units = measures;
  return base;
}

/** Every publish check (11.5) over a set of definitions. Throws the first problem. */
export function checkAll(p: Parsed): void {
  checkPackage(p.dict);
  checkRules(p.rules, p.dict);
  checkContracts(p.contracts, p.dict, "", new Set(p.views.views.keys()));
  checkViews(p.views, p.dict);
  checkPermissions(p.perms, p.dict, new Set(p.contracts.map((c) => c.name)), new Set(p.views.views.keys()));
}
