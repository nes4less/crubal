// Acts as declarations (chapter 15, revisions 25 and 26): an act a utility provides, said in the package's words.
// What level it acts on, what it holds beside the record (context kinds), the row a route takes through a rack
// of rules on a record, what it finds (named records of a kind by picks and an order) and mints when a find
// comes up empty, what it sets on the record in hand, what it then sets on the records it found when a condition
// holds (and sends then), what it sends through a transport the app provides, and when it counts as landed. The
// engine reads, checks and carries it, and answers each step pure: the row taken, the picks as they stand, the
// values a mint makes, the writes a landing makes; the app runs the finds and counts, makes the mints and the
// writes and the sends, and stamps the lane (12.11) when the act lands.
import { evaluate, parseCondition } from "./conditions.ts";
import { serialize } from "./canonical.ts";
import type { Json, JsonObject } from "./model.ts";
import { CrubalError, type Node } from "./tree.ts";
import { type Facet, unquote } from "./defs.ts";
import { checkScalar } from "./dictionary.ts";

/** A reference an act's lines may make: the record in hand's facet, a context record (or its facet), a found
 * record's facet, or the route's row's column. */
export type ActRef =
  | { record: string }
  | { context: string; facet?: string }
  | { found: string; facet?: string }
  | { route: string; column: string }
  /** Revision 44: what the act was given, by its name. */
  | { given: string };

/** What a pick in a find compares a facet with: a literal, or a reference. */
export type ActPickValue = { literal: string } | { caller: true } | { self: true } | ActRef;

export type ActPick = { facet: string; value: ActPickValue; line: number };

/** The next label in a series (revision 26): the prefix, one more than the highest number the kind's facet
 * carries after it, three digits, the suffix when given. */
export type ActSeries = { prefix: ActRef | { literal: string }; in: { kind: string; facet: string }; suffix?: ActRef };

/** What a set writes: a literal, a link to a found or context record, a reference's value, the moment, or the
 * next in a series. */
export type ActSource = { literal: string } | { link: string } | { now: true } | { caller: true } | { none: true } | { owner: true } | { run: true } | { person: true } | { next: ActSeries } | { sum: ActSum } | ActRef;

/** Revision 45: one number added to or taken from another, each a reference or a number (`given.count - record.qty`,
 * `record.movedCount + 1`). A reference that holds nothing reads as 0; one that holds no number refuses the act. */
export type ActOperand = { number: number } | ActRef;
export type ActSum = { left: ActOperand; op: "+" | "-"; right: ActOperand };

export type ActSet = { facet: string; source: ActSource; line: number };

export type ActMint = { kind: string; sets: ActSet[]; line: number };

export type ActFind = {
  name: string;
  take: "first" | "all";
  kind: string;
  where: ActPick[];
  order?: { facet: string; dir: "after" | "before" };
  /** Revision 26: the record made when a `first` find answered nothing. */
  mint?: ActMint;
  line: number;
};

/** Revision 26: the row of a compound facet on a record taken by its rule. */
export type ActRoute = {
  name: string;
  /** The compound facet the rows are read from: a context record's or the record in hand's. */
  rows: ActRef;
  /** The column holding each row's condition (6.3). */
  by: string;
  /** Whose values the conditions read, the later laid over the earlier: `record`, `record.<link facet>`. */
  over: ActRef[];
  /** A row holding its column's count or more of the records the picks admit is passed over. */
  keep?: { column: string; kind: string; where: ActPick[] };
  line: number;
};

/** Revision 26: the records of a kind the picks admit, counted, for a `when` to read by name. */
export type ActCount = { name: string; kind: string; where: ActPick[]; line: number };

/** A term of a `when`: a reference or a count's name, with an optional number added, or a number. */
export type ActTerm = { ref: ActRef; plus?: number } | { count: string; plus?: number } | { number: number };
/** What a then writes on a found record (revision 39: a link, a value copied or the facet cleared, as a set's). */
export type ActThenValue = { literal: string } | { now: true } | { none: true } | { link: string } | { caller: true } | { person: true } | { sum: ActSum } | ActRef;
/** One comparison of a `when`. */
export type ActCond =
  | { left: ActTerm; op: "=" | "!=" | "<" | ">" | "<=" | ">="; right: ActTerm }
  /** Revision 47: `has <ref>` holds where the reference holds a value; `no <ref>` where it holds none. */
  | { has: ActRef; lacks?: true };
/** A `when`: its first comparison, and (revision 45) those joined to it by `and`, all of which must hold. */
export type ActWhen = ActCond & { and?: ActCond[] };
/** Revision 45: a record the act makes when it lands, whatever its finds answered: `<name> -> <kind> [when …]`,
 * its set lines beneath as a mint's. */
export type ActMake = { name: string; kind: string; when?: ActWhen; sets: ActSet[]; line: number };
export type ActThenSet = { found: string; facet: string; value: ActThenValue };
/** Revision 47: another act run when this one has landed: `[<utility>/]<act> on record|<found> [when …]`. */
/** Revision 49: `with` gives the act run what it is given, a literal or a reference read as this act stood. */
export type ActAlso = { utility?: string; act: string; on: string; with?: { name: string; value: { literal: string } | ActRef }[]; when?: ActWhen; line: number };
/** An act another runs, on its record, with what it is given. */
export type ActRun = { utility?: string; act: string; id: string; given?: { [name: string]: Json } };
export type ActThen = {
  /** Absent (revision 39): the writes are made whenever the act lands. */
  when?: ActWhen;
  sets: ActThenSet[];
  /** Revision 47: `archive <record|found>` or `restore <record|found>`: the record's standing, in place of sets. */
  stand?: { to: "archived" | "active"; on: string; reason?: string };
  /** Revision 26: a send run only when the condition held. */
  send?: { verb: string; words: string };
  line: number;
};

/** Revision 42: what the record in hand must hold (or, with `no`, lack) for the act to land; its own words when
 * it is refused. */
/** Revision 51: `is` says what the value must be (`=`) or must not be (`!=`), a literal compared as text. */
export type ActNeed = { facet: string; lacks?: true; is?: { op: "=" | "!="; value: string }; words?: string; line: number };

/** Revision 44: a value the act is given by the person pressing it. Its type is a facet's (`as`), so what asks
 * for it and what refuses it are the facet's own; `from` is what the question opens on, `default` what it takes
 * when the person says nothing (and then it need not be asked). */
export type ActGiven = { name: string; facet: string; words?: string; from?: ActRef; default?: string; line: number };

export type Act = {
  name: string;
  version: string;
  utility: string;
  /** Revision 26: the act of the same utility this one stands in for. */
  replaces?: string;
  label?: string;
  describe?: string;
  on: string;
  /** Revision 35: the act may land on fewer than the record holds, where its level declares its quantity. */
  takes?: "share";
  context: string[];
  /** Revision 42: read before anything else; the first that fails stops the act before any write. */
  needs?: ActNeed[];
  /** Revision 44: what the act is given, each asked of the person unless it has a default. */
  given?: ActGiven[];
  route?: ActRoute;
  finds: ActFind[];
  counts: ActCount[];
  sets: ActSet[];
  thens: ActThen[];
  /** Revision 45: the records the act makes when it lands. */
  makes?: ActMake[];
  /** Revision 47: the acts run when this one has landed. */
  also?: ActAlso[];
  /** Revision 49: the acts run before this one lands, each on its record; one that refuses stops this act. */
  first?: ActAlso[];
  /** A transport verb the app provides and the words after it, carried unchanged. */
  send?: { verb: string; words: string };
  /** When the act counts as landed: at once, or when its send reports. */
  lands: "now" | "reports";
  /** Revision 31: the post the act lands when the record in hand or an ancestor is followed (15.1). */
  tells?: ActTells;
  line: number;
};

/** `tells: post as filed`, its set lines beneath: the kind made, the aspect it answers, the values it takes. */
export type ActTells = { kind: string; aspect: string; sets: ActSet[]; line: number };

const WORD = /^[a-z][\w-]*$/;

// ─── Reading ──────────────────────────────────────────────────────────────────

function readRef(t: string, line: number, what: string, routes: Set<string> = new Set()): ActRef {
  let m = t.match(/^record\.([\w:]+)$/);
  if (m) return { record: m[1] as string };
  // Revision 44: `given.<name>`, what the act was given.
  m = t.match(/^given\.([\w-]+)$/);
  if (m) return { given: m[1] as string };
  m = t.match(/^context\.([\w-]+)(?:\.([\w:]+))?$/);
  if (m) return m[2] ? { context: m[1] as string, facet: m[2] } : { context: m[1] as string };
  m = t.match(/^([\w-]+)\.([\w:]+)$/);
  if (!m) throw new CrubalError(`${what}: ${t} is not record.<facet>, context.<kind>[.<facet>], <found>[.<facet>] or <route>.<column>`, line);
  return routes.has(m[1] as string) ? { route: m[1] as string, column: m[2] as string } : { found: m[1] as string, facet: m[2] as string };
}

const isRef = (t: string) => /^(record|context|[\w-]+)\.[\w:.-]+$/.test(t) && !/\s/.test(t);

/** A pick's value: a reference, a found record's bare name (its id, revision 26), or a literal. */
function readPickValue(t: string, line: number, routes: Set<string>, founds: Set<string> = new Set()): ActPickValue {
  if (founds.has(t)) return { found: t };
  // Revision 35: the person running the act, as `link caller` is in a set.
  if (t === "caller") return { caller: true };
  // Revision 39: the record in hand itself, its id (`of = record`, `heldIn = record`).
  if (t === "record") return { self: true };
  return isRef(t) ? readRef(t, line, "a pick", routes) : { literal: unquote(t) };
}

/** `containerStation = context.station, containerState = open` */
function readPicks(text: string, line: number, routes: Set<string>, founds: Set<string> = new Set()): ActPick[] {
  return text
    .split(/,\s*(?=[\w:.]+\s*=)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const pm = p.match(/^([\w:]+(?:\.[\w:]+)?)\s*=\s*(.+)$/);
      if (!pm) throw new CrubalError(`a pick is "<facet> = <value>": ${p}`, line);
      return { facet: pm[1] as string, value: readPickValue((pm[2] as string).trim(), line, routes, founds), line };
    });
}

/** `boxed -> unit where filedIn = box` (revision 26) */
function readCount(text: string, line: number, routes: Set<string>, founds: Set<string>): ActCount {
  const m = text.match(/^([\w-]+)\s*->\s*([\w-]+)(?:\s+where\s+(.*))?$/);
  if (!m) throw new CrubalError(`a count is "<name> -> <kind> [where <facet> = <value>, …]": ${text}`, line);
  return { name: m[1] as string, kind: m[2] as string, where: readPicks(m[3] ?? "", line, routes, founds), line };
}

/** `box -> first container where containerState = open, containerStation = context.station order containerLabel` */
function readFind(text: string, line: number, routes: Set<string>): ActFind {
  const m = text.match(/^([\w-]+)\s*->\s*(first|all)\s+([\w-]+)(?:\s+where\s+(.*?))?(?:\s+order\s+([\w:]+)(?:\s+(after|before))?)?$/);
  if (!m) throw new CrubalError(`a find is "<name> -> first|all <kind> [where <facet> = <value>, …] [order <facet> [after|before]]": ${text}`, line);
  return { name: m[1] as string, take: m[2] as "first" | "all", kind: m[3] as string, where: readPicks(m[4] ?? "", line, routes), ...(m[5] ? { order: { facet: m[5], dir: (m[6] as "after" | "before" | undefined) ?? "after" } } : {}), line };
}

