// Acts as declarations (chapter 15, revision 25): an act a utility provides, said in the package's words. What
// level it acts on, what it holds beside the record (context kinds), what it finds (named records of a kind by
// picks and an order), what it sets on the record in hand, what it then sets on the records it found when a
// condition holds, what it sends through a transport the app provides, and when it counts as landed. The engine
// reads, checks and carries it, and answers the writes a landing makes given the records the finds answered;
// the app runs the finds, makes the writes and the send, and stamps the lane (12.11) when the act lands.
import type { Json, JsonObject } from "./model.ts";
import { CrubalError, type Node } from "./tree.ts";
import { unquote } from "./defs.ts";

/** A reference an act's lines may make: the record in hand's facet, a context record, a found record's facet. */
export type ActRef =
  | { record: string }
  | { context: string }
  | { found: string; facet: string };

/** What a pick in a find compares a facet with: a literal, or a reference. */
export type ActPickValue = { literal: string } | ActRef;

export type ActFind = {
  name: string;
  take: "first" | "all";
  kind: string;
  where: { facet: string; value: ActPickValue; line: number }[];
  order?: { facet: string; dir: "after" | "before" };
  line: number;
};

/** What a set writes: a literal, a link to a found or context record, a reference's value, or the moment. */
export type ActSource = { literal: string } | { link: string } | { now: true } | ActRef;

export type ActSet = { facet: string; source: ActSource; line: number };

/** A term of a `when`: a reference, with an optional number added, or a number. */
export type ActTerm = { ref: ActRef; plus?: number } | { number: number };
export type ActThen = {
  when: { left: ActTerm; op: "=" | "<" | ">" | "<=" | ">="; right: ActTerm };
  set: { found: string; facet: string; value: string };
  line: number;
};

export type Act = {
  name: string;
  version: string;
  utility: string;
  label?: string;
  describe?: string;
  on: string;
  context: string[];
  finds: ActFind[];
  sets: ActSet[];
  thens: ActThen[];
  /** A transport verb the app provides and the words after it, carried unchanged. */
  send?: { verb: string; words: string };
  /** When the act counts as landed: at once, or when its send reports. */
  lands: "now" | "reports";
  line: number;
};

const WORD = /^[a-z][\w-]*$/;
const FACET = /^(?:\w+::)?\w+$/;

function readRef(t: string, line: number, what: string): ActRef {
  const m = t.match(/^(record|context)\.([\w:]+)$/) ?? t.match(/^([\w-]+)\.(\w+)$/);
  if (!m) throw new CrubalError(`${what}: ${t} is not record.<facet>, context.<kind> or <found>.<facet>`, line);
  if (m[1] === "record") return { record: m[2] as string };
  if (m[1] === "context") return { context: m[2] as string };
  return { found: m[1] as string, facet: m[2] as string };
}

const isRef = (t: string) => /^(record|context|[\w-]+)\.[\w:]+$/.test(t);

function readPickValue(t: string, line: number): ActPickValue {
  return isRef(t) ? readRef(t, line, "a pick") : { literal: unquote(t) };
}

/** `box -> first container where containerState = open, containerStation = context.station order containerLabel` */
function readFind(text: string, line: number): ActFind {
  const m = text.match(/^([\w-]+)\s*->\s*(first|all)\s+([\w-]+)(?:\s+where\s+(.*?))?(?:\s+order\s+([\w:]+)(?:\s+(after|before))?)?$/);
  if (!m) throw new CrubalError(`a find is "<name> -> first|all <kind> [where <facet> = <value>, …] [order <facet> [after|before]]": ${text}`, line);
  const where = (m[4] ?? "")
    .split(/,\s*(?=[\w:]+\s*=)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => {
      const pm = p.match(/^([\w:]+)\s*=\s*(.+)$/);
      if (!pm) throw new CrubalError(`a pick is "<facet> = <value>": ${p}`, line);
      return { facet: pm[1] as string, value: readPickValue((pm[2] as string).trim(), line), line };
    });
  return { name: m[1] as string, take: m[2] as "first" | "all", kind: m[3] as string, where, ...(m[5] ? { order: { facet: m[5], dir: (m[6] as "after" | "before" | undefined) ?? "after" } } : {}), line };
}

