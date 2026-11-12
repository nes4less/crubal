// packages.ts: package files (spec chapter 11). A file may hold several packages, each starting at a
// `package:` line. The checks here are 11.1's prefixes, 11.3's trust entries and 11.4's rule that an
// extending package may add to what it extends but never change it.

import { type Dictionary, emptyDictionary, type Facet, readDefinitions, unquote } from "./defs.ts";
import { LANGUAGE } from "./read-text.ts";
import { readContracts } from "./store.ts";
import { type Permissions, readAccess } from "./access.ts";
import { readViews } from "./views.ts";
import { CrubalError, type Node, readTree } from "./tree.ts";
import { type Act, checkActList, readAct } from "./acts.ts";

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
  /** The flows the package declares (12.11, `flow:` blocks). */
  flows: Flow[];
  /** The acts the package declares in words (15, revision 25), beside the utilities' lists of names. */
  acts: Act[];
};

/**
 * A utility block (11.1): a named, versioned tool a platform mounts for the presets, relations or audiences
 * it `serves`, the packages and utilities it `needs`, and the connections and settings a deployment must
 * provide in `setup`. Read like any block; a reader that doesn't know it carries it unchanged (13.5).
 */
export type Utility = {
  name: string;
  version: string;
  /** Revision 32: the group the utility stands in where a room segments its rows (Org, Platform, Services, Clients). */
  group?: string;
  label?: string;
  describe?: string;
  /** `curator(ship, returns)` → `{ as: "curator", items: ["ship", "returns"] }`; `controller` → no items. */
  serves: { as: string; items?: string[]; line: number }[];
  /** Package identities (`domain/name`, optionally ` /version`) and bare utility names. */
  needs: { name: string; version?: string; line: number }[];
  setup: ({ connection: string; line: number } | { setting: string; line: number })[];
  /** The acts the utility provides by name (11.1, `acts:`), which a lane's presses may name (12.10). */
  acts: { name: string; line: number }[];
  /** The utility's look wherever it shows (11.1, `mark:`, revision 13): a glyph the mounting app's kit
   * draws and a hue from the eight words. */
  mark?: { glyph: string; hue: Hue; line: number };
  line: number;
};

/** The eight hue words a mark may name (11.1, revision 13); an app maps each to its own colors. */
export const HUES = ["amber", "blue", "violet", "slate", "teal", "plum", "coral", "olive"] as const;
export type Hue = (typeof HUES)[number];
export const isHue = (v: unknown): v is Hue => typeof v === "string" && (HUES as readonly string[]).includes(v);

/** A press on a lane's home or card (12.10): a word, and where it lands: a path, `page`, or an act; revision 33:
 * the glyph it wears where an app draws presses as glyphs (`Word as glyph -> target`), a lower-case name. */
export type LanePress = { word: string; to: string; glyph?: string; line: number };

/**
 * A lane (12.10): a row of the grid a package declares. What it lists (a view and the picks for what
 * is ahead and what is done), whom it serves, how it sorts (band, house), what its home card shows and
 * how its object cards map to the compass, with the presses that act on them. A utility's own lane
 * (`serve:`) names the function the utility provides instead of a view.
 */