/** `slot -> row of context.station.slots by slotRule over record, record.of keep keep by unit where of = record.of, …` */
function readRoute(text: string, line: number): ActRoute {
  const m = text.match(/^([\w-]+)\s*->\s*row of\s+(\S+)\s+by\s+([\w:]+)\s+over\s+(.+?)(?:\s+keep\s+([\w:]+)\s+by\s+([\w-]+)(?:\s+where\s+(.*))?)?$/);
  if (!m) throw new CrubalError(`a route is "<name> -> row of <ref> by <column> over record[, record.<link>] [keep <column> by <kind> where <picks>]": ${text}`, line);
  const name = m[1] as string;
  const routes = new Set([name]);
  const over = (m[4] as string).split(",").map((s) => s.trim()).filter(Boolean).map((t): ActRef => {
    if (t === "record") return { record: "" };
    const r = readRef(t, line, "a route's over");
    if (!("record" in r)) throw new CrubalError(`a route reads over record or record.<link facet>, not ${t}`, line);
    return r;
  });
  return {
    name,
    rows: readRef(m[2] as string, line, "a route's rows"),
    by: m[3] as string,
    over,
    ...(m[5] ? { keep: { column: m[5], kind: m[6] as string, where: readPicks(m[7] ?? "", line, routes) } } : {}),
    line,
  };
}

/** Revision 45: `<ref|number> + <ref|number>` or `-`, at least one a reference; anything else is not a sum. */
function readSum(t: string, line: number, routes: Set<string>): ActSum | undefined {
  const m = t.match(/^(\S+)\s+([+-])\s+(\S+)$/);
  if (!m) return undefined;
  const num = (x: string) => /^\d+(?:\.\d+)?$/.test(x);
  const a = m[1] as string;
  const b = m[3] as string;
  if (!(num(a) || isRef(a)) || !(num(b) || isRef(b)) || (num(a) && num(b))) return undefined;
  const operand = (x: string): ActOperand => (num(x) ? { number: Number(x) } : readRef(x, line, "a sum", routes));
  return { left: operand(a), op: m[2] as "+" | "-", right: operand(b) };
}

/** `filedIn -> link box`, `filedBox -> box.containerLabel`, `filedAt -> now`, `note -> "words"`,
 * `containerLabel -> next slot.boxPrefix in container.containerLabel, slot.boxSuffix` */
function readSet(text: string, line: number, routes: Set<string>): ActSet {
  const m = text.match(/^([\w:]+)\s*->\s*(.+)$/);
  if (!m) throw new CrubalError(`a set is "<facet> -> <source>": ${text}`, line);
  const facet = m[1] as string;
  const src = (m[2] as string).trim();
  if (src === "link caller") return { facet, source: { caller: true }, line };
  // Revision 46: the person running the act as words (their id), where the facet is text and no link.
  if (src === "caller") return { facet, source: { person: true }, line };
  // Revision 31: the owner's domain, the act run's id, a link to the record in hand (a told post's sender, run and subject).
  if (src === "owner") return { facet, source: { owner: true }, line };
  if (src === "run") return { facet, source: { run: true }, line };
  const link = src.match(/^link\s+([\w-]+)$/);
  if (link) return { facet, source: { link: link[1] as string }, line };
  if (src === "now") return { facet, source: { now: true }, line };
  if (src === "none") return { facet, source: { none: true }, line };
  const next = src.match(/^next\s+("[^"]*"|\S+)\s+in\s+([\w-]+)\.([\w:]+)(?:\s*,\s*(\S+))?$/);
  if (next) {
    return {
      facet,
      source: {
        next: {
          // Revision 35: the prefix may be the words themselves, quoted (`next "PULL" in pull.pullLabel`).
          prefix: (next[1] as string).startsWith('"') ? { literal: unquote(next[1] as string) } : readRef(next[1] as string, line, "a series' prefix", routes),
          in: { kind: next[2] as string, facet: next[3] as string },
          ...(next[4] ? { suffix: readRef(next[4], line, "a series' suffix", routes) } : {}),
        },
      },
      line,
    };
  }
  const sum = readSum(src, line, routes);
  if (sum) return { facet, source: { sum }, line };
  if (isRef(src)) return { facet, source: readRef(src, line, "a set", routes), line };
  return { facet, source: { literal: unquote(src) }, line };
}

function readTerm(t: string, line: number, routes: Set<string>, counts: Set<string>): ActTerm {
  const n = Number(t);
  if (t !== "" && Number.isFinite(n)) return { number: n };
  const m = t.match(/^(.+?)\s*\+\s*(\d+(?:\.\d+)?)$/);
  const word = (m ? (m[1] as string) : t).trim();
  const plus = m ? { plus: Number(m[2]) } : {};
  if (counts.has(word)) return { count: word, ...plus };
  if (/^[\w-]+$/.test(word)) throw new CrubalError(`a when reads ${word}, which no count declares above it`, line);
  return { ref: readRef(word, line, "a when", routes), ...plus };
}

/** `given.count != record.qty and record.qty > 0` (revision 45: `!=`, and comparisons joined by `and`). */
export function readWhen(text: string, line: number, routes: Set<string> = new Set(), counts: Set<string> = new Set()): ActWhen {
  const conds = text.split(/\s+and\s+/).map((c): ActCond => {
    // Revision 47: `has <ref>`, `no <ref>`.
    const h = c.trim().match(/^(has|no)\s+(\S+)$/);
    if (h) return { has: readRef(h[2] as string, line, "a when", routes), ...(h[1] === "no" ? { lacks: true as const } : {}) };
    const m = c.trim().match(/^(.+?)\s*(<=|>=|!=|=|<|>)\s*(.+)$/);
    if (!m) throw new CrubalError(`a when is "<term> <op> <term>", "has <ref>" or "no <ref>", joined by "and": ${c.trim()}`, line);
    return { left: readTerm((m[1] as string).trim(), line, routes, counts), op: m[2] as "=" | "!=" | "<" | ">" | "<=" | ">=", right: readTerm((m[3] as string).trim(), line, routes, counts) };
  });
  const [first, ...rest] = conds as [ActCond, ...ActCond[]];
  return { ...first, ...(rest.length ? { and: rest } : {}) };
}

/** `when box.containerCount + 1 >= box.capacity set box.containerState = full, box.filledAt = now send notify containerFull about context.station` */
function readThen(text: string, line: number, routes: Set<string>, counts: Set<string>): ActThen {
  // Revision 47: `[when …] archive <record|found>` or `restore …`, the record's standing in place of sets.
  const st = text.match(/^(?:when\s+(.+?)\s+)?(archive|restore)\s+([\w-]+)(?:\s+as\s+([\w-]+))?$/);
  if (st && !/(^|\s)set\s/.test(st[1] ?? "")) {
    return { ...(st[1] !== undefined ? { when: readWhen(st[1], line, routes, counts) } : {}), sets: [], stand: { to: st[2] === "archive" ? "archived" : "active", on: st[3] as string, ...(st[4] && st[2] === "archive" ? { reason: st[4] } : {}) }, line };
  }
  // Revision 39: the condition may be left out (`set box.containerState = open`).
  const m = text.match(/^(?:when\s+(.+?)\s+)?set\s+(.+?)(?:\s+send\s+([a-z][\w-]*)(?:\s+(.*))?)?$/);
  if (!m) throw new CrubalError(`a then is "[when <term> <op> <term> [and …]] set <found>.<facet> = <value>[, …] [send <verb> <words>]": ${text}`, line);
  const sets = (m[2] as string)
    .split(/,\s*(?=[\w-]+\.\w+\s*=)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): ActThenSet => {
      const sm = s.match(/^([\w-]+)\.(\w+)\s*=\s*(.+)$/);
      if (!sm) throw new CrubalError(`a then's set is "<found>.<facet> = <value>": ${s}`, line);
      const v = (sm[3] as string).trim();
      const link = v.match(/^link\s+([\w-]+)$/);
      const sum = readSum(v, line, routes);
      const value: ActThenValue = v === "now" ? { now: true } : v === "none" ? { none: true } : v === "caller" ? { person: true } : link ? (link[1] === "caller" ? { caller: true } : { link: link[1] as string }) : sum ? { sum } : isRef(v) ? readRef(v, line, "a then", routes) : { literal: unquote(v) };
      return { found: sm[1] as string, facet: sm[2] as string, value };
    });
  return {
    ...(m[1] !== undefined ? { when: readWhen(m[1] as string, line, routes, counts) } : {}),
    sets,
    ...(m[3] ? { send: { verb: m[3], words: (m[4] ?? "").trim() } } : {}),
    line,
  };
}

