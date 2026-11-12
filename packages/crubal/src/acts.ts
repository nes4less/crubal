// Acts as declarations (chapter 15, revisions 25 and 26): an act a utility provides, said in the package's words.
// What level it acts on, what it holds beside the record (context kinds), the row a route takes through a rack
// of rules on a record, what it finds (named records of a kind by picks and an order) and mints when a find
// comes up empty, what it sets on the record in hand, what it then sets on the records it found when a condition
// holds (and sends then), what it sends through a transport the app provides, and when it counts as landed. The
// engine reads, checks and carries it, and answers each step pure: the row taken, the picks as they stand, the
// values a mint makes, the writes a landing makes; the app runs the finds and counts, makes the mints and the
// writes and the sends, and stamps the lane (12.11) when the act lands.
import { evaluate, parseCondition } from "./conditions.ts";
import type { Json, JsonObject } from "./model.ts";
import { CrubalError, type Node } from "./tree.ts";
import { type Facet, unquote } from "./defs.ts";

/** A reference an act's lines may make: the record in hand's facet, a context record (or its facet), a found
 * record's facet, or the route's row's column. */
export type ActRef =
  | { record: string }
  | { context: string; facet?: string }
  | { found: string; facet?: string }
  | { route: string; column: string };

/** What a pick in a find compares a facet with: a literal, or a reference. */
export type ActPickValue = { literal: string } | { caller: true } | { self: true } | ActRef;

export type ActPick = { facet: string; value: ActPickValue; line: number };

/** The next label in a series (revision 26): the prefix, one more than the highest number the kind's facet
 * carries after it, three digits, the suffix when given. */
export type ActSeries = { prefix: ActRef | { literal: string }; in: { kind: string; facet: string }; suffix?: ActRef };

/** What a set writes: a literal, a link to a found or context record, a reference's value, the moment, or the
 * next in a series. */
export type ActSource = { literal: string } | { link: string } | { now: true } | { caller: true } | { none: true } | { owner: true } | { run: true } | { next: ActSeries } | ActRef;

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
export type ActThenValue = { literal: string } | { now: true } | { none: true } | { link: string } | { caller: true } | ActRef;
export type ActThenSet = { found: string; facet: string; value: ActThenValue };
export type ActThen = {
  /** Absent (revision 39): the writes are made whenever the act lands. */
  when?: { left: ActTerm; op: "=" | "<" | ">" | "<=" | ">="; right: ActTerm };
  sets: ActThenSet[];
  /** Revision 26: a send run only when the condition held. */
  send?: { verb: string; words: string };
  line: number;
};

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
  route?: ActRoute;
  finds: ActFind[];
  counts: ActCount[];
  sets: ActSet[];
  thens: ActThen[];
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

/** `filedIn -> link box`, `filedBox -> box.containerLabel`, `filedAt -> now`, `note -> "words"`,
 * `containerLabel -> next slot.boxPrefix in container.containerLabel, slot.boxSuffix` */
