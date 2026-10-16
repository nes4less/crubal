// definitions.ts: what the engine runs with, built from the store (docs/design/publishing.md): the installed
// bundles in install order (extended before extending, because a dependency is installed first), then the
// owner's working package, every `define` write as the member now stands. The publish checks run on the
// result, so a definition that breaks the set is refused before it is written.

import { checkPermissions } from "../../crubal/src/access.ts";
import { emptyParsed, type Parsed, readBundleOnto } from "../../crubal/src/bundle.ts";
import { checkPackage } from "../../crubal/src/dictionary.ts";
import { checkContracts } from "../../crubal/src/exchange.ts";
import type { JsonObject } from "../../crubal/src/model.ts";
import { unitsExtensionText } from "../../crubal/src/review.ts";
import { extendUnits, resetUnits } from "../../crubal/src/units.ts";
import { checkRules } from "../../crubal/src/rules.ts";
import { checkViews } from "../../crubal/src/views.ts";
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
  const sections: { [member: string]: string } = { facet: "facets", class: "classes", rule: "rules", contract: "contracts", kind: "kinds", view: "views", shape: "shapes", filter: "filters" };
  const b: JsonObject = { crubal: "2", package: "working", version: "working", owner, id: `${owner}/working` };
  for (const d of definitions) {
    const member = Object.keys(sections).find((m) => typeof d[m] === "string");
    if (member) {
      const list = (b[sections[member] as string] as JsonObject[] | undefined) ?? [];
      list.push(d);
      b[sections[member] as string] = list;
      continue;
    }
    if (typeof d.permissions === "string") b.permissions = d;
    if (d.ownership !== undefined) b.ownership = d.ownership;
  }
  return b;
}

/** Build the definitions in force: installed bundles in order, then the working package. */
export async function definitionsOf(client: Client, owner: string): Promise<Parsed> {
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
  if (defs.length) readBundleOnto(workingBundle(owner, defs.map((r) => r.json as JsonObject)), base);
  // The units table in force: the standard table plus this owner's extension (one owner per process for now).
  const measures = unitsExtensionOf(defs.map((r) => r.json as JsonObject));
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