export type Lane = {
  name: string;
  version: string;
  /** Revision 32: one of the view's filters whose buckets group the row's cards, each a heading card with its cards tucked. */
  group?: string;
  label?: string;
  utility?: string;
  view?: string;
  serve?: string;
  pick?: { filter: string; value: string; line: number };
  done?: { filter: string; value: string; line: number } | "viewed";
  /**
   * Revision 34: one of the view's marked filters, in place of pick and done. What is ahead is its `open`
   * bucket and the history its `done` bucket; `pick` and `done` hold those two, so a reader of either sees them.
   */
  step?: string;
  /** Revision 34: marked filters of the view; a record marked on any waits here no longer. */
  until?: string[];
  /** Revision 38: marked filters of the view; a record waits here only once marked on each. */
  after?: string[];
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

/**
 * A stop of a flow (12.11): a lane of the package with the act that moves a card on, or a form (a block)
 * with where its record comes from. Which it is, the check decides by the name: a lane's name is a lane
 * stop, a form contract's name a block; `act` says lane, `of` says block.
 */
export type FlowStop = { name: string; act?: string; of?: string; /** Revision 36: values a block's form opens with, set and locked. */ with?: { facet: string; value: string }[]; line: number };

/**
 * A flow (12.11): an objective's line of stops, declared by the package whose lanes and forms it walks,
 * served like a lane, walked by a record. The app draws it at the room's head; the engine reads, checks
 * and carries it.
 */
export type Flow = {
  name: string;
  version: string;
  label?: string;
  utility?: string;
  follow: "queue" | "card";
  serves: { as: string; items?: string[]; line: number }[];
  /** What the flow holds through its run (revision 23): kinds asked once when it is walked (a station). */
  context: string[];
  /** The flow this one stands in for (revision 23): served where the named flow would have been. */
  replaces?: string;
  /** Revision 40: `elements`, an arrangement of Elements (each stop a lane with its act) that chains with
   * nothing; absent, a line whose state stops chain. */
  arrange?: "elements";
  stops: FlowStop[];
  /** `filter = value`, or (revision 34) a marked filter alone: a record marked on it has left the line. */
  done?: { filter: string; value: string; line: number; mark?: true };
  line: number;
};

/**
 * A stamp a flow's stop leaves (12.11, revision 22): the facet and value a record takes when the stop's act
 * lands (a lane stop: its done) or when its form is kept (a block stop: the next lane stop's pick).
 */
export type FlowStamp = { stop: string; at: number; facet: string; value: string; mark?: true };

/**
 * The stamps of a flow's stops, derived from its lanes: never declared, never published. `facetOf` resolves
 * a filter's name to its facet's key (the views' filters); a stop whose pick names no filter stamps nothing.
 * A lane stop whose done is `viewed` or absent (an end stop) stamps nothing; a block stop after the last
 * lane stamps nothing. A step stop (revision 34) stamps its mark (`mark: true`; the value is the writer's: now on
 * a date, yes on a yes-no, nothing on a link, which the act sets), and a block before one stamps nothing. Pure.
 */
export function flowStamps(f: Flow, lanes: Pick<Lane, "name" | "pick" | "done" | "step">[], facetOf: (filter: string) => string | undefined): FlowStamp[] {
  const out: FlowStamp[] = [];
  const laneOf = (n: string) => lanes.find((x) => x.name === n);
  const nextPick = (i: number) => {
    for (let j = i + 1; j < f.stops.length; j++) {
      const l = laneOf(f.stops[j]?.name ?? "");
      if (l) return l.step ? undefined : l.pick;
    }
    return undefined;
  };
  f.stops.forEach((st, i) => {
    const l = laneOf(st.name);
    const pk = l ? (l.done && l.done !== "viewed" ? l.done : undefined) : nextPick(i);
    const facet = pk ? facetOf(pk.filter) : undefined;
    if (pk && facet) out.push({ stop: st.name, at: i, facet, value: pk.value, ...(l?.step ? { mark: true as const } : {}) });
  });
  return out;
}

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
    else if (c.key === "group") {
      const g = unquote(c.value.trim());
      if (!g) throw new CrubalError("group names the group the utility stands in: a word", c.line);
      u.group = g;
    } else if (c.key === "serves") {
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
    } else if (c.key === "mark") {
      const m = c.value.trim().match(/^([a-z][\w-]*)\s+([a-z]+)$/);
      if (!m) throw new CrubalError(`mark: is "<glyph> <hue>", the glyph a lower-case word and the hue one of ${HUES.join(", ")}: ${c.value.trim()}`, c.line);
      if (!isHue(m[2])) throw new CrubalError(`mark: ${m[2]} is not a hue; the eight are ${HUES.join(", ")}`, c.line);
      u.mark = { glyph: m[1] as string, hue: m[2], line: c.line };
    } else throw new CrubalError(`a utility has label, describe, group, serves, needs, setup, acts and mark, not ${c.key}`, c.line);
  }
  return u;
}

