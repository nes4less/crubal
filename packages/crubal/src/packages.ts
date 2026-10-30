// packages.ts: package files (spec chapter 11). A file may hold several packages, each starting at a
// `package:` line. The checks here are 11.1's prefixes, 11.3's trust entries and 11.4's rule that an
// extending package may add to what it extends but never change it.

import { type Dictionary, emptyDictionary, type Facet, readDefinitions, unquote } from "./defs.ts";
import { LANGUAGE } from "./read-text.ts";
import { readContracts } from "./store.ts";
import { readAccess } from "./access.ts";
import { readViews } from "./views.ts";
import { CrubalError, type Node, readTree } from "./tree.ts";

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
  /** The utilities the package declares (11.1, `utility:` blocks). */
  utilities: Utility[];
  /** The lanes the package declares (12.10, `lane:` blocks). */
  lanes: Lane[];
};

/**
 * A utility block (11.1): a named, versioned tool a platform mounts for the presets, relations or audiences
 * it `serves`, the packages and utilities it `needs`, and the connections and settings a deployment must
 * provide in `setup`. Read like any block; a reader that doesn't know it carries it unchanged (13.5).
 */
export type Utility = {
  name: string;
  version: string;
  label?: string;
  describe?: string;
  /** `curator(ship, returns)` → `{ as: "curator", items: ["ship", "returns"] }`; `controller` → no items. */
  serves: { as: string; items?: string[]; line: number }[];
  /** Package identities (`domain/name`, optionally ` /version`) and bare utility names. */
  needs: { name: string; version?: string; line: number }[];
  setup: ({ connection: string; line: number } | { setting: string; line: number })[];
  /** The acts the utility provides by name (11.1, `acts:`), which a lane's presses may name (12.10). */
  acts: { name: string; line: number }[];
  line: number;
};

/** A press on a lane's home or card (12.10): a word, and where it lands: a path, `page`, or an act. */
export type LanePress = { word: string; to: string; line: number };

/**
 * A lane (12.10): a row of the grid a package declares. What it lists (a view and the picks for what
 * is ahead and what is done), whom it serves, how it sorts (band, house), what its home card shows and
 * how its object cards map to the compass, with the presses that act on them. A utility's own lane
 * (`serve:`) names the function the utility provides instead of a view.
 */
export type Lane = {
  name: string;
  version: string;
  label?: string;
  utility?: string;
  view?: string;
  serve?: string;
  pick?: { filter: string; value: string; line: number };
  done?: { filter: string; value: string; line: number } | "viewed";
  band: "daily" | "weekly" | "rarely";
  house: number;
  serves: { as: string; items?: string[]; line: number }[];
  home: {
    figure?: { of: "count" } | { of: "sum" | "state"; slot: string };
    word?: { one: string; many: string } | { word: string };
    press?: LanePress;
    chips: string[];
    line: number;
  };
  card?: {
    name: string[];
    sub: string[];
    lines: string[];
    state?: string;
    moment?: string;
    figure?: string;
    primary?: LanePress;
    quiet?: LanePress;
    quick: LanePress[];
    opens: "page";
    line: number;
  };
  line: number;
};