/** Read one `act:` block (15). */
export function readAct(node: Node): Act {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!WORD.test(name)) throw new CrubalError(`an act is "act: <name> /<version>", the name a lower-case word: ${node.value}`, node.line);
  const a: Act = { name, version, utility: "", on: "", context: [], finds: [], counts: [], sets: [], thens: [], lands: "now", line: node.line };
  // The route is read first wherever it stands, so the lines after it know its name.
  const routeNode = node.children.find((c) => c.key === "route");
  if (routeNode) {
    const lines = routeNode.children.filter((l) => l.text.trim());
    if (lines.length !== 1) throw new CrubalError(`an act routes once: one line under route:`, routeNode.line);
    a.route = readRoute((lines[0] as Node).text.trim(), (lines[0] as Node).line);
  }
  const routes = new Set(a.route ? [a.route.name] : []);
  const founds = new Set<string>();
  const countNames = new Set<string>();
  for (const c of node.children) {
    if (!c.key) continue;
    const v = c.value.trim();
    if (c.key === "utility") a.utility = v;
    else if (c.key === "replaces") {
      if (!WORD.test(v)) throw new CrubalError(`replaces names an act, a lower-case word: ${v}`, c.line);
      a.replaces = v;
    } else if (c.key === "label") a.label = unquote(v);
    else if (c.key === "describe") a.describe = unquote(v);
    else if (c.key === "on") a.on = v;
    else if (c.key === "takes") {
      if (v !== "share") throw new CrubalError(`takes is "share": the act may land on fewer than the record holds, not ${v}`, c.line);
      a.takes = "share";
    }
    else if (c.key === "context") {
      a.context = v.split(",").map((s) => s.trim()).filter(Boolean);
      for (const k of a.context) if (!WORD.test(k)) throw new CrubalError(`context names kinds, lower-case words: ${k}`, c.line);
    } else if (c.key === "needs") {
      for (const l of c.children) {
        const t = l.text.trim();
        if (!t) continue;
        // Revision 51: `<facet> = <value>` and `<facet> != <value>`, the value a word or a number.
        const is = t.match(/^([\w:]+(?:\.\w+)?)\s*(!=|=)\s*([\w.-]+)(?:\s+"([^"]+)")?$/);
        if (is) {
          (a.needs ??= []).push({ facet: is[1] as string, is: { op: is[2] as "=" | "!=", value: is[3] as string }, ...(is[4] ? { words: is[4] } : {}), line: l.line });
          continue;
        }
        const m = t.match(/^(no\s+)?([\w:]+(?:\.\w+)?)(?:\s+"([^"]+)")?$/);
        if (!m) throw new CrubalError(`a need is "<facet>", "no <facet>", "<facet> = <value>" or "<facet> != <value>" (the facet the record's own, or "<link facet>.<facet>", the linked record's), its words in quotes after it or not: ${t}`, l.line);
        (a.needs ??= []).push({ facet: m[2] as string, ...(m[1] ? { lacks: true as const } : {}), ...(m[3] ? { words: m[3] } : {}), line: l.line });
      }
      if (!a.needs?.length) throw new CrubalError(`the act ${name} needs nothing: its lines go beneath needs:`, c.line);
    } else if (c.key === "given") {
      for (const l of c.children) {
        const t = l.text.trim();
        if (!t) continue;
        const m = t.match(/^([\w-]+)\s+as\s+([\w:]+)(?:\s+"([^"]+)")?(?:\s+from\s+(\S+)|\s+default\s+(.+))?$/);
        if (!m || !WORD.test(m[1] as string)) throw new CrubalError(`a given is "<name> as <facet>", its words in quotes after it or not, then "from <ref>" (what the question opens on) or "default <value>" (what it takes unasked) or neither: ${t}`, l.line);
        if (a.given?.some((g) => g.name === m[1])) throw new CrubalError(`the act ${name} is given ${m[1]} twice`, l.line);
        (a.given ??= []).push({ name: m[1] as string, facet: m[2] as string, ...(m[3] ? { words: m[3] } : {}), ...(m[4] ? { from: readRef(m[4], l.line, "a given's from", routes) } : {}), ...(m[5] !== undefined ? { default: unquote(m[5].trim()) } : {}), line: l.line });
      }
      if (!a.given?.length) throw new CrubalError(`the act ${name} is given nothing: its lines go beneath given:`, c.line);
    } else if (c.key === "route") continue;
    else if (c.key === "find") for (const l of c.children) { if (l.text.trim()) { const f = readFind(l.text.trim(), l.line, routes); a.finds.push(f); founds.add(f.name); } }
    else if (c.key === "count") for (const l of c.children) { if (l.text.trim()) { const k = readCount(l.text.trim(), l.line, routes, founds); a.counts.push(k); countNames.add(k.name); } }
    else if (c.key === "mint") {
      for (const l of c.children) {
        if (!l.text.trim()) continue;
        const m = l.text.trim().match(/^([\w-]+)\s*->\s*([\w-]+)\s+when none$/);
        if (!m) throw new CrubalError(`a mint is "<found> -> <kind> when none", its set lines beneath: ${l.text.trim()}`, l.line);
        const f = a.finds.find((x) => x.name === m[1]);
        if (!f) throw new CrubalError(`the mint ${m[1]} names no find above it`, l.line);
        if (f.take !== "first") throw new CrubalError(`the mint ${m[1]} is of a find that takes all: a mint stands in for the first`, l.line);
        if (f.mint) throw new CrubalError(`${m[1]} is minted twice`, l.line);
        f.mint = { kind: m[2] as string, sets: l.children.filter((s) => s.text.trim()).map((s) => readSet(s.text.trim(), s.line, routes)), line: l.line };
        if (!f.mint.sets.length) throw new CrubalError(`the mint ${m[1]} sets nothing: its set lines go beneath it`, l.line);
      }
    } else if (c.key === "make") {
      // Revision 45: `<name> -> <kind> [when …]`, its set lines beneath: a record made when the act lands.
      for (const l of c.children) {
        if (!l.text.trim()) continue;
        const m = l.text.trim().match(/^([\w-]+)\s*->\s*([\w-]+)(?:\s+when\s+(.+))?$/);
        if (!m || !WORD.test(m[1] as string)) throw new CrubalError(`a make is "<name> -> <kind> [when <term> <op> <term> [and …]]", its set lines beneath: ${l.text.trim()}`, l.line);
        const make: ActMake = { name: m[1] as string, kind: m[2] as string, ...(m[3] ? { when: readWhen(m[3], l.line, routes, countNames) } : {}), sets: l.children.filter((x) => x.text.trim()).map((x) => readSet(x.text.trim(), x.line, routes)), line: l.line };
        if (!make.sets.length) throw new CrubalError(`the make ${make.name} sets nothing: its set lines go beneath it`, l.line);
        (a.makes ??= []).push(make);
      }
      if (!a.makes?.length) throw new CrubalError(`the act ${name} makes nothing: its lines go beneath make:`, c.line);
    } else if (c.key === "also" || c.key === "first") {
      // Revision 47: `[<utility>/]<act> on record|<found> [with <given> = <value>, …] [when …]`: an act run when
      // this one has landed (`also`) or, revision 49, before it lands (`first`).
      const list: ActAlso[] = [];
      for (const l of c.children) {
        if (!l.text.trim()) continue;
        const m = l.text.trim().match(/^(?:([a-z][\w-]*)\/)?([a-z][\w-]*)\s+on\s+([\w-]+)(?:\s+with\s+(.+?))?(?:\s+when\s+(.+))?$/);
        if (!m) throw new CrubalError(`${c.key === "also" ? "an also" : "a first"} is "[<utility>/]<act> on record|<found> [with <given> = <value>, …] [when …]": ${l.text.trim()}`, l.line);
        const gives = (m[4] ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
          const g = x.match(/^([\w-]+)\s*=\s*(.+)$/);
          if (!g) throw new CrubalError(`a with is "<given> = <value>": ${x}`, l.line);
          const v = (g[2] as string).trim();
          return { name: g[1] as string, value: isRef(v) ? readRef(v, l.line, "a with", routes) : { literal: unquote(v) } };
        });
        list.push({ ...(m[1] ? { utility: m[1] } : {}), act: m[2] as string, on: m[3] as string, ...(gives.length ? { with: gives } : {}), ...(m[5] ? { when: readWhen(m[5], l.line, routes, countNames) } : {}), line: l.line });
      }
      if (!list.length) throw new CrubalError(`the act ${name} runs nothing ${c.key}: its lines go beneath ${c.key}:`, c.line);
      if (c.key === "also") a.also = [...(a.also ?? []), ...list];
      else a.first = [...(a.first ?? []), ...list];
    } else if (c.key === "set") for (const l of c.children) { if (l.text.trim()) a.sets.push(readSet(l.text.trim(), l.line, routes)); }
    else if (c.key === "then") for (const l of c.children) { if (l.text.trim()) a.thens.push(readThen(l.text.trim(), l.line, routes, countNames)); }
    else if (c.key === "send") {
      const m = v.match(/^([a-z][\w-]*)(?:\s+(.*))?$/);
      if (!m) throw new CrubalError(`a send is "<verb> <words>": ${v}`, c.line);
      a.send = { verb: m[1] as string, words: (m[2] ?? "").trim() };
    } else if (c.key === "lands") {
      if (v === "now") a.lands = "now";
      else if (/^when the send reports$/.test(v)) a.lands = "reports";
      else throw new CrubalError(`lands is "now" or "when the send reports", not ${v}`, c.line);
    } else if (c.key === "tells") {
      const m = v.match(/^([\w-]+)\s+as\s+([a-z][\w-]*)$/);
      if (!m) throw new CrubalError(`tells is "<kind> as <aspect>", its set lines beneath: ${v}`, c.line);
      if (a.tells) throw new CrubalError(`the act ${name} tells twice`, c.line);
      a.tells = { kind: m[1] as string, aspect: m[2] as string, sets: c.children.filter((l) => l.text.trim()).map((l) => readSet(l.text.trim(), l.line, routes)), line: c.line };
      if (!a.tells.sets.length) throw new CrubalError(`the act ${name} tells ${m[1]} and sets nothing: its set lines go beneath tells:`, c.line);
    } else throw new CrubalError(`an act has utility, replaces, label, describe, on, takes, context, needs, given, route, find, mint, count, make, set, then, also, first, send, lands and tells, not ${c.key}`, c.line);
  }
  if (!a.utility) throw new CrubalError(`the act ${name} names no utility`, node.line);
  if (!a.on) throw new CrubalError(`the act ${name} says no on: the level it acts on`, node.line);
  if (a.replaces === a.name) throw new CrubalError(`the act ${name} replaces itself`, node.line);
  if (a.lands === "reports" && !a.send) throw new CrubalError(`the act ${name} lands when the send reports, but sends nothing`, node.line);
  return a;
}

// ─── Checking ─────────────────────────────────────────────────────────────────

/** What an act's checks read; `strict` at publish for a package extending nothing, and in force at install. */
export type ActEnv = {
  utilities: { name: string; acts: { name: string }[] }[];
  levels: Set<string>;
  kinds: Set<string>;
  facets: Set<string>;
  /** The facet itself, when the dictionary is at hand: a compound's columns and a link's type are checked by it. */
  facetOf?: (key: string) => Facet | undefined;
  /** The aspects the kinds declare under `follow:` (revision 31), which an act's `tells:` may answer. */
  aspects?: Set<string>;
  /** Revision 35: level → the facet that is its quantity (a kind's `shares:`), which `takes: share` needs. */
  shares?: Map<string, string>;
  /** In force (11.4): a telling whose aspect no kind in force declares is inert, never a refusal, since nobody
   * can follow by an aspect nobody declares; the kind that declares it may land later. Refused at publish only. */
  inertTelling?: boolean;
  strict: boolean;
  here: string;
};

const bare = (facet: string) => facet.replace(/^\w+::/, "");

/** Every term a `when` reads, its `and`s among them. */
export const termsOf = (w: ActWhen | undefined): ActTerm[] => (w ? [w, ...(w.and ?? [])].flatMap((c): ActTerm[] => ("has" in c ? [{ ref: c.has }] : [c.left, c.right])) : []);

/** `of` is a record's parent (1.1), no facet: it may stand where a facet may (a pick's facet, `record.of`, a
 * route's `over`) and the dictionary is never asked for it. */
const PARENT = "of";