/** `Word -> target`, or `Word as glyph -> target` (revision 33): a press's word, its glyph and where it lands. */
function readPress(value: string, line: number, what: string): LanePress {
  const at = value.lastIndexOf(" -> ");
  if (at < 0) throw new CrubalError(`${what} is "Word -> target" or "Word as glyph -> target": ${value}`, line);
  let head = value.slice(0, at).trim();
  const to = value.slice(at + 4).trim();
  let glyph: string | undefined;
  const as = head.match(/^(.*\S)\s+as\s+([a-z][a-z0-9-]*)$/);
  if (as) {
    head = (as[1] as string).trim();
    glyph = as[2] as string;
  }
  const word = unquote(head);
  if (!word || !to) throw new CrubalError(`${what} is "Word -> target" or "Word as glyph -> target": ${value}`, line);
  return { word, to, ...(glyph ? { glyph } : {}), line };
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
  const said = new Set<string>();
  for (const c of node.children) {
    if (!c.key) continue;
    const v = c.value.trim();
    if (c.key === "label") s.label = unquote(v);
    else if (c.key === "utility") s.utility = v;
    else if (c.key === "view") s.view = v;
    else if (c.key === "serve") s.serve = v;
    else if (c.key === "pick") { s.pick = readPick(v, c.line, "pick"); said.add("pick"); }
    else if (c.key === "done") { s.done = v === "viewed" ? "viewed" : readPick(v, c.line, "done"); said.add("done"); }
    else if (c.key === "step") {
      if (!/^[\w:-]+$/.test(v)) throw new CrubalError(`step names one of the view's marked filters: ${v}`, c.line);
      s.step = v;
    } else if (c.key === "until") {
      s.until = splitList(v);
      for (const u of s.until) if (!/^[\w:-]+$/.test(u)) throw new CrubalError(`until names the view's marked filters: ${u}`, c.line);
      if (!s.until.length) throw new CrubalError("until names the view's marked filters", c.line);
    } else if (c.key === "group") {
      if (!/^[\w:-]+$/.test(v)) throw new CrubalError(`group names one of the view's filters: ${v}`, c.line);
      s.group = v;
    }
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
    } else if (c.key === "after") {
      s.after = splitList(v);
      for (const u of s.after) if (!/^[\w:-]+$/.test(u)) throw new CrubalError(`after names the view's marked filters: ${u}`, c.line);
      if (!s.after.length) throw new CrubalError("after names the view's marked filters", c.line);
    } else throw new CrubalError(`a lane has label, utility, view, serve, pick, done, step, until, after, group, band, house, serves, home and card, not ${c.key}`, c.line);
  }
  if (!s.view && !s.serve) throw new CrubalError(`the lane ${name} names no view and no serve`, node.line);
  if (s.view && s.serve) throw new CrubalError(`the lane ${name} names both a view and a serve`, node.line);
  // A step lane (revision 34): the step in place of pick and done, which hold its two buckets from here on.
  if (s.step && (said.has("pick") || said.has("done"))) throw new CrubalError(`the lane ${name} names a step, so it names no pick and no done`, node.line);
  if (s.until && !s.step) throw new CrubalError(`the lane ${name} names an until, so it needs a step`, node.line);
  if (s.after && !s.step) throw new CrubalError(`the lane ${name} names an after, so it needs a step`, node.line);
  for (const a of s.after ?? []) {
    if (a === s.step) throw new CrubalError(`the lane ${name}'s after names its own step, ${a}`, node.line);
    if (s.until?.includes(a)) throw new CrubalError(`the lane ${name} names ${a} as an after and an until: nothing would wait there`, node.line);
  }
  if (s.step) {
    s.pick = { filter: s.step, value: "open", line: node.line };
    s.done = { filter: s.step, value: "done", line: node.line };
  }
  if (s.serve && (s.pick || s.done || s.card)) throw new CrubalError(`the lane ${name} is a utility's own (serve): no pick, done or card`, node.line);
  // A list (12.10, revision 17): a lane without a pick holds every record its view serves and has no history.
  if (s.view && !s.pick && s.done) throw new CrubalError(`the lane ${name} is a list (no pick), so it has no done`, node.line);
  return s;
}