const ORIGINS = new Set(["observed", "declared", "derived", "reported"]);
const AUDIENCES = new Set(["public", "member", "staff", "owner"]);

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** Split at commas outside parentheses: `controller, curator(ship, returns)` → two pieces. */
function splitServes(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Read one `utility:` block. */
function readUtility(node: Node): Utility {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!/^[a-z][\w-]*$/.test(name)) throw new CrubalError(`a utility is "utility: <name> /<version>", the name a lower-case word: ${node.value}`, node.line);
  const u: Utility = { name, version, serves: [], needs: [], setup: [], acts: [], line: node.line };
  for (const c of node.children) {
    if (!c.key) continue;
    if (c.key === "label") u.label = unquote(c.value.trim());
    else if (c.key === "describe") u.describe = unquote(c.value.trim());
    else if (c.key === "serves") {
      for (const p of splitServes(c.value)) {
        const m = p.match(/^([A-Za-z][\w-]*)(?:\((.*)\))?$/);
        if (!m) throw new CrubalError(`serves: ${p} is not a name, or a name with items in parentheses`, c.line);
        u.serves.push({ as: m[1] as string, ...(m[2] !== undefined ? { items: splitList(m[2]) } : {}), line: c.line });
      }
    } else if (c.key === "needs") {
      for (const n of splitList(c.value)) {
        const [nm = "", ver] = n.split(/\s+\//).map((s) => s.trim());
        if (!/^([a-z0-9.-]+\/[a-z][\w-]*|[a-z][\w-]*)$/.test(nm)) throw new CrubalError(`needs: ${nm} is not a package identity (domain/name) or a utility name`, c.line);
        u.needs.push({ name: nm, ...(ver ? { version: ver } : {}), line: c.line });
      }
    } else if (c.key === "setup") {
      for (const s of splitList(c.value)) {
        const m = s.match(/^(connection|setting)\s+(\S+)$/);
        if (!m) throw new CrubalError(`setup: ${s} is not "connection <name>" or "setting <facet>"`, c.line);
        u.setup.push(m[1] === "connection" ? { connection: m[2] as string, line: c.line } : { setting: m[2] as string, line: c.line });
      }
    } else if (c.key === "acts") {
      for (const a of splitList(c.value)) {
        if (!/^[a-z][\w-]*$/.test(a)) throw new CrubalError(`acts: ${a} is not a lower-case word`, c.line);
        u.acts.push({ name: a, line: c.line });
      }
    } else throw new CrubalError(`a utility has label, describe, serves, needs, setup and acts, not ${c.key}`, c.line);
  }
  return u;
}

/** `Word -> target`: a press's word and where it lands. */
function readPress(value: string, line: number, what: string): LanePress {
  const at = value.lastIndexOf(" -> ");
  if (at < 0) throw new CrubalError(`${what} is "Word -> target": ${value}`, line);
  const word = unquote(value.slice(0, at).trim());
  const to = value.slice(at + 4).trim();
  if (!word || !to) throw new CrubalError(`${what} is "Word -> target": ${value}`, line);
  return { word, to, line };
}

/** `filter = value`: a view's filter pick. */
function readPick(value: string, line: number, what: string): { filter: string; value: string; line: number } {
  const m = value.match(/^([\w:-]+)\s*=\s*(.+)$/);
  if (!m) throw new CrubalError(`${what} is "filter = value": ${value}`, line);
  return { filter: m[1] as string, value: unquote((m[2] as string).trim()), line };
}

/** Read one `lane:` block (12.10). */
function readLane(node: Node): Lane {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!/^[a-z][\w-]*$/.test(name)) throw new CrubalError(`a lane is "lane: <name> /<version>", the name a lower-case word: ${node.value}`, node.line);
  const s: Lane = { name, version, band: "rarely", house: 8, serves: [], home: { chips: [], line: node.line }, line: node.line };
  for (const c of node.children) {
    if (!c.key) continue;
    const v = c.value.trim();
    if (c.key === "label") s.label = unquote(v);
    else if (c.key === "utility") s.utility = v;
    else if (c.key === "view") s.view = v;
    else if (c.key === "serve") s.serve = v;
    else if (c.key === "pick") s.pick = readPick(v, c.line, "pick");
    else if (c.key === "done") s.done = v === "viewed" ? "viewed" : readPick(v, c.line, "done");
    else if (c.key === "band") {
      if (v !== "daily" && v !== "weekly" && v !== "rarely") throw new CrubalError(`band is daily, weekly or rarely, not ${v}`, c.line);
      s.band = v;
    } else if (c.key === "house") {
      if (!/^\d+$/.test(v)) throw new CrubalError(`house is a whole number, governance first: ${v}`, c.line);
      s.house = Number(v);
    } else if (c.key === "serves") {
      for (const p of splitServes(v)) {
        const m = p.match(/^([A-Za-z][\w-]*)(?:\((.*)\))?$/);
        if (!m) throw new CrubalError(`serves: ${p} is not a name, or a name with items in parentheses`, c.line);
        s.serves.push({ as: m[1] as string, ...(m[2] !== undefined ? { items: splitList(m[2]) } : {}), line: c.line });
      }
    } else if (c.key === "home") {
      s.home.line = c.line;
      for (const h of c.children) {
        if (!h.key) continue;
        const hv = h.value.trim();
        if (h.key === "figure") {
          const m = hv.match(/^(count|sum|state)(?:\s+(\S+))?$/);
          if (!m) throw new CrubalError(`figure is count, "sum <slot>" or "state <slot>", not ${hv}`, h.line);
          if (m[1] === "count") s.home.figure = { of: "count" };
          else {
            if (!m[2]) throw new CrubalError(`figure ${m[1]} names a slot`, h.line);
            s.home.figure = { of: m[1] as "sum" | "state", slot: m[2] };
          }
        } else if (h.key === "word") {
          const m = hv.match(/^one\s+("(?:[^"\\]|\\.)*")\s+many\s+("(?:[^"\\]|\\.)*")$/);
          s.home.word = m ? { one: unquote(m[1] as string), many: unquote(m[2] as string) } : { word: unquote(hv) };
        } else if (h.key === "press") s.home.press = readPress(hv, h.line, "home's press");
        else if (h.key === "chips") s.home.chips = splitList(hv);
        else throw new CrubalError(`a lane's home has figure, word, press and chips, not ${h.key}`, h.line);
      }
    } else if (c.key === "card") {
      const card: NonNullable<Lane["card"]> = { name: [], sub: [], lines: [], quick: [], opens: "page", line: c.line };
      for (const k of c.children) {
        if (!k.key) continue;
        const kv = k.value.trim();
        if (k.key === "name") card.name = splitList(kv);
        else if (k.key === "sub") card.sub = splitList(kv);
        else if (k.key === "lines") card.lines = splitList(kv);
        else if (k.key === "state") card.state = kv;
        else if (k.key === "moment") card.moment = kv;
        else if (k.key === "figure") card.figure = kv;
        else if (k.key === "primary") card.primary = readPress(kv, k.line, "primary");
        else if (k.key === "quiet") card.quiet = readPress(kv, k.line, "quiet");
        else if (k.key === "quick") card.quick.push(readPress(kv, k.line, "quick"));
        else if (k.key === "opens") {
          if (kv !== "page") throw new CrubalError(`opens: ${kv}: a card opens its page; a nest is not in this language version`, k.line);
        } else throw new CrubalError(`a lane's card has name, sub, lines, state, moment, figure, primary, quiet, quick and opens, not ${k.key}`, k.line);
      }
      if (!card.name.length) throw new CrubalError(`the lane ${name}'s card names nothing`, c.line);
      s.card = card;
    } else throw new CrubalError(`a lane has label, utility, view, serve, pick, done, band, house, serves, home and card, not ${c.key}`, c.line);
  }
  if (!s.view && !s.serve) throw new CrubalError(`the lane ${name} names no view and no serve`, node.line);
  if (s.view && s.serve) throw new CrubalError(`the lane ${name} names both a view and a serve`, node.line);
  if (s.serve && (s.pick || s.done || s.card)) throw new CrubalError(`the lane ${name} is a utility's own (serve): no pick, done or card`, node.line);
  return s;
}

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
    const info: PackageInfo = { name, version, owner: "", line: head.line, crubal: LANGUAGE, crubalLine: head.line, extends: [], prefixes: new Map(), trust: [], dict: emptyDictionary(), contracts: [], header: {}, terms: {}, utilities: [], lanes: [] };
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
      if (node.key === "utility") {
        const u = readUtility(node);
        if (info.utilities.some((x) => x.name === u.name)) throw new CrubalError(`the utility ${u.name} twice in one package`, node.line);
        info.utilities.push(u);
      }
      if (node.key === "lane") {
        const s = readLane(node);
        if (info.lanes.some((x) => x.name === s.name)) throw new CrubalError(`the lane ${s.name} twice in one package`, node.line);
        info.lanes.push(s);
      }
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
  checkUtilities(source, pkgs);
  checkLanes(source, pkgs);
  return pkgs;
}

