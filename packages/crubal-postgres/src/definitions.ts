import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { deserialize, serialize as v8serialize } from "node:v8";
// definitions.ts: what the engine runs with, built from the store (docs/design/publishing.md): the installed
// bundles in install order (extended before extending, because a dependency is installed first), then the
// owner's working package, every `define` write as the member now stands. The publish checks run on the
// result, so a definition that breaks the set is refused before it is written.

import { checkFlowsInForce, checkPermissions } from "@cruba/crubal";
import { emptyParsed, type Parsed, readBundleOnto } from "@cruba/crubal";
import { checkPackage } from "@cruba/crubal";
import { checkContracts } from "@cruba/crubal";
import type { JsonObject } from "@cruba/crubal";
import { unitsExtensionText } from "@cruba/crubal";
import { extendUnits, resetUnits, unitsTableWith } from "@cruba/crubal";
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
  const sections: { [member: string]: string } = { filter: "filters", view: "views", contract: "contracts", facet: "facets", class: "classes", rule: "rules", kind: "kinds", shape: "shapes", display: "displays", print: "prints" };
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

/**
 * Parsed definitions shared across stores that hold the same packages and the same working package
 * (brief 18 step 1: a host of a thousand deployments on one package set parses it once, not a thousand
 * times, and keeps one copy). Keyed by the installed versions and a hash of the define writes; a trial
 * (`extra`) is never cached. The object is read-only to its callers, as a store's own cache already was.
 */
const parsedShared = new Map<string, Parsed>();
const PARSED_SHARED_MAX = 64;

/**
 * The definitions as built, kept in the store (the speed round, 2026-11-03: every new serverless instance
 * rebuilt a place's definitions by replaying every version ever installed, 245 bundles at Media
 * Encyclopedia, each printed and parsed again). Keyed by what they were built from (the installed versions,
 * the define writes' hash) and by what wrote them (this engine's version, V8's serialization), so a stale
 * or foreign copy is never read: a miss builds as before and keeps the result. Never a trial's.
 */
const builtFormat = (() => {
  let dir = new URL(".", import.meta.url);
  for (let i = 0; i < 4; i++) {
    const at = new URL("package.json", dir);
    if (existsSync(at)) {
      const p = JSON.parse(readFileSync(at, "utf8")) as { name?: string; version?: string };
      if (p.name === "@cruba/crubal-postgres") return `engine ${p.version}|v8 ${process.versions.v8}`;
    }
    dir = new URL("..", dir);
  }
  return `engine ?|v8 ${process.versions.v8}`;
})();
let builtTable: Promise<void> | undefined;
const builtReady = (client: Client): Promise<void> => {
  builtTable ??= client
    .query("create table if not exists definitions_built (owner text primary key, key text not null, blob bytea not null, at timestamptz not null default now())")
    .then(() => undefined)
    .catch((e: unknown) => {
      builtTable = undefined;
      throw e;
    });
  return builtTable;
};
/** Run a statement that may fail without harm: inside a transaction behind a savepoint, so a failure never
 * aborts the caller's work; outside one, as it is. */
async function harmless<T>(client: Client, run: () => Promise<T>): Promise<T | undefined> {
  let inside = false;
  try {
    await client.query("savepoint definitions_built");
    inside = true;
  } catch {
    // Not in a transaction: nothing to guard.
  }
  try {
    const out = await run();
    if (inside) await client.query("release savepoint definitions_built");
    return out;
  } catch {
    if (inside) await client.query("rollback to savepoint definitions_built").catch(() => undefined);
    return undefined;
  }
}
async function readBuilt(client: Client, owner: string, key: string): Promise<Parsed | undefined> {
  return harmless(client, async () => {
    await builtReady(client);
    const { rows } = await client.query("select blob from definitions_built where owner = $1 and key = $2", [owner, key]);
    const blob = (rows[0] as { blob?: Buffer } | undefined)?.blob;
    return blob ? (deserialize(blob) as Parsed) : undefined;
  });
}
async function writeBuilt(client: Client, owner: string, key: string, parsed: Parsed): Promise<void> {
  // Kept next time when it fails; a store that can't keep it builds as before.
  await harmless(client, async () => {
    await builtReady(client);
    await client.query(
      "insert into definitions_built (owner, key, blob) values ($1, $2, $3) on conflict (owner) do update set key = excluded.key, blob = excluded.blob, at = now()",
      [owner, key, v8serialize(parsed)],
    );
  });
}

/** Each package's latest install alone, in the order of those last installs. Pure. */
export function latestInstalls<T extends { [column: string]: unknown }>(installed: T[]): T[] {
  const last = new Map<string, number>();
  installed.forEach((r, i) => last.set(String((r.json as JsonObject).package), i));
  return installed.filter((r, i) => last.get(String((r.json as JsonObject).package)) === i);
}

/** Forget this process's parsed copies (a test standing in for a new instance). */
export function forgetParsedShared(): void {
  parsedShared.clear();
}