/** `filedIn -> link box`, `filedBox -> box.containerLabel`, `filedAt -> now`, `note -> "words"` */
function readSet(text: string, line: number): ActSet {
  const m = text.match(/^([\w:]+)\s*->\s*(.+)$/);
  if (!m) throw new CrubalError(`a set is "<facet> -> <source>": ${text}`, line);
  const facet = m[1] as string;
  const src = (m[2] as string).trim();
  const link = src.match(/^link\s+([\w-]+)$/);
  if (link) return { facet, source: { link: link[1] as string }, line };
  if (src === "now") return { facet, source: { now: true }, line };
  if (isRef(src)) return { facet, source: readRef(src, line, "a set"), line };
  return { facet, source: { literal: unquote(src) }, line };
}

function readTerm(t: string, line: number): ActTerm {
  const n = Number(t);
  if (t !== "" && Number.isFinite(n)) return { number: n };
  const m = t.match(/^(.+?)\s*\+\s*(\d+(?:\.\d+)?)$/);
  if (m) return { ref: readRef((m[1] as string).trim(), line, "a when"), plus: Number(m[2]) };
  return { ref: readRef(t, line, "a when") };
}

/** `when box.containerCount + 1 >= box.containerCapacity set box.containerState = full` */
function readThen(text: string, line: number): ActThen {
  const m = text.match(/^when\s+(.+?)\s*(<=|>=|=|<|>)\s*(.+?)\s+set\s+([\w-]+)\.(\w+)\s*=\s*(.+)$/);
  if (!m) throw new CrubalError(`a then is "when <term> <op> <term> set <found>.<facet> = <value>": ${text}`, line);
  return {
    when: { left: readTerm((m[1] as string).trim(), line), op: m[2] as ActThen["when"]["op"], right: readTerm((m[3] as string).trim(), line) },
    set: { found: m[4] as string, facet: m[5] as string, value: unquote((m[6] as string).trim()) },
    line,
  };
}