/** The checks (15.3). */
export function checkActList(acts: Act[], env: ActEnv): void {
  const { strict, here } = env;
  for (const a of acts) {
    const where = `the act ${a.name}`;
    const u = env.utilities.find((x) => x.name === a.utility);
    if (!u && strict) throw new CrubalError(`${where} names the utility ${a.utility}, which isn't ${here}`, a.line);
    if (u) {
      const listed = (n: string) => u.acts.some((x) => x.name === n);
      if (a.replaces && !listed(a.replaces)) throw new CrubalError(`${where} replaces ${a.replaces}, which isn't among ${a.utility}'s acts`, a.line);
      if (!a.replaces && !listed(a.name)) throw new CrubalError(`${where} isn't among ${a.utility}'s acts`, a.line);
    }
    if (!env.levels.has(a.on) && strict) throw new CrubalError(`${where} is on ${a.on}, which isn't a level ${here}`, a.line);
    if (a.takes && env.shares && env.levels.has(a.on) && !env.shares.has(a.on)) throw new CrubalError(`${where} takes a share, and ${a.on} declares no quantity: its kind's shares names none for it`, a.line);
    for (const k of a.context) if (!env.kinds.has(k) && !env.levels.has(k) && strict) throw new CrubalError(`${where}'s context names ${k}, which isn't a kind ${here}`, a.line);
    const facetKnown = (f: string) => env.facets.has(bare(f));
    const needFacet = (f: string, line: number, doing: string) => {
      if (bare(f) === PARENT) return;
      if (!facetKnown(f) && strict) throw new CrubalError(`${where} ${doing} ${f}, which isn't a facet ${here}`, line);
    };
    const found = new Set<string>();
    const routeName = a.route?.name;
    const columns = (r: ActRef): Set<string> | undefined => {
      const key = "context" in r ? r.facet : "record" in r ? r.record : undefined;
      const f = key ? env.facetOf?.(bare(key)) : undefined;
      return f?.type === "compound" && f.children ? new Set(f.children.keys()) : undefined;
    };
    const routeColumns = a.route ? columns(a.route.rows) : undefined;
    const givens = new Set((a.given ?? []).map((g) => g.name));
    const refOk = (r: ActRef, line: number, inCount = false) => {
      if ("given" in r) {
        if (!givens.has(r.given)) throw new CrubalError(`${where} reads given.${r.given}, which its given lacks`, line);
        return;
      }
      if ("found" in r && !found.has(r.found)) throw new CrubalError(`${where} names ${r.found}, which no find declares`, line);
      if ("found" in r && !r.facet) return;
      if ("route" in r) {
        if (r.route !== routeName) throw new CrubalError(`${where} names ${r.route}, which no route declares`, line);
        if (routeColumns && !routeColumns.has(r.column)) throw new CrubalError(`${where} reads ${r.route}.${r.column}, a column the rows lack`, line);
        return;
      }
      if ("context" in r && !a.context.includes(r.context)) throw new CrubalError(`${where} names context.${r.context}, which its context lacks`, line);
      const facet = "found" in r ? r.facet : "record" in r ? r.record : r.facet;
      if (facet) needFacet(facet, line, inCount ? "counts by" : "reads");
    };
    const picksOk = (picks: ActPick[], what: string, inCount = false) => {
      for (const p of picks) {
        const [head, hop] = p.facet.split(".");
        needFacet(head as string, p.line, `${what} picks`);
        if (hop) {
          const f = bare(head as string) === PARENT ? undefined : env.facetOf?.(bare(head as string));
          if (f && f.type !== "link") throw new CrubalError(`${where} ${what} picks through ${head}, which isn't a link`, p.line);
          needFacet(hop, p.line, `${what} picks`);
        }
        if (!("literal" in p.value) && !("caller" in p.value) && !("self" in p.value)) refOk(p.value, p.line, inCount);
      }
    };
    for (const g of a.given ?? []) {
      needFacet(g.facet, g.line, `is given ${g.name} as`);
      if (g.from) {
        if (!("record" in g.from) && !("context" in g.from)) throw new CrubalError(`${where}'s given ${g.name} opens from ${refText(g.from)}: a given is asked before anything is found, so it opens from record.<facet> or context.<kind>.<facet>`, g.line);
        refOk(g.from, g.line);
      }
    }
    if (a.route) {
      const r = a.route;
      if ("given" in r.rows) throw new CrubalError(`${where} routes over rows that aren't the record's or a context record's`, r.line);
      if ("context" in r.rows && !r.rows.facet) throw new CrubalError(`${where} routes over context.${r.rows.context}, which names no facet: the rows are a compound facet's`, r.line);
      if ("found" in r.rows || "route" in r.rows) throw new CrubalError(`${where} routes over rows that aren't the record's or a context record's`, r.line);
      refOk(r.rows, r.line);
      const rowsFacet = "context" in r.rows ? r.rows.facet : "record" in r.rows ? r.rows.record : undefined;
      const rf = rowsFacet ? env.facetOf?.(bare(rowsFacet)) : undefined;
      if (rf && rf.type !== "compound") throw new CrubalError(`${where} routes over ${rowsFacet}, which isn't a compound`, r.line);
      if (routeColumns && !routeColumns.has(r.by)) throw new CrubalError(`${where} routes by ${r.by}, a column the rows lack`, r.line);
      for (const o of r.over) if ("record" in o && o.record && bare(o.record) !== PARENT) {
        needFacet(o.record, r.line, "routes over");
        const lf = env.facetOf?.(bare(o.record));
        if (lf && lf.type !== "link") throw new CrubalError(`${where} routes over record.${o.record}, which isn't a link`, r.line);
      }
      if (r.keep) {
        if (routeColumns && !routeColumns.has(r.keep.column)) throw new CrubalError(`${where} keeps by ${r.keep.column}, a column the rows lack`, r.line);
        if (!env.kinds.has(r.keep.kind) && !env.levels.has(r.keep.kind) && strict) throw new CrubalError(`${where} counts ${r.keep.kind}, which isn't a kind ${here}`, r.line);
        picksOk(r.keep.where, "'s count", true);
      }
    }
    // Revision 48: a make's name may stand where a link's target does.
    const makeNames = new Set((a.makes ?? []).map((m) => m.name));
    const sumOk = (sum: ActSum, line: number) => {
      for (const o of [sum.left, sum.right]) if (!("number" in o)) refOk(o, line);
    };
    const sourceOk = (s: ActSet, doing: string) => {
      needFacet(s.facet, s.line, doing);
      const src = s.source;
      if ("link" in src) {
        if (src.link !== "record" && !found.has(src.link) && !a.context.includes(src.link) && !makeNames.has(src.link)) throw new CrubalError(`${where} links ${s.facet} to ${src.link}, which no find or context declares`, s.line);
      } else if ("next" in src) {
        if (!("literal" in src.next.prefix)) refOk(src.next.prefix, s.line);
        if (src.next.suffix) refOk(src.next.suffix, s.line);
        if (!env.kinds.has(src.next.in.kind) && !env.levels.has(src.next.in.kind) && strict) throw new CrubalError(`${where} numbers ${s.facet} in ${src.next.in.kind}, which isn't a kind ${here}`, s.line);
        needFacet(src.next.in.facet, s.line, "numbers by");
      } else if ("sum" in src) sumOk(src.sum, s.line);
      else if (!("literal" in src) && !("now" in src) && !("caller" in src) && !("person" in src) && !("none" in src) && !("owner" in src) && !("run" in src)) refOk(src, s.line);
    };
    for (const f of a.finds) {
      if (found.has(f.name)) throw new CrubalError(`${where} finds ${f.name} twice`, f.line);
      if (f.name === "given") throw new CrubalError(`${where} finds given, the word for what an act is given`, f.line);
      if (f.name === "record") throw new CrubalError(`${where} finds record, the word for the record in hand`, f.line);
      if (f.name === routeName) throw new CrubalError(`${where} finds ${f.name}, its route's name`, f.line);
      if (!env.kinds.has(f.kind) && !env.levels.has(f.kind) && strict) throw new CrubalError(`${where} finds ${f.kind}, which isn't a kind ${here}`, f.line);
      picksOk(f.where, `'s find ${f.name}`);
      if (f.order) needFacet(f.order.facet, f.line, `'s find ${f.name} orders by`);
      if (f.mint) {
        if (!env.kinds.has(f.mint.kind) && !env.levels.has(f.mint.kind) && strict) throw new CrubalError(`${where} mints ${f.mint.kind}, which isn't a kind ${here}`, f.mint.line);
        const set = new Set<string>();
        for (const s of f.mint.sets) {
          if (set.has(s.facet)) throw new CrubalError(`${where}'s mint ${f.name} sets ${s.facet} twice`, s.line);
          set.add(s.facet);
          sourceOk(s, "mints");
        }
      }
      found.add(f.name);
    }
    const counted = new Set<string>();
    for (const k of a.counts) {
      if (counted.has(k.name) || found.has(k.name) || k.name === routeName) throw new CrubalError(`${where} counts ${k.name}, a name already taken`, k.line);
      if (!env.kinds.has(k.kind) && !env.levels.has(k.kind) && strict) throw new CrubalError(`${where} counts ${k.kind}, which isn't a kind ${here}`, k.line);
      picksOk(k.where, `'s count ${k.name}`, true);
      counted.add(k.name);
    }
    const sets = new Set<string>();
    for (const s of a.sets) {
      if (sets.has(s.facet)) throw new CrubalError(`${where} sets ${s.facet} twice`, s.line);
      sets.add(s.facet);
      sourceOk(s, "sets");
    }
    if (a.tells) {
      const t = a.tells;
      if (!env.kinds.has(t.kind) && !env.levels.has(t.kind) && strict) throw new CrubalError(`${where} tells ${t.kind}, which isn't a kind ${here}`, t.line);
      if (env.aspects && !env.aspects.has(t.aspect) && strict && !env.inertTelling) throw new CrubalError(`${where} tells ${t.kind} as ${t.aspect}, an aspect no kind declares under follow ${here}`, t.line);
      const set = new Set<string>();
      for (const s of t.sets) {
        if (set.has(s.facet)) throw new CrubalError(`${where} tells ${t.kind} and sets ${s.facet} twice`, s.line);
        set.add(s.facet);
        sourceOk(s, "tells with");
      }
    }
    for (const n of a.needs ?? []) for (const part of n.facet.split(".")) needFacet(part, n.line, "needs");
    const whenOk = (w: ActWhen | undefined, line: number) => {
      for (const term of termsOf(w)) {
        if ("ref" in term) refOk(term.ref, line);
        if ("count" in term && !counted.has(term.count)) throw new CrubalError(`${where} reads ${term.count}, which no count declares`, line);
      }
    };
    const made = new Set<string>();
    for (const m of a.makes ?? []) {
      if (made.has(m.name) || found.has(m.name) || counted.has(m.name) || m.name === routeName || m.name === "given" || m.name === "record") throw new CrubalError(`${where} makes ${m.name}, a name already taken`, m.line);
      made.add(m.name);
      if (!env.kinds.has(m.kind) && !env.levels.has(m.kind) && strict) throw new CrubalError(`${where} makes ${m.kind}, which isn't a kind ${here}`, m.line);
      whenOk(m.when, m.line);
      const set = new Set<string>();
      for (const s of m.sets) {
        if (set.has(s.facet)) throw new CrubalError(`${where}'s make ${m.name} sets ${s.facet} twice`, s.line);
        set.add(s.facet);
        sourceOk(s, "makes with");
      }
    }
    for (const x of [...(a.also ?? []), ...(a.first ?? [])]) {
      if (x.on !== "record" && !found.has(x.on)) throw new CrubalError(`${where} also runs ${x.act} on ${x.on}, which no find declares`, x.line);
      const own = !x.utility || x.utility === a.utility;
      if (own && x.act === a.name && x.on === "record") throw new CrubalError(`${where} also runs itself on the record in hand`, x.line);
      const xu = env.utilities.find((y) => y.name === (x.utility ?? a.utility));
      if (xu && !xu.acts.some((y) => y.name === x.act) && !acts.some((y) => y.utility === xu.name && y.name === x.act)) throw new CrubalError(`${where} also runs ${x.act}, which isn't among ${xu.name}'s acts`, x.line);
      whenOk(x.when, x.line);
    }
    for (const t of a.thens) {
      whenOk(t.when, t.line);
      if (t.stand && t.stand.on !== "record" && !found.has(t.stand.on)) throw new CrubalError(`${where} then ${t.stand.to === "archived" ? "archives" : "restores"} ${t.stand.on}, which no find declares`, t.line);
      for (const s of t.sets) {
        // Revision 45: a then may write on the record in hand, `record.<facet>`.
        if (s.found !== "record" && !found.has(s.found)) throw new CrubalError(`${where} then sets ${s.found}, which no find declares`, t.line);
        needFacet(s.facet, t.line, "then sets");
        const v = s.value;
        if ("link" in v) {
          if (v.link !== "record" && !found.has(v.link) && !a.context.includes(v.link) && !makeNames.has(v.link)) throw new CrubalError(`${where} then links ${s.found}.${s.facet} to ${v.link}, which no find or context declares`, t.line);
        } else if ("sum" in v) sumOk(v.sum, t.line);
        else if (!("literal" in v) && !("now" in v) && !("none" in v) && !("caller" in v) && !("person" in v)) refOk(v, t.line);
      }
    }
  }
}

// ─── The steps, pure ───────────────────────────────────────────────────────────