function readSet(text: string, line: number, routes: Set<string>): ActSet {
  const m = text.match(/^([\w:]+)\s*->\s*(.+)$/);
  if (!m) throw new CrubalError(`a set is "<facet> -> <source>": ${text}`, line);
  const facet = m[1] as string;
  const src = (m[2] as string).trim();
  if (src === "link caller") return { facet, source: { caller: true }, line };
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

/** `when box.containerCount + 1 >= box.capacity set box.containerState = full, box.filledAt = now send notify containerFull about context.station` */
function readThen(text: string, line: number, routes: Set<string>, counts: Set<string>): ActThen {
  // Revision 39: the condition may be left out (`set box.containerState = open`).
  const m = text.match(/^(?:when\s+(.+?)\s*(<=|>=|=|<|>)\s*(.+?)\s+)?set\s+(.+?)(?:\s+send\s+([a-z][\w-]*)(?:\s+(.*))?)?$/);
  if (!m) throw new CrubalError(`a then is "[when <term> <op> <term>] set <found>.<facet> = <value>[, …] [send <verb> <words>]": ${text}`, line);
  const sets = (m[4] as string)
    .split(/,\s*(?=[\w-]+\.\w+\s*=)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): ActThenSet => {
      const sm = s.match(/^([\w-]+)\.(\w+)\s*=\s*(.+)$/);
      if (!sm) throw new CrubalError(`a then's set is "<found>.<facet> = <value>": ${s}`, line);
      const v = (sm[3] as string).trim();
      const link = v.match(/^link\s+([\w-]+)$/);
      const value: ActThenValue = v === "now" ? { now: true } : v === "none" ? { none: true } : link ? (link[1] === "caller" ? { caller: true } : { link: link[1] as string }) : isRef(v) ? readRef(v, line, "a then", routes) : { literal: unquote(v) };
      return { found: sm[1] as string, facet: sm[2] as string, value };
    });
  return {
    ...(m[1] !== undefined ? { when: { left: readTerm((m[1] as string).trim(), line, routes, counts), op: m[2] as NonNullable<ActThen["when"]>["op"], right: readTerm((m[3] as string).trim(), line, routes, counts) } } : {}),
    sets,
    ...(m[5] ? { send: { verb: m[5], words: (m[6] ?? "").trim() } } : {}),
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
    } else throw new CrubalError(`an act has utility, replaces, label, describe, on, takes, context, route, find, mint, count, set, then, send, lands and tells, not ${c.key}`, c.line);
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
    const refOk = (r: ActRef, line: number, inCount = false) => {
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
    if (a.route) {
      const r = a.route;
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
    const sourceOk = (s: ActSet, doing: string) => {
      needFacet(s.facet, s.line, doing);
      const src = s.source;
      if ("link" in src) {
        if (src.link !== "record" && !found.has(src.link) && !a.context.includes(src.link)) throw new CrubalError(`${where} links ${s.facet} to ${src.link}, which no find or context declares`, s.line);
      } else if ("next" in src) {
        if (!("literal" in src.next.prefix)) refOk(src.next.prefix, s.line);
        if (src.next.suffix) refOk(src.next.suffix, s.line);
        if (!env.kinds.has(src.next.in.kind) && !env.levels.has(src.next.in.kind) && strict) throw new CrubalError(`${where} numbers ${s.facet} in ${src.next.in.kind}, which isn't a kind ${here}`, s.line);
        needFacet(src.next.in.facet, s.line, "numbers by");
      } else if (!("literal" in src) && !("now" in src) && !("caller" in src) && !("none" in src) && !("owner" in src) && !("run" in src)) refOk(src, s.line);
    };
    for (const f of a.finds) {
      if (found.has(f.name)) throw new CrubalError(`${where} finds ${f.name} twice`, f.line);
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
    for (const t of a.thens) {
      for (const term of t.when ? [t.when.left, t.when.right] : []) {
        if ("ref" in term) refOk(term.ref, t.line);
        if ("count" in term && !counted.has(term.count)) throw new CrubalError(`${where} reads ${term.count}, which no count declares`, t.line);
      }
      for (const s of t.sets) {
        if (!found.has(s.found)) throw new CrubalError(`${where} then sets ${s.found}, which no find declares`, t.line);
        needFacet(s.facet, t.line, "then sets");
        const v = s.value;
        if ("link" in v) {
          if (v.link !== "record" && !found.has(v.link) && !a.context.includes(v.link)) throw new CrubalError(`${where} then links ${s.found}.${s.facet} to ${v.link}, which no find or context declares`, t.line);
        } else if (!("literal" in v) && !("now" in v) && !("none" in v) && !("caller" in v)) refOk(v, t.line);
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
      sends: { verb: string; words: string }[];
    }
  | { ok: false; why: string };

/** A record's facet, or its parent's id for `of`. */
const facetOf = (rec: ActRecord | undefined, facet: string): Json | undefined => {
  if (!rec) return undefined;
  const f = bare(facet);
  return f === PARENT ? (rec.of ?? rec.values[f]) : rec.values[f];
};

const valueOf = (r: ActRef, i: Pick<ActInput, "record" | "context" | "found" | "route">): Json | undefined => {
  if ("record" in r) return facetOf(i.record, r.record);
  if ("context" in r) return r.facet ? facetOf(i.context[r.context], r.facet) : i.context[r.context]?.id;
  if ("route" in r) return i.route?.row[r.column];
  return r.facet ? facetOf(i.found[r.found]?.[0], r.facet) : i.found[r.found]?.[0]?.id;
};

const numberOf = (t: ActTerm, i: ActInput): number | undefined => {
  if ("number" in t) return t.number;
  if ("count" in t) {
    const c = i.counts?.[t.count];
    return c === undefined ? undefined : c + (t.plus ?? 0);
  }
  const v = valueOf(t.ref, i);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n + (t.plus ?? 0) : undefined;
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
    if (!id) return { ok: false, why: `nothing to link ${s.facet} to: ${src.link}` };
    return { ok: true, value: { $link: id } };
  }
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

/** The writes an act makes when it lands (15): pure, given what the finds answered or minted. A `first` find
 * that answered nothing stops the act with the reason, before any write. */
export function actWrites(a: Act, i: ActInput): ActWrites {
  for (const f of a.finds) if (f.take === "first" && !i.found[f.name]?.length) return { ok: false, why: `no ${f.kind} for ${f.name}` };
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
  const sends: { verb: string; words: string }[] = [];
  for (const t of a.thens) {
    if (t.when) {
      const l = numberOf(t.when.left, i);
      const r = numberOf(t.when.right, i);
      if (l === undefined || r === undefined) continue;
      const holds = t.when.op === "=" ? l === r : t.when.op === "<" ? l < r : t.when.op === ">" ? l > r : t.when.op === "<=" ? l <= r : l >= r;
      if (!holds) continue;
    }
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
      } else if ("link" in v) {
        const id = v.link === "record" ? i.record.id : (i.found[v.link]?.[0]?.id ?? i.context[v.link]?.id);
        if (!id) return { ok: false, why: `nothing to link ${s.found}.${s.facet} to: ${v.link}` };
        value = { $link: id };
      } else value = valueOf(v, i);
      const k = bare(s.facet);
      for (const rec of i.found[s.found] ?? []) {
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
    if (t.send) sends.push({ ...t.send });
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
  return { ok: true, record, clear, then, sends };
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

/** The picks of a find or a count resolved for the host to run: a literal, or the referenced value as it stands.
 * A pick's facet may be `<link>.<facet>`, carried as written for the host to hop. */
export function findPicksOf(f: { where: ActPick[] }, i: Omit<ActInput, "found" | "now"> & { found?: ActInput["found"] }): { facet: string; value: Json | undefined }[] {
  const at = { record: i.record, context: i.context, found: i.found ?? {}, ...(i.route ? { route: i.route } : {}) };
  return f.where.map((p) => ({ facet: p.facet.includes("::") ? p.facet.replace(/^\w+::/, "") : p.facet, value: "literal" in p.value ? p.value.literal : "caller" in p.value ? i.caller : "self" in p.value ? i.record.id : valueOf(p.value, at) }));
}

// ─── JSON and text ──────────────────────────────────────────────────────────────

const refJson = (r: ActRef): JsonObject =>
  "record" in r ? { record: r.record } : "context" in r ? { context: r.context, ...(r.facet ? { facet: r.facet } : {}) } : "route" in r ? { route: r.route, column: r.column } : { found: r.found, ...(r.facet ? { facet: r.facet } : {}) };
const refText = (r: ActRef): string =>
  "record" in r ? (r.record ? `record.${r.record}` : "record") : "context" in r ? `context.${r.context}${r.facet ? `.${r.facet}` : ""}` : "route" in r ? `${r.route}.${r.column}` : r.facet ? `${r.found}.${r.facet}` : r.found;
const termJson = (t: ActTerm): JsonObject => ("number" in t ? { number: t.number } : "count" in t ? { count: t.count, ...(t.plus !== undefined ? { plus: t.plus } : {}) } : { ref: refJson(t.ref), ...(t.plus !== undefined ? { plus: t.plus } : {}) });
const termText = (t: ActTerm): string => ("number" in t ? String(t.number) : `${"count" in t ? t.count : refText(t.ref)}${t.plus !== undefined ? ` + ${t.plus}` : ""}`);

/** The quoting the text form needs for a literal (2.5): words with a space, a comma or a colon are quoted. */
const q = (s: string) => (/[\s,:]|^$/.test(s) ? JSON.stringify(s) : s);

const pickJson = (p: ActPick): JsonObject => ({ facet: p.facet, value: "literal" in p.value ? { literal: p.value.literal } : "caller" in p.value ? { caller: true } : "self" in p.value ? { self: true } : refJson(p.value) });
const thenValueJson = (v: ActThenValue): JsonObject =>
  "literal" in v ? { literal: v.literal } : "now" in v ? { now: true } : "none" in v ? { none: true } : "caller" in v ? { caller: true } : "link" in v ? { link: v.link } : refJson(v);
const sourceJson = (s: ActSource): JsonObject =>
  "literal" in s ? { literal: s.literal } : "link" in s ? { link: s.link } : "now" in s ? { now: true } : "caller" in s ? { caller: true } : "none" in s ? { none: true } : "owner" in s ? { owner: true } : "run" in s ? { run: true } : "next" in s ? { next: { prefix: "literal" in s.next.prefix ? { literal: s.next.prefix.literal } : refJson(s.next.prefix), in: { kind: s.next.in.kind, facet: s.next.in.facet }, ...(s.next.suffix ? { suffix: refJson(s.next.suffix) } : {}) } } : refJson(s);
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
        ...(t.when ? { when: { left: termJson(t.when.left), op: t.when.op, right: termJson(t.when.right) } } : {}),
        sets: t.sets.map((s): JsonObject => ({ found: s.found, facet: s.facet, value: thenValueJson(s.value) })),
        ...(t.send ? { send: { verb: t.send.verb, words: t.send.words } } : {}),
      }),
    ),
    ...(a.send ? { send: { verb: a.send.verb, words: a.send.words } } : {}),
    lands: a.lands,
    ...(a.tells ? { tells: { kind: a.tells.kind, aspect: a.tells.aspect, sets: a.tells.sets.map(setJson) } } : {}),
  };
}

const refOfJson = (o: JsonObject): ActRef =>
  typeof o.record === "string"
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
const sourceText = (src: JsonObject): string => {
  if (typeof src.literal === "string") return q(src.literal);
  if (typeof src.link === "string") return `link ${src.link}`;
  if (src.now === true) return "now";
  if (src.caller === true) return "link caller";
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
        return `${s.found}.${s.facet} = ${v.now === true ? "now" : v.none === true ? "none" : v.caller === true ? "link caller" : typeof v.link === "string" ? `link ${v.link}` : typeof v.literal === "string" ? (/^(now|none)$|^link\s|^[\w-]+\.[\w:.-]+$/.test(v.literal) ? JSON.stringify(v.literal) : q(v.literal)) : refText(refOfJson(v))}`;
      });
      const send = t.send as JsonObject | undefined;
      out.push(`    ${w ? `when ${termText(termOfJson(w.left as JsonObject))} ${w.op} ${termText(termOfJson(w.right as JsonObject))} ` : ""}set ${words.join(", ")}${send ? ` send ${send.verb}${send.words ? ` ${send.words}` : ""}` : ""}`);
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