/** Read one `flow:` block (12.11). */
function readFlow(node: Node): Flow {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!/^[a-z][\w-]*$/.test(name)) throw new CrubalError(`a flow is "flow: <name> /<version>", the name a lower-case word: ${node.value}`, node.line);
  const f: Flow = { name, version, follow: "queue", serves: [], context: [], stops: [], line: node.line };
  for (const c of node.children) {
    if (!c.key) continue;
    const v = c.value.trim();
    if (c.key === "label") f.label = unquote(v);
    else if (c.key === "utility") f.utility = v;
    else if (c.key === "follow") {
      if (v !== "queue" && v !== "card") throw new CrubalError(`follow is queue or card, not ${v}`, c.line);
      f.follow = v;
    } else if (c.key === "serves") {
      for (const part of splitServes(v)) {
        const m = part.match(/^([A-Za-z][\w-]*)(?:\((.*)\))?$/);
        if (!m) throw new CrubalError(`serves: ${part} is not a name, or a name with items in parentheses`, c.line);
        f.serves.push({ as: m[1] as string, ...(m[2] !== undefined ? { items: splitList(m[2]) } : {}), line: c.line });
      }
    } else if (c.key === "context") {
      f.context = splitList(v);
      for (const k of f.context) if (!/^[a-z][\w-]*$/.test(k)) throw new CrubalError(`context names kinds, lower-case words: ${k}`, c.line);
    } else if (c.key === "replaces") {
      if (!/^[a-z][\w-]*$/.test(v)) throw new CrubalError(`replaces names a flow, a lower-case word: ${v}`, c.line);
      f.replaces = v;
    } else if (c.key === "arrange") {
      if (v !== "elements" && v !== "line") throw new CrubalError(`arrange is line or elements, not ${v}`, c.line);
      if (v === "elements") f.arrange = "elements";
    } else if (c.key === "done") f.done = /^[\w:-]+$/.test(v) ? { filter: v, value: "done", line: c.line, mark: true } : readPick(v, c.line, "done");
    else if (c.key === "stops") {
      for (const st of c.children) {
        const text = st.text.trim();
        if (!text) continue;
        const m = text.match(/^([a-z][\w-]*)(?:\s+->\s+([a-z][\w-]*)|\s+of\s+([a-z][\w-]*)(?:\s+with\s+(.+))?)?$/);
        if (!m) throw new CrubalError(`a stop is "<lane> -> <act>", "<lane>", or "<form> of <level>" (with "<facet> = <value>, …" after it, or not), not ${text}`, st.line);
        // Revision 36: `with`, the values a block's form opens with, set and locked.
        const locks = (m[4] ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((pair) => {
          const w = pair.match(/^([a-z][\w:-]*)\s*=\s*(\S(?:.*\S)?)$/);
          if (!w) throw new CrubalError(`a stop's with is "<facet> = <value>", not ${pair}`, st.line);
          return { facet: w[1] as string, value: w[2] as string };
        });
        if (m[4] !== undefined && !locks.length) throw new CrubalError(`the stop ${m[1]} says with and names no value`, st.line);
        if (new Set(locks.map((l) => l.facet)).size !== locks.length) throw new CrubalError(`the stop ${m[1]} locks a facet twice`, st.line);
        f.stops.push({ name: m[1] as string, ...(m[2] ? { act: m[2] } : {}), ...(m[3] ? { of: m[3] } : {}), ...(locks.length ? { with: locks } : {}), line: st.line });
      }
    } else throw new CrubalError(`a flow has label, utility, follow, serves, context, replaces, arrange, stops and done, not ${c.key}`, c.line);
  }
  if (!f.stops.length) throw new CrubalError(`the flow ${name} has no stops`, node.line);
  return f;
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
    const info: PackageInfo = { name, version, owner: "", line: head.line, crubal: LANGUAGE, crubalLine: head.line, extends: [], prefixes: new Map(), trust: [], dict: emptyDictionary(), contracts: [], header: {}, terms: {}, utilities: [], lanes: [], flows: [], acts: [] };
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
      if (node.key === "flow") {
        const f = readFlow(node);
        if (info.flows.some((x) => x.name === f.name)) throw new CrubalError(`the flow ${f.name} twice in one package`, node.line);
        info.flows.push(f);
      }
      if (node.key === "act") {
        const a = readAct(node);
        if (info.acts.some((x) => x.name === a.name)) throw new CrubalError(`the act ${a.name} twice in one package`, node.line);
        info.acts.push(a);
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
    // Revision 35: a level's quantity is a number facet of this package.
    for (const k of d.kinds.values())
      for (const [level, facet] of Object.entries(k.shares ?? {})) {
        const f = d.facets.get(facet);
        if (!f && !facet.includes(":")) throw new CrubalError(`shares at ${level} names ${facet}, which isn't a facet`, k.sharesLine);
        if (f && f.type !== "number") throw new CrubalError(`shares at ${level} names ${facet}, which isn't a number`, k.sharesLine);
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
  checkFlows(source, pkgs);
  checkActs(source, pkgs);
  checkFormUtilities(source, pkgs);
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
        if (s.group) throw new CrubalError(`${where} groups by ${s.group}, but a lane the app serves has no view to group by`, s.line);
        continue;
      }
      const view = views.views.get(s.view as string);
      if (!view) throw new CrubalError(`${where} names the view ${s.view}, which this package doesn't declare`, s.line);
      // Revision 32: the group is one of the view's filters, whose buckets the row's cards stand in.
      if (s.group && !view.filters.includes(s.group)) throw new CrubalError(`${where} groups by ${s.group}, which isn't a filter of ${view.name}`, s.line);
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
      if (s.step) {
        // Revision 34: the step and every until is a marked filter of the lane's view; revision 38: every after too.
        for (const [m, what] of [[s.step, "step"], ...(s.until ?? []).map((u) => [u, "until"]), ...(s.after ?? []).map((u) => [u, "after"])] as [string, string][]) {
          if (!view.filters.includes(m)) throw new CrubalError(`${where}'s ${what} names ${m}, which isn't a filter of ${view.name}`, s.line);
          if (!views.filters.get(m)?.marked) throw new CrubalError(`${where}'s ${what} names ${m}, which isn't a marked filter (buckets: marked)`, s.line);
        }
      } else {
        pick(s.pick, "pick");
        if (s.done && s.done !== "viewed") pick(s.done, "done");
      }
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

/** What a flow's checks read: the lanes, forms, utilities, filters, dictionary and permissions it may name. */
type FlowEnv = { lanes: Lane[]; forms: Set<string>; utilities: Utility[]; filters: Map<string, { facet: string }>; dict: Dictionary; perms: Permissions; strict: boolean; /** "of this package" at publish, "in force here" at install. */ here: string };

/**
 * Flow blocks (12.11): a flow names its own package's utility and serves what that package knows; each
 * stop is a lane of the package (with an act of the utility when one is named) or a form contract of the
 * package (with a level of the package's kinds when `of` is named); its done pick is a declared filter
 * with a real value. Revision 23: a package that extends others may walk their lanes and forms and name
 * their utility, presets and filters (a place's own package carrying the flow it drew from a preset): what
 * the file-local check cannot see it leaves to `checkFlowsInForce`, over the packages in force together.
 */
function checkFlowList(flows: Flow[], env: FlowEnv): void {
  const { perms, dict, strict } = env;
  const known = (n: string) => perms.presets.has(n) || perms.relations.has(n) || AUDIENCES.has(n);
  const item = (n: string) => perms.presets.has(n) || perms.menu.has(n) || perms.relations.has(n);
  const laneNames = new Set(env.lanes.map((l) => l.name));
  const { here } = env;
  const lacks = here === "in force here" ? "isn't in force here" : "this package doesn't declare";
  for (const f of flows) {
    const where = `the flow ${f.name}`;
    const utility = f.utility ? env.utilities.find((u) => u.name === f.utility) : undefined;
    if (f.utility && !utility && strict) throw new CrubalError(`${where} names the utility ${f.utility}, which ${lacks}`, f.line);
    const acts = utility ? new Set(utility.acts.map((a) => a.name)) : f.utility ? undefined : new Set<string>();
    for (const sv of f.serves) {
      if (!known(sv.as) && strict) throw new CrubalError(`${where} serves ${sv.as}, which isn't a preset, relation or audience here`, sv.line);
      for (const i of sv.items ?? []) if (!item(i) && strict) throw new CrubalError(`${where} serves ${sv.as}(${i}): ${i} isn't a preset, menu item or relation`, sv.line);
    }
    // Revision 23: the context is kinds (or levels) in force; a flow never replaces itself.
    for (const k of f.context) if (!dict.kinds.has(k) && !dict.levels.has(k) && strict) throw new CrubalError(`${where}'s context names ${k}, which isn't a kind or level ${here}`, f.line);
    if (f.replaces === f.name) throw new CrubalError(`${where} replaces itself`, f.line);
    let deferred = false;
    for (const st of f.stops) {
      const isLane = laneNames.has(st.name);
      const isForm = env.forms.has(st.name);
      if (!isLane && !isForm && !strict) {
        deferred = true;
        continue;
      }
      if (st.act !== undefined && !isLane) throw new CrubalError(`${where}'s stop ${st.name} -> ${st.act}: ${st.name} isn't a lane ${here}`, st.line);
      if (st.of !== undefined && !isForm) throw new CrubalError(`${where}'s stop ${st.name} of ${st.of}: ${st.name} isn't a form ${here}`, st.line);
      if (!isLane && !isForm) throw new CrubalError(`${where}'s stop ${st.name} is neither a lane nor a form ${here}`, st.line);
      if (st.act !== undefined && acts && !acts.has(st.act)) throw new CrubalError(`${where}'s stop ${st.name} -> ${st.act}: ${st.act} isn't an act of ${f.utility ?? "its utility"}`, st.line);
      if (st.of !== undefined && !dict.levels.has(st.of) && !dict.kinds.has(st.of) && strict) throw new CrubalError(`${where}'s stop ${st.name} of ${st.of}: ${st.of} isn't a level or kind ${here}`, st.line);
      for (const w of st.with ?? []) {
        const facet = dict.facets.get(w.facet.split("::").pop() as string);
        if (!facet && strict) throw new CrubalError(`${where}'s stop ${st.name} locks ${w.facet}, which isn't a facet ${here}`, st.line);
      }
    }
    if (f.done) {
      const flt = env.filters.get(f.done.filter);
      if (!flt && strict) throw new CrubalError(`${where}'s done names ${f.done.filter}, which isn't a filter ${here}`, f.done.line);
      const facet = flt ? dict.facets.get(flt.facet) : undefined;
      if (f.done.mark) {
        if (flt && !(flt as { marked?: boolean }).marked) throw new CrubalError(`${where}'s done names ${f.done.filter}, which isn't a marked filter (buckets: marked)`, f.done.line);
      } else if (facet?.values && !facet.values.some((x) => x.value === f.done?.value)) throw new CrubalError(`${where}'s done: ${f.done.value} is not a value of ${facet.key}`, f.done.line);
    }
    // The chain (12.11, revision 22): consecutive lane stops chain done to pick, a list lane is a stop only with
    // an act (revision 37), and the
    // flow's done is its last lane's (its pick when that lane holds what is finished). A block between two
    // lanes leaves the chain as it is. A chain with a stop the file-local check could not see waits for the
    // check in force.
    if (deferred) continue;
    // Elements (revision 40): the flow arranges Elements, each a lane with the act that is its work. They are
    // joined by what the flow holds (its context), not by a state handed on, so nothing chains, the lanes may be
    // of different levels, and a done is checked against no lane. A lane stop with no act is no Element.
    if (f.arrange === "elements") {
      for (const st of f.stops) if (laneNames.has(st.name) && !st.act) throw new CrubalError(`${where} arranges Elements: its stop ${st.name} names no act, and an Element is a lane with its act (${st.name} -> <act>)`, st.line);
      continue;
    }
    const show = (pk: { filter: string; value: string }) => `${pk.filter} = ${pk.value}`;
    const same = (a: { filter: string; value: string }, b: { filter: string; value: string }) => a.filter === b.filter && a.value === b.value;
    let prev: Lane | undefined;
    let last: Lane | undefined;
    for (const st of f.stops) {
      const l = env.lanes.find((x) => x.name === st.name);
      if (!l) continue;
      last = l;
      // A step stop (revision 34) chains with nothing: it may stand anywhere, and the state stops chain across it.
      if (l.step) continue;
      // A list stop (revision 37): a list holds no state, so it is a stop only where the stop names the act that is
      // its work; like a step stop it chains with nothing, and it stamps nothing.
      if (!l.pick) {
        if (!st.act) throw new CrubalError(`${where}'s stop ${l.name} is a list: it holds no state, so it is a stop only with an act (${l.name} -> <act>)`, st.line);
        continue;
      }
      if (prev) {
        if (!prev.done || prev.done === "viewed") throw new CrubalError(`${where} has a gap: ${prev.name} is done when viewed, so nothing moves on from it to ${l.name}`, st.line);
        if (!same(prev.done, l.pick)) throw new CrubalError(`${where} has a gap: ${prev.name} is done at ${show(prev.done)}, but ${l.name} picks ${show(l.pick)}`, st.line);
      }
      prev = l;
    }
    if (f.done && prev && last === prev) {
      const end = prev.done && prev.done !== "viewed" ? prev.done : prev.pick;
      if (end && !same(f.done, end)) throw new CrubalError(`${where}'s done is ${show(f.done)}, but its last lane ${prev.name} leaves a record at ${show(end)}`, f.done.line);
    }
  }
}

/** The file-local flow checks: strict for a package that extends nothing, deferring what it cannot see otherwise. */
function checkFlows(source: string, pkgs: PackageInfo[]): void {
  if (!pkgs.some((p) => p.flows.length)) return;
  const { perms } = readAccess(source);
  const dict = readDefinitions(source);
  const views = readViews(source);
  const forms = new Set(readContracts(source).filter((c) => c.kind === "form").map((c) => c.name));
  for (const p of pkgs) checkFlowList(p.flows, { lanes: p.lanes, forms, utilities: p.utilities, filters: views.filters, dict, perms, strict: p.extends.length === 0, here: "of this package" });
}

/**
 * The flow checks over the packages in force together (11.4, revision 23): everything a file-local check
 * deferred because the package extends others, refused as the publish would have; run where the
 * permissions are checked in force (at install, and on a trial definition).
 */
export function checkFlowsInForce(p: { info: Pick<PackageInfo, "flows" | "lanes" | "utilities">; dict: Dictionary; contracts: { kind: string; name: string }[]; views: { filters: Map<string, { facet: string }> }; perms: Permissions }): void {
  if (!p.info.flows.length) return;
  checkFlowList(p.info.flows, { lanes: p.info.lanes, forms: new Set(p.contracts.filter((c) => c.kind === "form").map((c) => c.name)), utilities: p.info.utilities, filters: p.views.filters, dict: p.dict, perms: p.perms, strict: true, here: "in force here" });
}

/**
 * A form's utility and act (7.7, revision 16): a form names a utility its package declares, an act that
 * utility provides, and no two forms name one act of a utility. File-local, as the lane checks are.
 */
function checkFormUtilities(source: string, pkgs: PackageInfo[]): void {
  const forms = readContracts(source).filter((c) => c.kind === "form" && c.parts.utility !== undefined);
  if (!forms.length) return;
  const utilities = new Map(pkgs.flatMap((p) => p.utilities).map((u) => [u.name, u] as const));
  const taken = new Map<string, string>();
  for (const c of forms) {
    const name = c.parts.utility as string;
    const u = utilities.get(name);
    if (!u) throw new CrubalError(`the form ${c.name} names the utility ${name}, which this package doesn't declare`, c.partLines.utility ?? c.line);
    const act = c.parts.act;
    if (act === undefined) continue;
    if (!u.acts.some((a) => a.name === act)) throw new CrubalError(`the form ${c.name} names the act ${act}, which ${name} doesn't provide`, c.partLines.act ?? c.line);
    const key = `${name}/${act}`;
    const was = taken.get(key);
    if (was) throw new CrubalError(`the forms ${was} and ${c.name} both name the act ${act} of ${name}: one form per act`, c.partLines.act ?? c.line);
    taken.set(key, c.name);
  }
}

/** The file-local act checks (15): strict for a package that extends nothing, deferring what it cannot see otherwise. */
function checkActs(source: string, pkgs: PackageInfo[]): void {
  if (!pkgs.some((p) => p.acts.length)) return;
  const dict = readDefinitions(source);
  for (const p of pkgs)
    checkActList(p.acts, {
      utilities: p.utilities,
      levels: new Set(dict.levels.keys()),
      kinds: new Set(dict.kinds.keys()),
      facets: new Set(dict.facets.keys()),
      facetOf: (k) => dict.facets.get(k),
      aspects: aspectsOf(dict),
      shares: sharesOf(dict),
      strict: p.extends.length === 0,
      here: "of this package",
    });
}

/** The act checks over the packages in force together (11.4): what a file-local check deferred. */
export function checkActsInForce(p: { info: Pick<PackageInfo, "acts" | "utilities">; dict: Dictionary }): void {
  if (!p.info.acts.length) return;
  checkActList(p.info.acts, {
    utilities: p.info.utilities,
    levels: new Set(p.dict.levels.keys()),
    kinds: new Set(p.dict.kinds.keys()),
    facets: new Set(p.dict.facets.keys()),
    facetOf: (k) => p.dict.facets.get(k),
    aspects: aspectsOf(p.dict),
    shares: sharesOf(p.dict),
    inertTelling: true,
    strict: true,
    here: "in force here",
  });
}

/** Every aspect the kinds declare under `follow:` (11.2, revision 31), which an act's `tells:` may name. */
/** Level → the facet that is its quantity, over every kind's `shares:` (11.2, revision 35). */
export const sharesOf = (dict: Dictionary): Map<string, string> => new Map([...dict.kinds.values()].flatMap((k) => Object.entries(k.shares ?? {})));
const aspectsOf = (dict: Dictionary): Set<string> => new Set([...dict.kinds.values()].flatMap((k) => Object.values(k.follow ?? {}).flat()));