const AUDIENCE_RANK: { [a: string]: number } = { public: 0, member: 1, staff: 2, owner: 3 };

/**
 * Lane blocks (12.10): a lane names its own package's view, the view's filters for its picks with
 * real values of their facets, slots of the view's shapes for its card, its utility's acts for its presses,
 * and serves nothing wider than its view shows. File-local, as the utility checks are.
 */
function checkLanes(source: string, pkgs: PackageInfo[]): void {
  if (!pkgs.some((p) => p.lanes.length)) return;
  const { perms } = readAccess(source);
  const dict = readDefinitions(source);
  const views = readViews(source);
  const known = (n: string) => perms.presets.has(n) || perms.relations.has(n) || AUDIENCES.has(n);
  const item = (n: string) => perms.presets.has(n) || perms.menu.has(n) || perms.relations.has(n);
  for (const p of pkgs) {
    for (const s of p.lanes) {
      const where = `the lane ${s.name}`;
      const utility = s.utility ? p.utilities.find((u) => u.name === s.utility) : undefined;
      if (s.utility && !utility) throw new CrubalError(`${where} names the utility ${s.utility}, which this package doesn't declare`, s.line);
      const acts = new Set((utility?.acts ?? []).map((a) => a.name));
      for (const sv of s.serves) {
        if (!known(sv.as)) throw new CrubalError(`${where} serves ${sv.as}, which isn't a preset, relation or audience here`, sv.line);
        for (const i of sv.items ?? []) if (!item(i)) throw new CrubalError(`${where} serves ${sv.as}(${i}): ${i} isn't a preset, menu item or relation`, sv.line);
      }
      const press = (pr: LanePress | undefined, what: string) => {
        if (!pr) return;
        if (pr.to === "page" || pr.to.startsWith("/")) return;
        if (!acts.has(pr.to)) throw new CrubalError(`${where}'s ${what} ${pr.word} -> ${pr.to}: ${pr.to} isn't an act of ${s.utility ?? "its utility"}`, pr.line);
      };
      press(s.home.press, "press");
      if (s.serve) {
        if (!/^[a-z][\w-]*$/.test(s.serve)) throw new CrubalError(`${where}'s serve is a lower-case word: ${s.serve}`, s.line);
        continue;
      }
      const view = views.views.get(s.view as string);
      if (!view) throw new CrubalError(`${where} names the view ${s.view}, which this package doesn't declare`, s.line);
      // Serves nothing wider than the view shows (12.4): an audience named must rank at or above the view's.
      for (const sv of s.serves) {
        const rank = AUDIENCE_RANK[sv.as];
        if (rank !== undefined && rank < (AUDIENCE_RANK[view.show] ?? 0)) throw new CrubalError(`${where} serves ${sv.as}, wider than ${view.name} shows (${view.show})`, sv.line);
      }
      const pick = (pk: { filter: string; value: string; line: number } | undefined, what: string) => {
        if (!pk) return;
        if (!view.filters.includes(pk.filter)) throw new CrubalError(`${where}'s ${what} names ${pk.filter}, which isn't a filter of ${view.name}`, pk.line);
        const f = views.filters.get(pk.filter);
        const facet = f ? dict.facets.get(f.facet) : undefined;
        if (facet?.values && !facet.values.some((x) => x.value === pk.value)) throw new CrubalError(`${where}'s ${what}: ${pk.value} is not a value of ${facet.key}`, pk.line);
      };
      pick(s.pick, "pick");
      if (s.done && s.done !== "viewed") pick(s.done, "done");
      for (const ch of s.home.chips) if (!view.filters.includes(ch)) throw new CrubalError(`${where}'s chips name ${ch}, which isn't a filter of ${view.name}`, s.home.line);
      const slots = new Set<string>(["id"]);
      for (const sh of view.shapes) for (const sl of views.shapes.get(sh)?.slots ?? []) slots.add(sl.to);
      const slot = (k: string | undefined, what: string, line: number) => {
        if (k !== undefined && !slots.has(k)) throw new CrubalError(`${where}'s ${what} names ${k}, which isn't a slot of ${view.name}'s shape`, line);
      };
      if (s.home.figure && s.home.figure.of !== "count") slot(s.home.figure.slot, "figure", s.home.line);
      const card = s.card;
      if (card) {
        for (const k of [...card.name, ...card.sub, ...card.lines]) slot(k, "card", card.line);
        slot(card.state, "state", card.line);
        slot(card.moment, "moment", card.line);
        slot(card.figure, "figure", card.line);
        press(card.primary, "primary");
        press(card.quiet, "quiet");
        for (const q of card.quick) press(q, "quick");
      }
    }
  }
}