/**
 * Build the definitions in force: installed bundles in order, then the working package. `own` asks for a
 * copy of the caller's own, never the shared one: a dry run or an install reads the next bundle onto what it
 * is given, and read onto the shared object that became every store's definitions until the key changed
 * (a dry run run three times reported its recipe three times, 2026-10-22).
 */
export async function definitionsOf(client: Client, owner: string, extra: JsonObject[] = [], own = false): Promise<Parsed> {
  const installed = (await client.query("select json from installed where owner = $1 order by ord", [owner])).rows as Row[];
  const defs = (await client.query("select json from definitions where owner = $1 order by ord", [owner])).rows as Row[];
  const key = extra.length || own ? undefined : `${installed.map((r) => `${(r.json as JsonObject).package}/${(r.json as JsonObject).version}`).join(",")}|${createHash("sha256").update(JSON.stringify(defs.map((r) => r.json))).digest("hex")}`;
  const shared = key ? parsedShared.get(key) : undefined;
  if (shared) {
    parsedShared.delete(key as string);
    parsedShared.set(key as string, shared);
    // The process units table follows the owner read last, for the facet-only readers (see below).
    const measures = (shared as Parsed & { units?: JsonObject[] }).units ?? [];
    resetUnits();
    if (measures.length) extendUnits(unitsExtensionText(measures));
    return shared;
  }
  // A new instance reads what another built (the speed round): the same installs, the same defines, the
  // same engine.
  const stored = key ? await readBuilt(client, owner, `${builtFormat}|${key}`) : undefined;
  if (stored && key) {
    parsedShared.set(key, stored);
    while (parsedShared.size > PARSED_SHARED_MAX) parsedShared.delete(parsedShared.keys().next().value as string);
    const measures = (stored as Parsed & { units?: JsonObject[] }).units ?? [];
    resetUnits();
    if (measures.length) extendUnits(unitsExtensionText(measures));
    return stored;
  }
  const base = emptyParsed();
  // The versions in force (the operator's ruling, 2026-11-03: "I don't see any reason it needs all the old
  // versions"): each package's latest install alone, standing where it was last installed, so a later install
  // still wins an overlap as before; the versions it replaced are history, never definitions.
  const current = latestInstalls(installed);
  // Every bundle the installs name, in one read (the speed round, 2026-11-03: a cold build read them one
  // query at a time, 245 at Media Encyclopedia, holding a connection the whole while); applied in the
  // installs' order as before.
  const pairs = [...new Set(current.map((r) => `${String((r.json as JsonObject).package)}\u0000${String((r.json as JsonObject).version)}`))];
  const bundles = new Map<string, JsonObject>();
  if (pairs.length) {
    const { rows } = await client.query(
      "select package, version, json from bundles where owner = $1 and (package, version) in (select * from unnest($2::text[], $3::text[]))",
      [owner, pairs.map((x) => x.split("\u0000")[0]), pairs.map((x) => x.split("\u0000")[1])],
    );
    for (const r of rows as { package: string; version: string; json: JsonObject }[]) bundles.set(`${r.package}\u0000${r.version}`, r.json);
  }
  for (const row of current) {
    const w = row.json as JsonObject;
    const bundle = bundles.get(`${String(w.package)}\u0000${String(w.version)}`);
    if (!bundle) throw new Error(`${w.package} /${w.version} is installed but its bundle is missing`);
    readBundleOnto(bundle, base);
  }
  // `extra`: define writes not yet committed, so a trial (store.define) is checked as the package would stand.
  const working = [...defs.map((r) => r.json as JsonObject), ...extra];
  if (working.length) readBundleOnto(workingBundle(owner, working), base);
  // The units table in force: the standard table plus this owner's extension (one owner per process for now).
  const measures = unitsExtensionOf(working);
  // The units table in force rides on the dictionary (11.9, per owner): the readers that hold a dictionary
  // read it there. The process table is set too, for the few readers that hold a facet alone
  // (checkScalar's unit question); that remaining path still sees the last owner read in this process.
  base.dict.units = unitsTableWith(measures.length ? unitsExtensionText(measures) : undefined);
  resetUnits();
  if (measures.length) extendUnits(unitsExtensionText(measures));
  (base as Parsed & { units?: JsonObject[] }).units = measures;
  if (key) {
    parsedShared.set(key, base);
    while (parsedShared.size > PARSED_SHARED_MAX) parsedShared.delete(parsedShared.keys().next().value as string);
    await writeBuilt(client, owner, `${builtFormat}|${key}`, base);
  }
  return base;
}

/** Every publish check (11.5) over a set of definitions. Throws the first problem. */
export function checkAll(p: Parsed): void {
  checkPackage(p.dict);
  checkRules(p.rules, p.dict);
  checkContracts(p.contracts, p.dict, "", new Set(p.views.views.keys()));
  checkViews(p.views, p.dict);
  checkPermissions(p.perms, p.dict, new Set(p.contracts.map((c) => c.name)), new Set(p.views.views.keys()));
  checkFlowsInForce(p);
}