/** Read one `act:` block (15). */
export function readAct(node: Node): Act {
  const [name = "", version = ""] = node.value.split(/\s+\//).map((s) => s.trim());
  if (!WORD.test(name)) throw new CrubalError(`an act is "act: <name> /<version>", the name a lower-case word: ${node.value}`, node.line);
  const a: Act = { name, version, utility: "", on: "", context: [], finds: [], sets: [], thens: [], lands: "now", line: node.line };
  for (const c of node.children) {
    if (!c.key) continue;
    const v = c.value.trim();
    if (c.key === "utility") a.utility = v;
    else if (c.key === "label") a.label = unquote(v);
    else if (c.key === "describe") a.describe = unquote(v);
    else if (c.key === "on") a.on = v;
    else if (c.key === "context") {
      a.context = v.split(",").map((s) => s.trim()).filter(Boolean);
      for (const k of a.context) if (!WORD.test(k)) throw new CrubalError(`context names kinds, lower-case words: ${k}`, c.line);
    } else if (c.key === "find") for (const l of c.children) { if (l.text.trim()) a.finds.push(readFind(l.text.trim(), l.line)); }
    else if (c.key === "set") for (const l of c.children) { if (l.text.trim()) a.sets.push(readSet(l.text.trim(), l.line)); }
    else if (c.key === "then") for (const l of c.children) { if (l.text.trim()) a.thens.push(readThen(l.text.trim(), l.line)); }
    else if (c.key === "send") {
      const m = v.match(/^([a-z][\w-]*)(?:\s+(.*))?$/);
      if (!m) throw new CrubalError(`a send is "<verb> <words>": ${v}`, c.line);
      a.send = { verb: m[1] as string, words: (m[2] ?? "").trim() };
    } else if (c.key === "lands") {
      if (v === "now") a.lands = "now";
      else if (/^when the send reports$/.test(v)) a.lands = "reports";
      else throw new CrubalError(`lands is "now" or "when the send reports", not ${v}`, c.line);
    } else throw new CrubalError(`an act has utility, label, describe, on, context, find, set, then, send and lands, not ${c.key}`, c.line);
  }
  if (!a.utility) throw new CrubalError(`the act ${name} names no utility`, node.line);
  if (!a.on) throw new CrubalError(`the act ${name} says no on: the level it acts on`, node.line);
  if (a.lands === "reports" && !a.send) throw new CrubalError(`the act ${name} lands when the send reports, but sends nothing`, node.line);
  return a;
}

/** What an act's checks read; `strict` at publish for a package extending nothing, and in force at install. */
export type ActEnv = {
  utilities: { name: string; acts: { name: string }[] }[];
  levels: Set<string>;
  kinds: Set<string>;
  facets: Set<string>;
  strict: boolean;
  here: string;
};

const bare = (facet: string) => facet.replace(/^\w+::/, "");

/** The checks (15): the utility declares the act among its acts; `on` a level; the context kinds; finds over kinds
 * by facets; sets to facets; references to declared finds; a `then` setting a found record. */
export function checkActList(acts: Act[], env: ActEnv): void {
  const { strict, here } = env;
  for (const a of acts) {
    const where = `the act ${a.name}`;
    const u = env.utilities.find((x) => x.name === a.utility);
    if (!u && strict) throw new CrubalError(`${where} names the utility ${a.utility}, which isn't ${here}`, a.line);
    if (u && !u.acts.some((x) => x.name === a.name)) throw new CrubalError(`${where} isn't among ${a.utility}'s acts`, a.line);
    if (!env.levels.has(a.on) && strict) throw new CrubalError(`${where} is on ${a.on}, which isn't a level ${here}`, a.line);
    for (const k of a.context) if (!env.kinds.has(k) && !env.levels.has(k) && strict) throw new CrubalError(`${where}'s context names ${k}, which isn't a kind ${here}`, a.line);
    const found = new Set<string>();
    const refOk = (r: ActRef, line: number) => {
      if ("found" in r && !found.has(r.found)) throw new CrubalError(`${where} names ${r.found}, which no find declares`, line);
      if ("context" in r && !a.context.includes(r.context)) throw new CrubalError(`${where} names context.${r.context}, which its context lacks`, line);
      const facet = "found" in r ? r.facet : "record" in r ? r.record : undefined;
      if (facet && !env.facets.has(bare(facet)) && strict) throw new CrubalError(`${where} reads ${facet}, which isn't a facet ${here}`, line);
    };
    for (const f of a.finds) {
      if (found.has(f.name)) throw new CrubalError(`${where} finds ${f.name} twice`, f.line);
      if (!env.kinds.has(f.kind) && !env.levels.has(f.kind) && strict) throw new CrubalError(`${where} finds ${f.kind}, which isn't a kind ${here}`, f.line);
      for (const p of f.where) {
        if (!env.facets.has(bare(p.facet)) && strict) throw new CrubalError(`${where}'s find ${f.name} picks ${p.facet}, which isn't a facet ${here}`, p.line);
        if (!("literal" in p.value)) refOk(p.value, p.line);
      }
      if (f.order && !env.facets.has(bare(f.order.facet)) && strict) throw new CrubalError(`${where}'s find ${f.name} orders by ${f.order.facet}, which isn't a facet ${here}`, f.line);
      found.add(f.name);
    }
    const sets = new Set<string>();
    for (const s of a.sets) {
      if (!env.facets.has(bare(s.facet)) && strict) throw new CrubalError(`${where} sets ${s.facet}, which isn't a facet ${here}`, s.line);
      if (sets.has(s.facet)) throw new CrubalError(`${where} sets ${s.facet} twice`, s.line);
      sets.add(s.facet);
      if ("link" in s.source && !found.has(s.source.link) && !a.context.includes(s.source.link)) throw new CrubalError(`${where} links ${s.facet} to ${s.source.link}, which no find or context declares`, s.line);
      if (!("link" in s.source) && !("literal" in s.source) && !("now" in s.source)) refOk(s.source, s.line);
    }
    for (const t of a.thens) {
      for (const term of [t.when.left, t.when.right]) if ("ref" in term) refOk(term.ref, t.line);
      if (!found.has(t.set.found)) throw new CrubalError(`${where} then sets ${t.set.found}, which no find declares`, t.line);
      if (!env.facets.has(bare(t.set.facet)) && strict) throw new CrubalError(`${where} then sets ${t.set.facet}, which isn't a facet ${here}`, t.line);
    }
  }
}

// ─── The writes a landing makes ───────────────────────────────────────────────

export type ActRecord = { id: string; values: JsonObject };

export type ActInput = {
  record: ActRecord;
  /** The context records, by kind. */
  context: { [kind: string]: ActRecord };
  /** What each find answered, by name: one or more records; a `first` find answered takes the first. */
  found: { [name: string]: ActRecord[] };
  /** The moment, as the host stamps it. */
  now: string;
};

export type ActWrites =
  | { ok: true; record: JsonObject; then: { id: string; values: JsonObject }[] }
  | { ok: false; why: string };

const valueOf = (r: ActRef, i: ActInput): Json | undefined => {
  if ("record" in r) return i.record.values[bare(r.record)];
  if ("context" in r) return i.context[r.context]?.id;
  return i.found[r.found]?.[0]?.values[bare(r.facet)];
};

const numberOf = (t: ActTerm, i: ActInput): number | undefined => {
  if ("number" in t) return t.number;
  const v = valueOf(t.ref, i);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n + (t.plus ?? 0) : undefined;
};

/** The writes an act makes when it lands (15): pure, given what the finds answered. A `first` find that answered
 * nothing stops the act with the reason, before any write. */
export function actWrites(a: Act, i: ActInput): ActWrites {
  for (const f of a.finds) if (f.take === "first" && !i.found[f.name]?.length) return { ok: false, why: `no ${f.kind} for ${f.name}` };
  const record: JsonObject = {};
  for (const s of a.sets) {
    const src = s.source;
    if ("literal" in src) record[bare(s.facet)] = src.literal;
    else if ("now" in src) record[bare(s.facet)] = i.now;
    else if ("link" in src) {
      const id = i.found[src.link]?.[0]?.id ?? i.context[src.link]?.id;
      if (!id) return { ok: false, why: `nothing to link ${s.facet} to: ${src.link}` };
      record[bare(s.facet)] = { $link: id };
    } else {
      const v = valueOf(src, i);
      if (v !== undefined) record[bare(s.facet)] = v;
    }
  }
  const then: { id: string; values: JsonObject }[] = [];
  for (const t of a.thens) {
    const l = numberOf(t.when.left, i);
    const r = numberOf(t.when.right, i);
    if (l === undefined || r === undefined) continue;
    const holds = t.when.op === "=" ? l === r : t.when.op === "<" ? l < r : t.when.op === ">" ? l > r : t.when.op === "<=" ? l <= r : l >= r;
    if (!holds) continue;
    for (const rec of i.found[t.set.found] ?? []) {
      const have = then.find((x) => x.id === rec.id);
      if (have) have.values[bare(t.set.facet)] = t.set.value;
      else then.push({ id: rec.id, values: { [bare(t.set.facet)]: t.set.value } });
    }
  }
  return { ok: true, record, then };
}

/** The picks of a find resolved for the host to run: a literal, or the referenced value as it stands. */
export function findPicksOf(f: ActFind, i: Omit<ActInput, "found" | "now"> & { found?: ActInput["found"] }): { facet: string; value: Json | undefined }[] {
  const full: ActInput = { ...i, found: i.found ?? {}, now: "" };
  return f.where.map((p) => ({ facet: bare(p.facet), value: "literal" in p.value ? p.value.literal : valueOf(p.value, full) }));
}

// ─── JSON and text ──────────────────────────────────────────────────────────────

const refJson = (r: ActRef): JsonObject => ("record" in r ? { record: r.record } : "context" in r ? { context: r.context } : { found: r.found, facet: r.facet });
const refText = (r: ActRef): string => ("record" in r ? `record.${r.record}` : "context" in r ? `context.${r.context}` : `${r.found}.${r.facet}`);
const termJson = (t: ActTerm): JsonObject => ("number" in t ? { number: t.number } : { ref: refJson(t.ref), ...(t.plus !== undefined ? { plus: t.plus } : {}) });
const termText = (t: ActTerm): string => ("number" in t ? String(t.number) : `${refText(t.ref)}${t.plus !== undefined ? ` + ${t.plus}` : ""}`);

/** The quoting the text form needs for a literal (2.5): words with a space, a comma or a colon are quoted. */
const q = (s: string) => (/[\s,:]|^$/.test(s) ? JSON.stringify(s) : s);

export function actJson(a: Act): JsonObject {
  return {
    act: a.name,
    version: a.version,
    utility: a.utility,
    ...(a.label ? { label: a.label } : {}),
    ...(a.describe ? { describe: a.describe } : {}),
    on: a.on,
    ...(a.context.length ? { context: [...a.context] } : {}),
    finds: a.finds.map((f) => ({ name: f.name, take: f.take, kind: f.kind, where: f.where.map((p) => ({ facet: p.facet, value: "literal" in p.value ? { literal: p.value.literal } : refJson(p.value) })), ...(f.order ? { order: { facet: f.order.facet, dir: f.order.dir } } : {}) })),
    sets: a.sets.map((s) => ({ facet: s.facet, source: "literal" in s.source ? { literal: s.source.literal } : "link" in s.source ? { link: s.source.link } : "now" in s.source ? { now: true } : refJson(s.source) })),
    thens: a.thens.map((t) => ({ when: { left: termJson(t.when.left), op: t.when.op, right: termJson(t.when.right) }, set: { ...t.set } })),
    ...(a.send ? { send: { verb: a.send.verb, words: a.send.words } } : {}),
    lands: a.lands,
  };
}

const refOfJson = (o: JsonObject): ActRef => (typeof o.record === "string" ? { record: o.record } : typeof o.context === "string" ? { context: o.context } : { found: String(o.found), facet: String(o.facet) });
const termOfJson = (o: JsonObject): ActTerm => (typeof o.number === "number" ? { number: o.number } : { ref: refOfJson(o.ref as JsonObject), ...(typeof o.plus === "number" ? { plus: o.plus } : {}) });

/** The text of an act's JSON form, as the bundle prints it back. */
export function actText(a: JsonObject): string[] {
  const out = [`act: ${a.act} /${a.version}`, `  utility: ${a.utility}`];
  if (typeof a.label === "string") out.push(`  label: ${a.label}`);
  if (typeof a.describe === "string") out.push(`  describe: ${a.describe}`);
  out.push(`  on: ${a.on}`);
  if (Array.isArray(a.context) && a.context.length) out.push(`  context: ${(a.context as string[]).join(", ")}`);
  const finds = (a.finds as JsonObject[] | undefined) ?? [];
  if (finds.length) {
    out.push("  find:");
    for (const f of finds) {
      const where = ((f.where as JsonObject[] | undefined) ?? []).map((p) => {
        const v = p.value as JsonObject;
        return `${p.facet} = ${typeof v.literal === "string" ? q(v.literal) : refText(refOfJson(v))}`;
      });
      const order = f.order as JsonObject | undefined;
      out.push(`    ${f.name} -> ${f.take} ${f.kind}${where.length ? ` where ${where.join(", ")}` : ""}${order ? ` order ${order.facet}${order.dir === "before" ? " before" : ""}` : ""}`);
    }
  }
  const sets = (a.sets as JsonObject[] | undefined) ?? [];
  if (sets.length) {
    out.push("  set:");
    for (const s of sets) {
      const src = s.source as JsonObject;
      const words = typeof src.literal === "string" ? q(src.literal) : typeof src.link === "string" ? `link ${src.link}` : src.now === true ? "now" : refText(refOfJson(src));
      out.push(`    ${s.facet} -> ${words}`);
    }
  }
  const thens = (a.thens as JsonObject[] | undefined) ?? [];
  if (thens.length) {
    out.push("  then:");
    for (const t of thens) {
      const w = t.when as JsonObject;
      const s = t.set as JsonObject;
      out.push(`    when ${termText(termOfJson(w.left as JsonObject))} ${w.op} ${termText(termOfJson(w.right as JsonObject))} set ${s.found}.${s.facet} = ${q(String(s.value))}`);
    }
  }
  if (a.send && typeof a.send === "object") {
    const s = a.send as JsonObject;
    out.push(`  send: ${s.verb}${s.words ? ` ${s.words}` : ""}`);
  }
  if (a.lands === "reports") out.push("  lands: when the send reports");
  return out;
}