/**
 * Utility blocks (11.1): what a utility `serves` is a preset, a relation or an audience the file declares,
 * and the items in parentheses are presets, menu items or relations; a `setting` in `setup` is a facet the
 * file defines. Packages the file doesn't hold are named by prefix and checked where they are resolved.
 */
function checkUtilities(source: string, pkgs: PackageInfo[]): void {
  if (!pkgs.some((p) => p.utilities.length)) return;
  const { perms } = readAccess(source);
  const dict = readDefinitions(source);
  const known = (n: string) => perms.presets.has(n) || perms.relations.has(n) || AUDIENCES.has(n);
  const item = (n: string) => perms.presets.has(n) || perms.menu.has(n) || perms.relations.has(n);
  for (const p of pkgs) {
    for (const u of p.utilities) {
      for (const s of u.serves) {
        if (!known(s.as)) throw new CrubalError(`${u.name} serves ${s.as}, which isn't a preset, relation or audience here`, s.line);
        for (const i of s.items ?? []) if (!item(i)) throw new CrubalError(`${u.name} serves ${s.as}(${i}): ${i} isn't a preset, menu item or relation here`, s.line);
      }
      for (const s of u.setup) if ("setting" in s && !s.setting.includes(":") && !dict.facets.has(s.setting)) throw new CrubalError(`${u.name} needs the setting ${s.setting}, which isn't a facet here`, s.line);
      if (u.needs.some((n) => n.name === u.name)) throw new CrubalError(`${u.name} needs itself`, u.line);
    }
  }
}
