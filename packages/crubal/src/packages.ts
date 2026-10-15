// packages.ts: package files (spec chapter 11). A file may hold several packages, each starting at a
// `package:` line. The checks here are 11.1's prefixes, 11.3's trust entries and 11.4's rule that an
// extending package may add to what it extends but never change it.

import { type Dictionary, emptyDictionary, type Facet, readDefinitions } from "./defs.ts";
import { LANGUAGE } from "./read-text.ts";
import { readContracts } from "./store.ts";
import { CrubalError, readTree } from "./tree.ts";

export type PackageInfo = {
  name: string;
  version: string;
  owner: string;
  line: number;
  /** The language version it is written in (11.8), and the line that says so. */
  crubal: number;
  crubalLine: number;
  extends: { name: string; version: string; line: number }[];
  prefixes: Map<string, { target: string; line: number }>;
  trust: { entry: string; line: number }[];
  dict: Dictionary;
  contracts: string[];
  /** The rest of the header (11.1), as written. */
  header: { [key: string]: string };
  terms: { [audience: string]: string };
};

const ORIGINS = new Set(["observed", "declared", "derived", "reported"]);

/** Split a file into its packages, keeping line numbers true. */
export function readPackages(source: string): PackageInfo[] {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((l, i) => (/^package: /.test(l) ? [i] : []));
  return starts.map((start, n) => {
    const end = starts[n + 1] ?? lines.length;
    const text = lines.map((l, i) => (i >= start && i < end ? l : "")).join("\n");
    const [head, ...rest] = readTree(text);
    if (!head) throw new CrubalError("an empty package", start + 1);
    const [name = "", version = ""] = head.value.split(/\s+\//).map((s) => s.trim());
    const info: PackageInfo = { name, version, owner: "", line: head.line, crubal: LANGUAGE, crubalLine: head.line, extends: [], prefixes: new Map(), trust: [], dict: emptyDictionary(), contracts: [], header: {}, terms: {} };
    for (const c of head.children) {
      if (c.key === "owner") info.owner = c.value;
      if (c.key === "crubal") {
        info.crubal = Number(c.value);
        info.crubalLine = c.line;
      }
      if (c.key === "extends") {
        for (const e of c.value.split(",")) {
          const [en = "", ev = ""] = e.trim().split(/\s+\//);
          info.extends.push({ name: en.trim(), version: ev.trim(), line: c.line });
        }
      }
      if (c.key === "prefixes") for (const p of c.children) if (p.key) info.prefixes.set(p.key, { target: p.value, line: p.line });
      if (c.key === "terms") for (const t of c.children) if (t.key) info.terms[t.key] = t.value.trim();
      if (c.key && !["owner", "crubal", "extends", "prefixes", "terms"].includes(c.key)) info.header[c.key] = c.value.trim();
    }
    for (const node of rest) {
      if (node.key === "trust") for (const t of node.children) info.trust.push({ entry: t.text.trim(), line: t.line });
    }
    // Definitions are everything after the header block.
    const headerEnd = Math.max(start, ...head.children.flatMap(function deep(c): number[] { return [c.line - 1, ...c.children.flatMap(deep)]; }));
    const defs = text.split("\n").map((l, i) => (i > headerEnd ? l : "")).join("\n");
    readDefinitions(defs, info.dict);
    info.contracts = readContracts(defs).map((c) => c.name);
    return info;
  });
}

function sameDefinition(base: Facet, mine: Facet): string | null {
  if (base.type !== mine.type) return "type";
  if (base.pick !== mine.pick) return "pick";
  if ((base.unit ?? "") !== (mine.unit ?? "")) return "unit";
  const baseValues = (base.values ?? []).map((v) => v.value);
  const mineValues = (mine.values ?? []).map((v) => v.value);
  if (mine.values && baseValues.some((v) => !mineValues.includes(v))) return "values";
  return null;
}

/** Check every package in a file (11.1, 11.3, 11.4). Throws the first problem. */
export function checkPackages(source: string): PackageInfo[] {
  // 11.2: a kind's vary step names a level of its kind and facets of this package (a key of another package
  // carries its prefix and is checked where that package is resolved).
  {
    const d = readDefinitions(source);
    for (const [level, keys] of d.vary) {
      if (!d.levels.has(level)) throw new CrubalError(`vary names ${level}, which isn't a level`, d.varyLines.get(level));
      for (const k of keys) if (!k.includes(":") && !d.facets.has(k)) throw new CrubalError(`vary at ${level} names ${k}, which isn't a facet`, d.varyLines.get(level));
    }
  }
  const pkgs = readPackages(source);
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  for (const p of pkgs) {
    // Language versions (11.8): never above this reader's, and never extending a package above one's own.
    if (!Number.isInteger(p.crubal) || p.crubal < 1) throw new CrubalError(`${p.name}: the language version is a whole number`, p.crubalLine);
    if (p.crubal > LANGUAGE) throw new CrubalError(`${p.name} is written in CRUBAL ${p.crubal}; this reader knows ${LANGUAGE}`, p.crubalLine);
    for (const e of p.extends) {
      const base = byName.get(e.name);
      if (base && base.crubal > p.crubal) throw new CrubalError(`${p.name} (CRUBAL ${p.crubal}) extends ${e.name}, written in CRUBAL ${base.crubal}, which it couldn't read`, e.line);
    }
    for (const [prefix, { target, line }] of p.prefixes) {
      if (prefix === "crubal") throw new CrubalError("the prefix crubal is reserved for the core", line);
      if (prefix === p.name && target !== `${p.owner}/${p.name}`) throw new CrubalError(`${p.name} can't map its own name to something else`, line);
    }
    for (const { entry, line } of p.trust) {
      if (entry === "person" || ORIGINS.has(entry)) continue;
      const bare = entry.startsWith(`${p.name}:`) ? entry.slice(p.name.length + 1) : entry;
      if (p.contracts.includes(bare)) continue;
      if (!entry.includes(":") && entry.includes(".")) continue; // a party's domain
      throw new CrubalError(`${entry} is not a contract of this package`, line);
    }
    for (const f of p.dict.facets.values()) {
      const m = f.key.match(/^([a-z][a-z0-9-]*):(.+)$/);
      if (!m || m[1] === "crubal") continue;
      const base = byName.get(m[1] as string);
      if (!base || !p.extends.some((e) => e.name === base.name)) continue;
      const original = base.dict.facets.get(m[2] as string);
      if (!original) continue;
      const changed = sameDefinition(original, f);
      if (changed) throw new CrubalError(`${p.name} changes ${f.key}'s ${changed}; an extending package may only add to it`, f.line);
    }
  }
  return pkgs;
}