/** A record as the act reads it: its id, its values, and its parent (`of`, 1.1) when it has one. */
export type ActRecord = { id: string; values: JsonObject; of?: string };

export type ActInput = {
  record: ActRecord;
  /** The context records, by kind. */
  context: { [kind: string]: ActRecord };
  /** The records the record in hand links to, by link facet (`record.of` → the product), for a route's `over`. */
  linked?: { [facet: string]: ActRecord };
  /** The row the route took, when it routes. */
  route?: { index: number; row: JsonObject };
  /** What each find answered (or minted), by name: one or more records; a `first` find answered takes the first. */
  found: { [name: string]: ActRecord[] };
  /** The counts answered, by name (the records of the kind the picks admit, as the host counted them). */
  counts?: { [name: string]: number };
  /** The labels a series reads, by `<kind>.<facet>`: what the kind's facet carries today. */
  labels?: { [kindFacet: string]: string[] };
  /** The moment, as the host stamps it. */
  now: string;
  /** The person running the act (revision 29): what `link caller` links to. */
  caller?: string;
  /** The owner the act lands at (revision 31): what a told post's `owner` source carries. */
  owner?: string;
  /** The act run's id (revision 31): what a told post's `run` source carries. */
  run?: string;
  /** Revision 44: what the act was given, by name, defaults filled (`givenOf`). */
  given?: { [name: string]: Json };
  /** Revision 44: the facets, so a given its facet refuses stops the act before any write. */
  facetOf?: (key: string) => Facet | undefined;
  /** Revision 48: the names of the act's makes, which a link may name; `actWrites` fills it. */
  made?: string[];
  /** The facets that are marks (revision 34): those a marked filter in force names. A mark is taken once. */
  marks?: string[];
};

export type ActWrites =
  | {
      ok: true;
      record: JsonObject;
      /** The record's facets a set clears (`none`, revision 29): taken off, since a value is never null. */
      clear: string[];
      /** Each found record's writes; `clear` (revision 39) the facets a then gives back, taken off as the record's are. */
      then: { id: string; values: JsonObject; clear?: string[] }[];
      /** Revision 45: the records to make, in the order written, for the host to make in the act's own entry;
       * present where the act declares a make. */
      makes?: { name: string; kind: string; values: JsonObject }[];
      /** Revision 47: the records whose standing the act changes, for the host to write in the act's own entry;
       * present where a then archives or restores. */
      stands?: { id: string; to: "archived" | "active"; reason?: string }[];
      /** Revision 47: the acts to run once this one has landed, each on its record; present where the act says also. */
      also?: ActRun[];
      sends: { verb: string; words: string }[];
    }
  | { ok: false; why: string };

/** A record's facet, or its parent's id for `of`. */
const facetOf = (rec: ActRecord | undefined, facet: string): Json | undefined => {
  if (!rec) return undefined;
  const f = bare(facet);
  return f === PARENT ? (rec.of ?? rec.values[f]) : rec.values[f];
};

const valueOf = (r: ActRef, i: Pick<ActInput, "record" | "context" | "found" | "route" | "given">): Json | undefined => {
  if ("given" in r) return i.given?.[r.given];
  if ("record" in r) return facetOf(i.record, r.record);
  if ("context" in r) return r.facet ? facetOf(i.context[r.context], r.facet) : i.context[r.context]?.id;
  if ("route" in r) return i.route?.row[r.column];
  return r.facet ? facetOf(i.found[r.found]?.[0], r.facet) : i.found[r.found]?.[0]?.id;
};

/** Revision 48: a value as an amount: a number, or money or a quantity with what it is of (1.4). */
type Amount = { n: number; of?: { money: string } | { qty: string }; places: number };
const amountOf = (v: Json | undefined): Amount | undefined => {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : undefined;
  const raw = o ? ("$money" in o ? o.$money : "$qty" in o ? o.$qty : undefined) : v;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (text === "" || !Number.isFinite(Number(text))) return undefined;
  const places = (text.split(".")[1] ?? "").length;
  return { n: Number(text), places, ...(o && "$money" in o ? { of: { money: String(o.currency ?? "") } } : o && "$qty" in o ? { of: { qty: String(o.unit ?? "") } } : {}) };
};
const sameOf = (a: Amount["of"], b: Amount["of"]): boolean => !a || !b || JSON.stringify(a) === JSON.stringify(b);

const termAmount = (t: ActTerm, i: ActInput): Amount | undefined => {
  if ("number" in t) return { n: t.number, places: 0 };
  if ("count" in t) {
    const c = i.counts?.[t.count];
    return c === undefined ? undefined : { n: c + (t.plus ?? 0), places: 0 };
  }
  const a = amountOf(valueOf(t.ref, i));
  return a ? { ...a, n: a.n + (t.plus ?? 0) } : undefined;
};
const numberOf = (t: ActTerm, i: ActInput): number | undefined => termAmount(t, i)?.n;

/** Revision 45: a sum's value. A reference that holds nothing reads as 0; one that holds no number refuses. */
const sumValue = (sum: ActSum, i: ActInput): { ok: true; value: Json } | { ok: false; why: string } => {
  const read = (o: ActOperand): Amount | string => {
    if ("number" in o) return { n: o.number, places: (String(o.number).split(".")[1] ?? "").length };
    const v = valueOf(o, i);
    if (v === undefined || v === null || v === "") return { n: 0, places: 0 };
    return amountOf(v) ?? `${refText(o)} holds no number to ${sum.op === "+" ? "add" : "take from"}`;
  };
  const l = read(sum.left);
  if (typeof l === "string") return { ok: false, why: l };
  const r = read(sum.right);
  if (typeof r === "string") return { ok: false, why: r };
  // Revision 48: money and quantities keep what they are of; two that differ are not summed.
  if (!sameOf(l.of, r.of)) return { ok: false, why: `${"number" in sum.left ? sum.left.number : refText(sum.left)} and ${"number" in sum.right ? sum.right.number : refText(sum.right)} are not of one currency or unit` };
  const n = sum.op === "+" ? l.n + r.n : l.n - r.n;
  const of = l.of ?? r.of;
  if (!of) return { ok: true, value: String(Number(n.toFixed(6))) };
  const amount = n.toFixed(Math.min(6, Math.max(l.places, r.places)));
  return { ok: true, value: "money" in of ? { $money: amount, currency: of.money } : { $qty: amount, unit: of.qty } };
};

/** Whether a `when` holds as the input stands: every comparison of it. A term that reads no number holds nowhere. */
export const whenHolds = (when: ActWhen | undefined, on: ActInput): boolean => {
  if (!when) return true;
  return [when, ...(when.and ?? [])].every((c) => {
    if ("has" in c) {
      const v = valueOf(c.has, on);
      const holds = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
      return holds !== !!c.lacks;
    }
    const la = termAmount(c.left, on);
    const ra = termAmount(c.right, on);
    // Revision 48: money against money of another currency, or a quantity of another unit, holds nowhere.
    if (!la || !ra || !sameOf(la.of, ra.of)) return false;
    const l = la.n;
    const r = ra.n;
    return c.op === "=" ? l === r : c.op === "!=" ? l !== r : c.op === "<" ? l < r : c.op === ">" ? l > r : c.op === "<=" ? l <= r : l >= r;
  });
};

const asWords = (v: Json | undefined): string => (v === undefined || v === null ? "" : typeof v === "object" ? (typeof (v as JsonObject).$link === "string" ? String((v as JsonObject).$link) : JSON.stringify(v)) : String(v));

/** The rows a route reads, as the record carries them: a compound's rows, each an object. */
export function routeRowsOf(r: ActRoute, i: Pick<ActInput, "record" | "context" | "found" | "route">): JsonObject[] {
  const v = valueOf(r.rows, i);
  return Array.isArray(v) ? v.filter((x): x is JsonObject => !!x && typeof x === "object" && !Array.isArray(x)) : [];
}

/** The picks of a route's count for one row, resolved for the host to run (the row's columns read as the row
 * being weighed). */
export function routeCountPicksOf(r: ActRoute, i: Omit<ActInput, "found" | "now" | "route"> & { found?: ActInput["found"] }, row: JsonObject): { facet: string; value: Json | undefined }[] {
  if (!r.keep) return [];
  const at = { record: i.record, context: i.context, found: i.found ?? {}, route: { index: -1, row } };
  return r.keep.where.map((p) => ({ facet: p.facet.includes("::") ? p.facet.replace(/^\w+::/, "") : p.facet, value: "literal" in p.value ? p.value.literal : "caller" in p.value ? i.caller : "self" in p.value ? i.record.id : valueOf(p.value, at) }));
}

export type Routed = { ok: true; index: number; row: JsonObject; why: string } | { ok: false; why: string };

/** The row a route takes (15.1): the rack in order, each row's condition over the values laid as `over` says; the
 * last row the catch-all; a row whose count is its keep or more passed over. `counts` are the host's answers to
 * `routeCountPicksOf` per row, when the route keeps. Pure. */
export function routeOf(r: ActRoute, i: Omit<ActInput, "found" | "route"> & { found?: ActInput["found"] }, counts: (number | undefined)[] = []): Routed {
  const rows = routeRowsOf(r, { record: i.record, context: i.context, found: i.found ?? {} });
  if (!rows.length) return { ok: false, why: `no rows to route by` };
  let values: JsonObject = {};
  for (const o of r.over) {
    if ("record" in o && !o.record) values = { ...values, ...i.record.values };
    else if ("record" in o) values = { ...values, ...(i.linked?.[bare(o.record)]?.values ?? {}) };
  }
  // The record in hand's values lie over the linked record's whatever the order written: its own word wins.
  values = { ...values, ...i.record.values };
  for (const [n, row] of rows.entries()) {
    const last = n === rows.length - 1;
    if (!last) {
      const rule = row[r.by];
      if (typeof rule === "string" && rule.trim()) {
        let truth: boolean | "undetermined";
        try {
          truth = evaluate(parseCondition(rule), values, undefined, i.now);
        } catch (e) {
          return { ok: false, why: `the rule of row ${n + 1} can't be read: ${e instanceof Error ? e.message : String(e)}` };
        }
        if (truth !== true) continue;
      }
    }
    if (r.keep) {
      const cap = Number(row[r.keep.column]);
      const have = counts[n];
      if (Number.isFinite(cap) && cap > 0 && have !== undefined && have >= cap) continue;
    }
    const rule = typeof row[r.by] === "string" ? String(row[r.by]) : "";
    return { ok: true, index: n, row, why: last ? (n === 0 ? "the one row takes everything" : "nothing above claimed it: the last row") : `row ${n + 1} took it: ${rule || "no rule"}` };
  }
  return { ok: false, why: "no row took it" };
}

/** The next label in a series (15.1): the prefix, one more than the highest number carried after it, three
 * digits, the suffix when given. Pure. */
export function nextInSeries(prefix: string, suffix: string | undefined, labels: string[]): string {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)(?: |$)`);
  let n = 0;
  for (const l of labels) {
    const m = l.match(re);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return [prefix, String(n + 1).padStart(3, "0"), suffix ?? ""].filter(Boolean).join(" ");
}

const sourceValue = (s: ActSet, i: ActInput): { ok: true; value: Json | undefined } | { ok: false; why: string } => {
  const src = s.source;
  if ("literal" in src) return { ok: true, value: src.literal };
  if ("now" in src) return { ok: true, value: i.now };
  if ("none" in src) return { ok: true, value: undefined };
  if ("caller" in src) {
    if (!i.caller) return { ok: false, why: `no caller to link ${s.facet} to` };
    return { ok: true, value: { $link: i.caller } };
  }
  if ("person" in src) {
    if (!i.caller) return { ok: false, why: `no caller to set ${s.facet} to` };
    return { ok: true, value: i.caller };
  }
  if ("owner" in src) {
    if (!i.owner) return { ok: false, why: `no owner to set ${s.facet} to` };
    return { ok: true, value: i.owner };
  }
  if ("run" in src) {
    if (!i.run) return { ok: false, why: `no act run to set ${s.facet} to` };
    return { ok: true, value: i.run };
  }
  if ("link" in src) {
    const id = src.link === "record" ? i.record.id : (i.found[src.link]?.[0]?.id ?? i.context[src.link]?.id);
    // Revision 48: a link to a record the act makes is carried as `{$made: <name>}` for the host to resolve.
    if (!id && i.made?.includes(src.link)) return { ok: true, value: { $made: src.link } };
    if (!id) return { ok: false, why: `nothing to link ${s.facet} to: ${src.link}` };
    return { ok: true, value: { $link: id } };
  }
  if ("sum" in src) return sumValue(src.sum, i);
  if ("next" in src) {
    const prefix = ("literal" in src.next.prefix ? src.next.prefix.literal : asWords(valueOf(src.next.prefix, i))).trim();
    if (!prefix) return { ok: false, why: `no prefix to number ${s.facet} by` };
    const suffix = src.next.suffix ? asWords(valueOf(src.next.suffix, i)).trim() || undefined : undefined;
    return { ok: true, value: nextInSeries(prefix, suffix, i.labels?.[`${src.next.in.kind}.${bare(src.next.in.facet)}`] ?? []) };
  }
  return { ok: true, value: valueOf(src, i) };
};

/** The values a mint makes (15.1), given the row taken, the context and the labels its series reads. Pure. */
export function mintValuesOf(f: ActFind, i: ActInput): { ok: true; kind: string; values: JsonObject } | { ok: false; why: string } {
  if (!f.mint) return { ok: false, why: `${f.name} mints nothing` };
  const values: JsonObject = {};
  for (const s of f.mint.sets) {
    const v = sourceValue(s, i);
    if (!v.ok) return v;
    if (v.value !== undefined && v.value !== "") values[bare(s.facet)] = v.value;
  }
  return { ok: true, kind: f.mint.kind, values };
}

/** The post an act tells when it lands followed (15.1, revision 31): the kind, the aspect and the values, given the
 * owner and the act run's id. The app asks `followersOn` first; with no follower on the record or its ancestors,
 * nothing is made. Pure. */
export function tellsValuesOf(a: Act, i: ActInput): { ok: true; kind: string; aspect: string; values: JsonObject } | { ok: false; why: string } {
  if (!a.tells) return { ok: false, why: `${a.name} tells nothing` };
  const values: JsonObject = {};
  for (const s of a.tells.sets) {
    const v = sourceValue(s, i);
    if (!v.ok) return v;
    if (v.value !== undefined && v.value !== "") values[bare(s.facet)] = v.value;
  }
  return { ok: true, kind: a.tells.kind, aspect: a.tells.aspect, values };
}

const said = (v: Json | undefined): v is Json => v !== undefined && v !== null && v !== "";

/** What an act is given (15.1, revision 44), from what the person said: each given takes what was said, else its
 * default. `asks` names the ones still to ask (no word said and no default); `opens` is what each question opens
 * on (what was said, else its `from` as the record and the context stand, else its default). With the facets at
 * hand (`facetOf`), a value its facet refuses is `refused` with its words, and is not among the values: a word
 * where a number goes, a number outside the facet's range, a choice the facet lacks. Pure. */
export function givenOf(
  a: Pick<Act, "given">,
  told: { [name: string]: Json | undefined },
  i: Pick<ActInput, "record" | "context">,
  facetOf?: (key: string) => Facet | undefined,
): { values: { [name: string]: Json }; asks: string[]; opens: { [name: string]: Json }; refused: { name: string; why: string }[] } {
  const values: { [name: string]: Json } = {};
  const opens: { [name: string]: Json } = {};
  const asks: string[] = [];
  const refused: { name: string; why: string }[] = [];
  const problem = (g: ActGiven, v: Json): string | undefined => {
    const f = facetOf?.(bare(g.facet));
    if (!f) return undefined;
    const c = checkScalar(f, v);
    if (c.flag === "range" && f.range) return `${g.name} is ${f.range.min} to ${f.range.max}`;
    if (c.outcome === "contradiction") return `${g.name} is a ${f.type}${f.type === "choice" && f.values?.length ? `, one of ${f.values.map((x) => x.value).join(", ")}` : ""}`;
    if (f.type === "choice" && !f.open && typeof v === "string" && !(f.values ?? []).some((x) => x.value === v || x.aliases.includes(v))) return `${g.name} is one of ${(f.values ?? []).map((x) => x.value).join(", ")}`;
    return undefined;
  };
  for (const g of a.given ?? []) {
    const t = told[g.name];
    const v = said(t) ? t : g.default;
    const why = said(v) ? problem(g, v) : undefined;
    if (why) refused.push({ name: g.name, why });
    else if (said(v)) values[g.name] = v;
    else asks.push(g.name);
    const from = g.from ? valueOf(g.from, { ...i, found: {} }) : undefined;
    const o = said(t) ? t : said(from) ? from : g.default;
    if (said(o)) opens[g.name] = o;
  }
  return { values, asks, opens, refused };
}

/** The writes an act makes when it lands (15): pure, given what the finds answered or minted. A `first` find
 * that answered nothing stops the act with the reason, before any write. */
export function actWrites(a: Act, i: ActInput): ActWrites {
  // Revision 42: what the record in hand must hold or lack, read before anything else.
  for (const n of a.needs ?? []) {
    // One hop: `<link facet>.<facet>` reads the record the record in hand links to, as the host handed it.
    const [first = "", second] = n.facet.split(".");
    const v = second === undefined ? i.record.values[bare(first)] : i.linked?.[bare(first)]?.values[second];
    const holds = v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);
    if (n.is) {
      // Revision 51: the value as text beside the literal; a value not set is no value, so `=` fails and `!=` holds.
      const same = holds && (typeof v === "string" || typeof v === "number" ? String(v) : serialize(v as Json)) === n.is.value;
      if (same !== (n.is.op === "=")) return { ok: false, why: n.words ?? `${second ?? bare(first)} is ${n.is.op === "=" ? "not " : ""}${n.is.value}` };
      continue;
    }
    if (holds === !!n.lacks) return { ok: false, why: n.words ?? (n.lacks ? `${second ?? bare(first)} is already set` : `${second ?? bare(first)} is not set`) };
  }
  // Revision 44: what the act is given is in hand before any write, a default standing in where nothing was said.
  if (a.given?.length) {
    const g = givenOf(a, i.given ?? {}, i, i.facetOf);
    if (g.refused[0]) return { ok: false, why: g.refused[0].why };
    if (g.asks.length) return { ok: false, why: `${g.asks[0]} is not given` };
    i = { ...i, given: g.values };
  }
  for (const f of a.finds) if (f.take === "first" && !i.found[f.name]?.length) return { ok: false, why: `no ${f.kind} for ${f.name}` };
  if (a.makes?.length) i = { ...i, made: a.makes.map((m) => m.name) };
  const record: JsonObject = {};
  const clear: string[] = [];
  for (const s of a.sets) {
    if ("none" in s.source) {
      clear.push(bare(s.facet));
      continue;
    }
    const v = sourceValue(s, i);
    if (!v.ok) return v;
    if (v.value !== undefined) record[bare(s.facet)] = v.value;
  }
  const then: { id: string; values: JsonObject; clear?: string[] }[] = [];
  const stands: { id: string; to: "archived" | "active"; reason?: string }[] = [];
  const sends: { verb: string; words: string }[] = [];
  for (const t of a.thens) {
    const when = t.when;
    const holdsOn = (on: ActInput): boolean => whenHolds(when, on);
    // Revision 42: a term that reads a found record the then writes on is read on each of those records, and
    // the write is made on those where it holds. Any other condition is read once, as it always was.
    const reads = new Set(termsOf(when).flatMap((x) => ("ref" in x && "found" in x.ref ? [x.ref.found] : [])));
    const each = t.sets.some((s) => reads.has(s.found));
    if (t.stand) {
      // Revision 47: the standing of the record in hand or of each record found, where the condition holds on it.
      const on = t.stand.on;
      const perRecord = on !== "record" && reads.has(on);
      if (!perRecord && !holdsOn(i)) continue;
      for (const rec of on === "record" ? [i.record] : (i.found[on] ?? [])) {
        if (perRecord && !holdsOn({ ...i, found: { ...i.found, [on]: [rec] } })) continue;
        const at = stands.findIndex((x) => x.id === rec.id);
        const next = { id: rec.id, to: t.stand.to, ...(t.stand.reason ? { reason: t.stand.reason } : {}) };
        if (at >= 0) stands[at] = next;
        else stands.push(next);
      }
      continue;
    }
    let held = each ? false : holdsOn(i);
    if (!each && !held) continue;
    for (const s of t.sets) {
      // Revision 39: a then's value is a set's: a link, a value copied, the facet cleared.
      const v = s.value;
      let value: Json | undefined;
      if ("now" in v) value = i.now;
      else if ("literal" in v) value = v.literal;
      else if ("none" in v) value = undefined;
      else if ("caller" in v) {
        if (!i.caller) return { ok: false, why: `no caller to link ${s.found}.${s.facet} to` };
        value = { $link: i.caller };
      } else if ("person" in v) {
        if (!i.caller) return { ok: false, why: `no caller to set ${s.found}.${s.facet} to` };
        value = i.caller;
      } else if ("link" in v) {
        const id = v.link === "record" ? i.record.id : (i.found[v.link]?.[0]?.id ?? i.context[v.link]?.id);
        if (!id && !i.made?.includes(v.link)) return { ok: false, why: `nothing to link ${s.found}.${s.facet} to: ${v.link}` };
        value = id ? { $link: id } : { $made: v.link };
      } else if ("sum" in v) {
        const n = sumValue(v.sum, i);
        if (!n.ok) return n;
        value = n.value;
      } else value = valueOf(v, i);
      const k = bare(s.facet);
      // Revision 45: `record.<facet>` writes on the record in hand, over what its sets wrote.
      if (s.found === "record") {
        if ("none" in v) {
          delete record[k];
          if (!clear.includes(k)) clear.push(k);
        } else if (value !== undefined) {
          record[k] = value;
          const at = clear.indexOf(k);
          if (at >= 0) clear.splice(at, 1);
        }
        continue;
      }
      for (const rec of i.found[s.found] ?? []) {
        if (each) {
          if (!holdsOn(reads.has(s.found) ? { ...i, found: { ...i.found, [s.found]: [rec] } } : i)) continue;
          held = true;
        }
        let have = then.find((x) => x.id === rec.id);
        if (!have) then.push((have = { id: rec.id, values: {} }));
        if ("none" in v) {
          delete have.values[k];
          have.clear = [...(have.clear ?? []).filter((c) => c !== k), k];
        } else if (value !== undefined) {
          have.values[k] = value;
          if (have.clear) have.clear = have.clear.filter((c) => c !== k);
        }
      }
    }
    if (t.send && held) sends.push({ ...t.send });
  }
  // A mark is taken once (15.2, revision 34): a write to a mark that holds a real value stops the act before
  // any write, with the reason; clearing one (`none`) is how an act gives it back.
  const held = (r: ActRecord, k: string) => { const v = r.values[k]; return v !== undefined && v !== "" && !(Array.isArray(v) && !v.length); };
  for (const m of i.marks ?? []) {
    const k = bare(m);
    if (k in record && held(i.record, k)) return { ok: false, why: `${k} is taken: a mark is set once` };
    for (const t of then) {
      const rec = Object.values(i.found).flat().find((x) => x.id === t.id);
      if (k in t.values && rec && held(rec, k)) return { ok: false, why: `${k} is taken on ${t.id}: a mark is set once` };
    }
  }
  // Revision 45: the records made, each read as the record in hand stood before the act's writes.
  const makes: { name: string; kind: string; values: JsonObject }[] = [];
  for (const m of a.makes ?? []) {
    if (!whenHolds(m.when, i)) continue;
    const values: JsonObject = {};
    for (const s of m.sets) {
      const v = sourceValue(s, i);
      if (!v.ok) return v;
      if (v.value !== undefined && v.value !== "") values[bare(s.facet)] = v.value;
    }
    makes.push({ name: m.name, kind: m.kind, values });
  }
  // Revision 48: a link to a make that was not made (its `when` did not hold) writes nothing.
  if (a.makes?.length) {
    const was = new Set(makes.map((m) => m.name));
    const sweep = (values: JsonObject) => {
      for (const [k, v] of Object.entries(values)) if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as JsonObject).$made === "string" && !was.has(String((v as JsonObject).$made))) delete values[k];
    };
    sweep(record);
    for (const t of then) sweep(t.values);
    for (const m of makes) sweep(m.values);
  }
  // Revision 47: the acts run once this one has landed, each read as the record in hand stood.
  const also = runsOf(a.also, i);
  return { ok: true, record, clear, then, ...(a.makes?.length ? { makes } : {}), ...(a.thens.some((t) => t.stand) ? { stands } : {}), ...(a.also?.length ? { also } : {}), sends };
}

/**
 * A share of a record (revision 35): `take` of the quantity its level declares. All of it is the record itself;
 * fewer is a split, the count the new record takes and the count the first keeps, for the host to write in the
 * act's own entry (a new record of the same level under the same parent, carrying every value of the first).
 * None, more than it holds, or a count that is no whole number is refused.
 */
export function shareOf(record: ActRecord, facet: string, take: number): { ok: true; whole: true } | { ok: true; whole: false; taken: string; rest: string } | { ok: false; why: string } {
  const raw = record.values[bare(facet)];
  const have = raw === undefined || raw === null || raw === "" ? 1 : Number(typeof raw === "object" && !Array.isArray(raw) && "$qty" in raw ? raw.$qty : raw);
  if (!Number.isInteger(have) || have < 1) return { ok: false, why: `${record.id} holds no whole quantity to take from` };
  if (!Number.isInteger(take) || take < 1 || take > have) return { ok: false, why: `take 1 to ${have} of ${record.id}` };
  if (take === have) return { ok: true, whole: true };
  return { ok: true, whole: false, taken: String(take), rest: String(have - take) };
}

/**
 * The facets that are marks (12.3, revision 34): those a marked filter names. A host hands them to `actWrites`
 * so a second write to a mark is refused where the act lands.
 */
export function markFacets(filters: Iterable<{ facet: string; marked?: boolean }>): string[] {
  const out = new Set<string>();
  for (const f of filters) if (f.marked) out.add(f.facet);
  return [...out];
}

/** The acts a list of run lines names, each on its record with what it is given, read as the act stands. */
function runsOf(list: ActAlso[] | undefined, i: ActInput): ActRun[] {
  const out: ActRun[] = [];
  for (const x of list ?? []) {
    const perRecord = x.on !== "record" && termsOf(x.when).some((t) => "ref" in t && "found" in t.ref && t.ref.found === x.on);
    if (!perRecord && !whenHolds(x.when, i)) continue;
    for (const rec of x.on === "record" ? [i.record] : (i.found[x.on] ?? [])) {
      const at = x.on === "record" ? i : { ...i, found: { ...i.found, [x.on]: [rec] } };
      if (perRecord && !whenHolds(x.when, at)) continue;
      const given: { [name: string]: Json } = {};
      for (const g of x.with ?? []) {
        const v = "literal" in g.value ? g.value.literal : valueOf(g.value, at);
        if (v !== undefined && v !== null) given[g.name] = v;
      }
      out.push({ ...(x.utility ? { utility: x.utility } : {}), act: x.act, id: rec.id, ...(x.with?.length ? { given } : {}) });
    }
  }
  return out;
}

/** Revision 49: the acts to run before this one lands, each on its record. The host runs them in order, stops
 * the act with the reason of the first that refuses, and reads the act's finds again before it lands. */
export function firstOf(a: Act, i: ActInput): ActRun[] {
  return runsOf(a.first, i);
}

/** The picks of a find or a count resolved for the host to run: a literal, or the referenced value as it stands.
 * A pick's facet may be `<link>.<facet>`, carried as written for the host to hop. */
export function findPicksOf(f: { where: ActPick[] }, i: Omit<ActInput, "found" | "now"> & { found?: ActInput["found"] }): { facet: string; value: Json | undefined }[] {
  const at = { record: i.record, context: i.context, found: i.found ?? {}, ...(i.route ? { route: i.route } : {}) };
  return f.where.map((p) => ({ facet: p.facet.includes("::") ? p.facet.replace(/^\w+::/, "") : p.facet, value: "literal" in p.value ? p.value.literal : "caller" in p.value ? i.caller : "self" in p.value ? i.record.id : valueOf(p.value, at) }));
}

// ─── JSON and text ──────────────────────────────────────────────────────────────

const refJson = (r: ActRef): JsonObject =>
  "given" in r ? { given: r.given } : "record" in r ? { record: r.record } : "context" in r ? { context: r.context, ...(r.facet ? { facet: r.facet } : {}) } : "route" in r ? { route: r.route, column: r.column } : { found: r.found, ...(r.facet ? { facet: r.facet } : {}) };
const refText = (r: ActRef): string =>
  "given" in r ? `given.${r.given}` : "record" in r ? (r.record ? `record.${r.record}` : "record") : "context" in r ? `context.${r.context}${r.facet ? `.${r.facet}` : ""}` : "route" in r ? `${r.route}.${r.column}` : r.facet ? `${r.found}.${r.facet}` : r.found;
const operandJson = (o: ActOperand): JsonObject => ("number" in o ? { number: o.number } : refJson(o));
const sumJson = (x: ActSum): JsonObject => ({ sum: { left: operandJson(x.left), op: x.op, right: operandJson(x.right) } });
const condJson = (c: ActCond): JsonObject => ("has" in c ? { has: refJson(c.has), ...(c.lacks ? { lacks: true } : {}) } : { left: termJson(c.left), op: c.op, right: termJson(c.right) });
export const whenJson = (w: ActWhen): JsonObject => ({ ...condJson(w), ...(w.and?.length ? { and: w.and.map(condJson) } : {}) });
const termJson = (t: ActTerm): JsonObject => ("number" in t ? { number: t.number } : "count" in t ? { count: t.count, ...(t.plus !== undefined ? { plus: t.plus } : {}) } : { ref: refJson(t.ref), ...(t.plus !== undefined ? { plus: t.plus } : {}) });
const termText = (t: ActTerm): string => ("number" in t ? String(t.number) : `${"count" in t ? t.count : refText(t.ref)}${t.plus !== undefined ? ` + ${t.plus}` : ""}`);

/** The quoting the text form needs for a literal (2.5): words with a space, a comma or a colon are quoted. */
const q = (s: string) => (/[\s,:]|^$/.test(s) ? JSON.stringify(s) : s);

const runJson = (x: ActAlso): JsonObject => ({ ...(x.utility ? { utility: x.utility } : {}), act: x.act, on: x.on, ...(x.with?.length ? { with: x.with.map((g): JsonObject => ({ name: g.name, value: "literal" in g.value ? { literal: g.value.literal } : refJson(g.value) })) } : {}), ...(x.when ? { when: whenJson(x.when) } : {}) });
const pickJson = (p: ActPick): JsonObject => ({ facet: p.facet, value: "literal" in p.value ? { literal: p.value.literal } : "caller" in p.value ? { caller: true } : "self" in p.value ? { self: true } : refJson(p.value) });
const thenValueJson = (v: ActThenValue): JsonObject =>
  "literal" in v ? { literal: v.literal } : "now" in v ? { now: true } : "none" in v ? { none: true } : "caller" in v ? { caller: true } : "person" in v ? { person: true } : "link" in v ? { link: v.link } : "sum" in v ? sumJson(v.sum) : refJson(v);
const sourceJson = (s: ActSource): JsonObject =>
  "literal" in s ? { literal: s.literal } : "link" in s ? { link: s.link } : "now" in s ? { now: true } : "caller" in s ? { caller: true } : "person" in s ? { person: true } : "none" in s ? { none: true } : "owner" in s ? { owner: true } : "run" in s ? { run: true } : "sum" in s ? sumJson(s.sum) : "next" in s ? { next: { prefix: "literal" in s.next.prefix ? { literal: s.next.prefix.literal } : refJson(s.next.prefix), in: { kind: s.next.in.kind, facet: s.next.in.facet }, ...(s.next.suffix ? { suffix: refJson(s.next.suffix) } : {}) } } : refJson(s);
const setJson = (s: ActSet): JsonObject => ({ facet: s.facet, source: sourceJson(s.source) });

export function actJson(a: Act): JsonObject {
  return {
    act: a.name,
    version: a.version,
    utility: a.utility,
    ...(a.replaces ? { replaces: a.replaces } : {}),
    ...(a.label ? { label: a.label } : {}),
    ...(a.describe ? { describe: a.describe } : {}),
    on: a.on,
    ...(a.takes ? { takes: a.takes } : {}),
    ...(a.context.length ? { context: [...a.context] } : {}),
    ...(a.needs?.length ? { needs: a.needs.map((n): JsonObject => ({ facet: n.facet, ...(n.lacks ? { lacks: true } : {}), ...(n.is ? { is: { op: n.is.op, value: n.is.value } } : {}), ...(n.words ? { words: n.words } : {}) })) } : {}),
    ...(a.given?.length ? { given: a.given.map((g): JsonObject => ({ name: g.name, facet: g.facet, ...(g.words ? { words: g.words } : {}), ...(g.from ? { from: refJson(g.from) } : {}), ...(g.default !== undefined ? { default: g.default } : {}) })) } : {}),
    ...(a.route
      ? {
          route: {
            name: a.route.name,
            rows: refJson(a.route.rows),
            by: a.route.by,
            over: a.route.over.map(refJson),
            ...(a.route.keep ? { keep: { column: a.route.keep.column, kind: a.route.keep.kind, where: a.route.keep.where.map(pickJson) } } : {}),
          },
        }
      : {}),
    finds: a.finds.map((f) => ({
      name: f.name,
      take: f.take,
      kind: f.kind,
      where: f.where.map(pickJson),
      ...(f.order ? { order: { facet: f.order.facet, dir: f.order.dir } } : {}),
      ...(f.mint ? { mint: { kind: f.mint.kind, sets: f.mint.sets.map(setJson) } } : {}),
    })),
    ...(a.counts.length ? { counts: a.counts.map((k) => ({ name: k.name, kind: k.kind, where: k.where.map(pickJson) })) } : {}),
    sets: a.sets.map(setJson),
    thens: a.thens.map(
      (t): JsonObject => ({
        ...(t.when ? { when: whenJson(t.when) } : {}),
        sets: t.sets.map((s): JsonObject => ({ found: s.found, facet: s.facet, value: thenValueJson(s.value) })),
        ...(t.stand ? { stand: { to: t.stand.to, on: t.stand.on, ...(t.stand.reason ? { reason: t.stand.reason } : {}) } } : {}),
        ...(t.send ? { send: { verb: t.send.verb, words: t.send.words } } : {}),
      }),
    ),
    ...(a.makes?.length ? { makes: a.makes.map((m): JsonObject => ({ name: m.name, kind: m.kind, ...(m.when ? { when: whenJson(m.when) } : {}), sets: m.sets.map(setJson) })) } : {}),
    ...(a.also?.length ? { also: a.also.map(runJson) } : {}),
    ...(a.first?.length ? { first: a.first.map(runJson) } : {}),
    ...(a.send ? { send: { verb: a.send.verb, words: a.send.words } } : {}),
    lands: a.lands,
    ...(a.tells ? { tells: { kind: a.tells.kind, aspect: a.tells.aspect, sets: a.tells.sets.map(setJson) } } : {}),
  };
}

const refOfJson = (o: JsonObject): ActRef =>
  typeof o.given === "string"
    ? { given: o.given }
    : typeof o.record === "string"
    ? { record: o.record }
    : typeof o.context === "string"
      ? { context: o.context, ...(typeof o.facet === "string" ? { facet: o.facet } : {}) }
      : typeof o.route === "string"
        ? { route: o.route, column: String(o.column) }
        : { found: String(o.found), ...(typeof o.facet === "string" ? { facet: o.facet } : {}) };
const termOfJson = (o: JsonObject): ActTerm =>
  typeof o.number === "number" ? { number: o.number } : typeof o.count === "string" ? { count: o.count, ...(typeof o.plus === "number" ? { plus: o.plus } : {}) } : { ref: refOfJson(o.ref as JsonObject), ...(typeof o.plus === "number" ? { plus: o.plus } : {}) };
const pickText = (p: JsonObject): string => {
  const v = p.value as JsonObject;
  // The words `record` and `caller` as literals are printed quoted, so they read back as the words (revision 39).
  return `${p.facet} = ${typeof v.literal === "string" ? (v.literal === "record" || v.literal === "caller" ? JSON.stringify(v.literal) : q(v.literal)) : v.caller === true ? "caller" : v.self === true ? "record" : refText(refOfJson(v))}`;
};
const operandText = (o: JsonObject): string => (typeof o.number === "number" ? String(o.number) : refText(refOfJson(o)));
const sumText = (x: JsonObject): string => `${operandText(x.left as JsonObject)} ${x.op} ${operandText(x.right as JsonObject)}`;
export const whenText = (w: JsonObject): string =>
  [w, ...((w.and as JsonObject[] | undefined) ?? [])].map((c) => c.has && typeof c.has === "object" ? `${c.lacks === true ? "no" : "has"} ${refText(refOfJson(c.has as JsonObject))}` : `${termText(termOfJson(c.left as JsonObject))} ${c.op} ${termText(termOfJson(c.right as JsonObject))}`).join(" and ");
const sourceText = (src: JsonObject): string => {
  if (typeof src.literal === "string") return src.literal === "caller" ? JSON.stringify(src.literal) : q(src.literal);
  if (src.sum && typeof src.sum === "object") return sumText(src.sum as JsonObject);
  if (typeof src.link === "string") return `link ${src.link}`;
  if (src.now === true) return "now";
  if (src.caller === true) return "link caller";
  if (src.person === true) return "caller";
  if (src.none === true) return "none";
  if (src.owner === true) return "owner";
  if (src.run === true) return "run";
  if (src.next && typeof src.next === "object") {
    const n = src.next as JsonObject;
    const into = n.in as JsonObject;
    return `next ${typeof (n.prefix as JsonObject).literal === "string" ? JSON.stringify((n.prefix as JsonObject).literal) : refText(refOfJson(n.prefix as JsonObject))} in ${into.kind}.${into.facet}${n.suffix ? `, ${refText(refOfJson(n.suffix as JsonObject))}` : ""}`;
  }
  return refText(refOfJson(src));
};

/** The text of an act's JSON form, as the bundle prints it back. */
export function actText(a: JsonObject): string[] {
  const out = [`act: ${a.act} /${a.version}`, `  utility: ${a.utility}`];
  if (typeof a.replaces === "string") out.push(`  replaces: ${a.replaces}`);
  if (typeof a.label === "string") out.push(`  label: ${a.label}`);
  if (typeof a.describe === "string") out.push(`  describe: ${a.describe}`);
  out.push(`  on: ${a.on}`);
  if (a.takes === "share") out.push("  takes: share");
  if (Array.isArray(a.context) && a.context.length) out.push(`  context: ${(a.context as string[]).join(", ")}`);
  if (Array.isArray(a.needs) && a.needs.length) {
    out.push("  needs:");
    for (const n of a.needs as JsonObject[]) out.push(`    ${n.lacks === true ? "no " : ""}${n.facet}${n.is && typeof n.is === "object" ? ` ${(n.is as JsonObject).op} ${(n.is as JsonObject).value}` : ""}${typeof n.words === "string" ? ` "${n.words}"` : ""}`);
  }
  if (Array.isArray(a.given) && a.given.length) {
    out.push("  given:");
    for (const g of a.given as JsonObject[]) out.push(`    ${g.name} as ${g.facet}${typeof g.words === "string" ? ` "${g.words}"` : ""}${g.from && typeof g.from === "object" ? ` from ${refText(refOfJson(g.from as JsonObject))}` : typeof g.default === "string" ? ` default ${q(g.default)}` : ""}`);
  }
  if (a.route && typeof a.route === "object") {
    const r = a.route as JsonObject;
    const keep = r.keep as JsonObject | undefined;
    const over = ((r.over as JsonObject[] | undefined) ?? []).map((o) => refText(refOfJson(o))).join(", ");
    out.push("  route:");
    out.push(`    ${r.name} -> row of ${refText(refOfJson(r.rows as JsonObject))} by ${r.by} over ${over}${keep ? ` keep ${keep.column} by ${keep.kind}${((keep.where as JsonObject[] | undefined) ?? []).length ? ` where ${(keep.where as JsonObject[]).map(pickText).join(", ")}` : ""}` : ""}`);
  }
  const finds = (a.finds as JsonObject[] | undefined) ?? [];
  if (finds.length) {
    out.push("  find:");
    for (const f of finds) {
      const where = ((f.where as JsonObject[] | undefined) ?? []).map(pickText);
      const order = f.order as JsonObject | undefined;
      out.push(`    ${f.name} -> ${f.take} ${f.kind}${where.length ? ` where ${where.join(", ")}` : ""}${order ? ` order ${order.facet}${order.dir === "before" ? " before" : ""}` : ""}`);
    }
    const mints = finds.filter((f) => f.mint && typeof f.mint === "object");
    if (mints.length) {
      out.push("  mint:");
      for (const f of mints) {
        const m = f.mint as JsonObject;
        out.push(`    ${f.name} -> ${m.kind} when none`);
        for (const s of (m.sets as JsonObject[] | undefined) ?? []) out.push(`      ${s.facet} -> ${sourceText(s.source as JsonObject)}`);
      }
    }
  }
  const counts = (a.counts as JsonObject[] | undefined) ?? [];
  if (counts.length) {
    out.push("  count:");
    for (const k of counts) {
      const where = ((k.where as JsonObject[] | undefined) ?? []).map(pickText);
      out.push(`    ${k.name} -> ${k.kind}${where.length ? ` where ${where.join(", ")}` : ""}`);
    }
  }
  const sets = (a.sets as JsonObject[] | undefined) ?? [];
  if (sets.length) {
    out.push("  set:");
    for (const s of sets) out.push(`    ${s.facet} -> ${sourceText(s.source as JsonObject)}`);
  }
  const thens = (a.thens as JsonObject[] | undefined) ?? [];
  if (thens.length) {
    out.push("  then:");
    for (const t of thens) {
      const w = t.when as JsonObject | undefined;
      // Revision 25 carried one set as `set`; revision 26 a list as `sets`.
      const one = t.set as JsonObject | undefined;
      const list: JsonObject[] = (t.sets as JsonObject[] | undefined) ?? (one ? [{ found: one.found as string, facet: one.facet as string, value: { literal: String(one.value) } }] : []);
      const words = list.map((s) => {
        const v = s.value as JsonObject;
        return `${s.found}.${s.facet} = ${v.now === true ? "now" : v.none === true ? "none" : v.caller === true ? "link caller" : v.person === true ? "caller" : typeof v.link === "string" ? `link ${v.link}` : v.sum && typeof v.sum === "object" ? sumText(v.sum as JsonObject) : typeof v.literal === "string" ? (/^(now|none|caller)$|^link\s|^[\w-]+\.[\w:.-]+$/.test(v.literal) ? JSON.stringify(v.literal) : q(v.literal)) : refText(refOfJson(v))}`;
      });
      const send = t.send as JsonObject | undefined;
      const stand = t.stand as JsonObject | undefined;
      if (stand) {
        out.push(`    ${w ? `when ${whenText(w)} ` : ""}${stand.to === "archived" ? "archive" : "restore"} ${stand.on}${typeof stand.reason === "string" ? ` as ${stand.reason}` : ""}`);
        continue;
      }
      out.push(`    ${w ? `when ${whenText(w)} ` : ""}set ${words.join(", ")}${send ? ` send ${send.verb}${send.words ? ` ${send.words}` : ""}` : ""}`);
    }
  }
  const makes = (a.makes as JsonObject[] | undefined) ?? [];
  if (makes.length) {
    out.push("  make:");
    for (const m of makes) {
      out.push(`    ${m.name} -> ${m.kind}${m.when && typeof m.when === "object" ? ` when ${whenText(m.when as JsonObject)}` : ""}`);
      for (const s of (m.sets as JsonObject[] | undefined) ?? []) out.push(`      ${s.facet} -> ${sourceText(s.source as JsonObject)}`);
    }
  }
  for (const key of ["first", "also"] as const) {
    const runs = (a[key] as JsonObject[] | undefined) ?? [];
    if (!runs.length) continue;
    out.push(`  ${key}:`);
    for (const x of runs) {
      const gives = ((x.with as JsonObject[] | undefined) ?? []).map((g) => {
        const v = g.value as JsonObject;
        return `${g.name} = ${typeof v.literal === "string" ? (isRef(v.literal) ? JSON.stringify(v.literal) : q(v.literal)) : refText(refOfJson(v))}`;
      });
      out.push(`    ${typeof x.utility === "string" ? `${x.utility}/` : ""}${x.act} on ${x.on}${gives.length ? ` with ${gives.join(", ")}` : ""}${x.when && typeof x.when === "object" ? ` when ${whenText(x.when as JsonObject)}` : ""}`);
    }
  }
  if (a.send && typeof a.send === "object") {
    const s = a.send as JsonObject;
    out.push(`  send: ${s.verb}${s.words ? ` ${s.words}` : ""}`);
  }
  if (a.lands === "reports") out.push("  lands: when the send reports");
  if (a.tells && typeof a.tells === "object") {
    const t = a.tells as JsonObject;
    out.push(`  tells: ${t.kind} as ${t.aspect}`);
    for (const s of (t.sets as JsonObject[] | undefined) ?? []) out.push(`    ${s.facet} -> ${sourceText(s.source as JsonObject)}`);
  }
  return out;
}
