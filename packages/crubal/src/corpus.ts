// corpus.ts: runs the conformance corpus (spec chapter 13). A Reader passes a case when reading the input
// gives the expected canonical JSON, printing that and reading it back gives the same, and printing the
// expected JSON reads back to the same. An error case passes when the input is refused at the given line.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./canonical.ts";
import { type Dictionary, emptyDictionary, readDefinitions, splitCaseInput } from "./defs.ts";
import { type Keys, land, matchParts, proposeSplit, rawOf, readContracts, receive, replay, reviewByKey, validate, verifyChain, type IntakeOutcome, type IntakeRecord, type Observation } from "./store.ts";
import { checkRecipe, dryRun, readRecipes, restamp } from "./migrate.ts";
import { checkContracts, Exchange, readRoles, verifyBorder } from "./exchange.ts";
import { checkPackages } from "./packages.ts";
import { checkViews, readViews, Views } from "./views.ts";
import { formOf } from "./forms.ts";
import { Journal, rebuild, redactable, redactableWrite, stateJson } from "./log.ts";
import { decide as decideReview } from "./review.ts";
import { resetUnits } from "./units.ts";
import { arrive, decide, type Arrival, type ArrivalStore } from "./arrival.ts";
import { adopt, apply as applyInstructions, archive, attach, clone, detach, emptyStore, giveBack, issue, merge, split, unarchive } from "./lifecycle.ts";
import { Access, checkPermissions, readAccess } from "./access.ts";
import { readPiece } from "./lex.ts";
import { readUnder } from "./read-text.ts";
import { readTree } from "./tree.ts";
import type { Record as Rec } from "./model.ts";
import { MemoryRecords } from "./records.ts";
import { checkRules, Engine, readRules, type Result, type Rule } from "./rules.ts";
import { checkPackage, checkRecord, facetJson, foldRecord, type Outcome, resolve, resolvedJson } from "./dictionary.ts";
import type { Facet } from "./defs.ts";
import type { Json, JsonObject } from "./model.ts";
import { serialize } from "./canonical.ts";
import { checkWrapper, parseJson, type Wrapper } from "./model.ts";
import { printText } from "./print-text.ts";
import { readText } from "./read-text.ts";
import { CrubalError } from "./tree.ts";

export type CaseResult = { folder: string; name: string; pass: boolean; detail?: string };

const LEVEL_FOLDERS: { [level: string]: string[] } = {
  reader: ["reader", "reader-errors"],
  dictionary: ["reader", "reader-errors", "dictionary", "dictionary-errors"],
  rules: ["reader", "reader-errors", "dictionary", "dictionary-errors", "rules", "rules-errors"],
  store: ["reader", "reader-errors", "dictionary", "dictionary-errors", "rules", "rules-errors", "store", "store-errors"],
  exchange: [
    "reader", "reader-errors", "dictionary", "dictionary-errors", "rules", "rules-errors", "store", "store-errors",
    "exchange", "exchange-errors", "package-errors", "forms",
  ],
  views: [
    "reader", "reader-errors", "dictionary", "dictionary-errors", "rules", "rules-errors", "store", "store-errors",
    "exchange", "exchange-errors", "package-errors", "forms", "views", "views-errors",
  ],
};

/** The shared definitions a folder's cases run under: the reader package, then the folder's own files. */
function loadDictionary(root: string, folder: string): Dictionary {
  const dict = emptyDictionary();
  const files = [join(root, "reader", "_package.crubal")];
  const own = folder.replace(/-errors$/, "");
  for (const f of ["_facets.crubal", "_classes.crubal"]) files.push(join(root, own, f));
  // Data cases read under the reader's facets too; a store error case checks recipes against them.
  if (own !== "reader" && (!folder.endsWith("-errors") || folder === "store-errors")) files.splice(1, 0, join(root, "reader", "_facets.crubal"));
  for (const p of files) if (existsSync(p)) readDefinitions(readFileSync(p, "utf8"), dict);
  return dict;
}

function copy(d: Dictionary): Dictionary {
  return { facets: new Map(d.facets), classes: new Map(d.classes), kinds: new Map(d.kinds), levels: new Map(d.levels), vary: new Map(d.vary), varyLines: new Map(d.varyLines), trust: [...d.trust], facetTrust: new Map(d.facetTrust), identify: new Map(d.identify), match: new Map(d.match), archive: new Map(d.archive) };
}

/** Each expected entry must match an actual one on every field it states; entry sets must be the same. */
function compareOutcomes(actual: Outcome[], expected: Outcome[]): string | null {
  const kind = (o: Outcome) => ("asked" in o ? "summary" : "value");
  const ident = (o: Outcome) => `${kind(o)}|${o.record ?? ""}|${o.address ?? ""}`;
  const kinds = new Set(expected.map(kind));
  const pool = actual.filter((a) => kinds.has(kind(a)));
  const want = new Set(expected.map(ident));
  const extra = pool.filter((a) => !want.has(ident(a)));
  if (extra.length) return `unexpected: ${extra.map((e) => serialize(e as Json)).join(" ")}`;
  for (const e of expected) {
    const a = pool.find((x) => ident(x) === ident(e));
    if (!a) return `missing: ${serialize(e as Json)}`;
    for (const [k, v] of Object.entries(e)) {
      if (serialize(a[k] as Json) !== serialize(v as Json)) return `${ident(e)}: ${k} is ${serialize((a[k] ?? "∅") as Json)}, expected ${serialize(v as Json)}`;
    }
  }
  return null;
}

function runDictionaryCase(folder: string, caseDir: string, name: string, shared: Dictionary): CaseResult | null {
  const input = readFileSync(join(caseDir, "input.crubal"), "utf8");
  const longFile = join(caseDir, "long.crubal");
  try {
    if (folder === "dictionary-errors") {
      const want = Number(readFileSync(join(caseDir, "error.txt"), "utf8").trim().split(/\s/)[0]);
      try {
        checkPackage(readDefinitions(input));
        return { folder, name, pass: false, detail: "published without refusing" };
      } catch (e) {
        if (!(e instanceof CrubalError)) return { folder, name, pass: false, detail: String(e) };
        return e.line === want ? { folder, name, pass: true } : { folder, name, pass: false, detail: `refused at line ${e.line} (${e.message}), expected line ${want}` };
      }
    }
    if (existsSync(longFile)) {
      const expected = serialize(parseJson(readFileSync(join(caseDir, "expected.json"), "utf8")) as Json);
      for (const [label, text] of [["shorthand", input], ["long form", readFileSync(longFile, "utf8")]] as const) {
        const d = readDefinitions(text);
        checkPackage(d);
        const got = serialize([...d.facets.values()].filter((f) => !f.key.startsWith("crubal:")).map(facetJson) as Json);
        if (got !== expected) return { folder, name, pass: false, detail: `${label}: got ${got}` };
      }
      return { folder, name, pass: true };
    }
    const { defs, data } = splitCaseInput(input);
    const dict = copy(shared);
    if (defs.trim()) readDefinitions(defs, dict);
    checkPackage(dict);
    const resolveLine = defs.match(/^resolve: (\S+)/m);
    if (resolveLine) {
      const expected = parseJson(readFileSync(join(caseDir, "expected.json"), "utf8")) as { class: string; resolved: Json };
      const got = serialize(resolvedJson(resolve(dict, [resolveLine[1] as string])) as Json);
      return got === serialize(expected.resolved) ? { folder, name, pass: true } : { folder, name, pass: false, detail: `got ${got}` };
    }
    const w = readText(data, dict);
    w.records = w.records.map((r) => foldRecord(r, dict));
    const outcomesFile = join(caseDir, "expected-outcomes.json");
    if (existsSync(outcomesFile)) {
      const actual = w.records.flatMap((r) => {
        const c = checkRecord(r, dict);
        return [...c.outcomes, c.summary];
      });
      const problem = compareOutcomes(actual, JSON.parse(readFileSync(outcomesFile, "utf8")) as Outcome[]);
      return problem ? { folder, name, pass: false, detail: problem } : { folder, name, pass: true };
    }
    const expected = parseJson(readFileSync(join(caseDir, "expected.json"), "utf8")) as Wrapper;
    checkWrapper(expected, dict);
    const want = canonical(expected, dict);
    const got = canonical(w, dict);
    if (got !== want) return { folder, name, pass: false, detail: `read and fold: ${firstDiff(got, want)}` };
    const again = canonical(readText(printText(w, dict, "full"), dict), dict);
    if (again !== want) return { folder, name, pass: false, detail: `print and read back: ${firstDiff(again, want)}` };
    return { folder, name, pass: true };
  } catch (e) {
    return { folder, name, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: got …${a.slice(Math.max(0, i - 40), i + 60)}… expected …${b.slice(Math.max(0, i - 40), i + 60)}…`;
}

function runCase(folder: string, dir: string, name: string, dict: Dictionary): CaseResult {
  const caseDir = join(dir, name);
  const input = readFileSync(join(caseDir, "input.crubal"), "utf8");
  const errorFile = join(caseDir, "error.txt");
  if (existsSync(errorFile)) {
    const want = Number(readFileSync(errorFile, "utf8").trim().split(/\s/)[0]);
    try {
      readText(input, dict);
      return { folder, name, pass: false, detail: "read without refusing" };
    } catch (e) {
      if (!(e instanceof CrubalError)) return { folder, name, pass: false, detail: String(e) };
      return e.line === want
        ? { folder, name, pass: true }
        : { folder, name, pass: false, detail: `refused at line ${e.line} (${e.message}), expected line ${want}` };
    }
  }
  try {
    const expected = parseJson(readFileSync(join(caseDir, "expected.json"), "utf8")) as Wrapper;
    checkWrapper(expected, dict);
    const want = canonical(expected, dict);
    const got = readText(input, dict);
    const gotC = canonical(got, dict);
    if (gotC !== want) return { folder, name, pass: false, detail: `read: ${firstDiff(gotC, want)}` };
    const again = canonical(readText(printText(got, dict, "full"), dict), dict);
    if (again !== want) return { folder, name, pass: false, detail: `print and read back: ${firstDiff(again, want)}` };
    const fromJson = canonical(readText(printText(expected, dict, "full"), dict), dict);
    if (fromJson !== want) return { folder, name, pass: false, detail: `JSON to text and back: ${firstDiff(fromJson, want)}` };
    return { folder, name, pass: true };
  } catch (e) {
    return { folder, name, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function compareResults(actual: Result[], expected: Result[]): string | null {
  const ident = (o: Result) => `${o.result}|${o.record}|${o.address ?? ""}`;
  const kinds = new Set(expected.map((e) => e.result));
  const pool = actual.filter((a) => kinds.has(a.result));
  const want = new Set(expected.map(ident));
  const extra = pool.filter((a) => !want.has(ident(a)));
  if (extra.length) return `unexpected: ${extra.map((e) => serialize(e as unknown as Json)).join(" ")}`;
  for (const e of expected) {
    const a = pool.find((x) => ident(x) === ident(e)) as unknown as { [k: string]: Json } | undefined;
    if (!a) return `missing: ${serialize(e as unknown as Json)}`;
    for (const [k, v] of Object.entries(e)) {
      if (serialize(a[k] as Json) !== serialize(v as Json)) return `${ident(e)}: ${k} is ${serialize((a[k] ?? "∅") as Json)}, expected ${serialize(v as Json)}`;
    }
  }
  return null;
}

function runRulesCase(folder: string, caseDir: string, name: string, shared: Dictionary, sharedRules: Rule[]): CaseResult {
  const input = readFileSync(join(caseDir, "input.crubal"), "utf8");
  try {
    if (folder === "rules-errors") {
      const want = Number(readFileSync(join(caseDir, "error.txt"), "utf8").trim().split(/\s/)[0]);
      try {
        const d = copy(shared);
        readDefinitions(input, d);
        checkPackage(d);
        checkRules(readRules(input), d);
        return { folder, name, pass: false, detail: "published without refusing" };
      } catch (e) {
        if (!(e instanceof CrubalError)) return { folder, name, pass: false, detail: String(e) };
        return e.line === want ? { folder, name, pass: true } : { folder, name, pass: false, detail: `refused at line ${e.line} (${e.message}), expected line ${want}` };
      }
    }
    const { defs, data } = splitCaseInput(input);
    const dict = copy(shared);
    if (defs.trim()) readDefinitions(defs, dict);
    const rules = [...sharedRules, ...readRules(defs)];
    checkPackage(dict);
    checkRules(rules, dict);
    const engine = new Engine(dict, rules);
    const nowFile = join(caseDir, "now.txt");
    if (existsSync(nowFile)) engine.now = readFileSync(nowFile, "utf8").trim();
    const altFile = join(caseDir, "alternatives.json");
    const alts = existsSync(altFile) ? (JSON.parse(readFileSync(altFile, "utf8")) as { [id: string]: Json }) : {};
    const last = new Map<string, Result[]>();
    const run = (text: string) => {
      for (const r of readText(text, dict).records.map((x) => foldRecord(x, dict))) {
        if (alts[r.id]) (r as unknown as { alternatives: Json }).alternatives = alts[r.id] as Json;
        last.set(r.id, engine.write(r));
      }
    };
    run(data);
    const writeFile = join(caseDir, "write.crubal");
    if (existsSync(writeFile)) run(readFileSync(writeFile, "utf8"));
    const actual = [...last.values()].flat();
    const problem = compareResults(actual, JSON.parse(readFileSync(join(caseDir, "expected-results.json"), "utf8")) as Result[]);
    return problem ? { folder, name, pass: false, detail: problem } : { folder, name, pass: true };
  } catch (e) {
    return { folder, name, pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Every field an expected object states must be equal in the actual one. */
function subset(actual: { [k: string]: Json }, expected: { [k: string]: Json }, label = ""): string | null {
  for (const [k, v] of Object.entries(expected)) {
    if (serialize(actual[k] as Json) !== serialize(v)) return `${label}${k} is ${serialize((actual[k] ?? "∅") as Json)}, expected ${serialize(v)}`;
  }
  return null;
}

function runStoreCase(folder: string, caseDir: string, name: string, shared: Dictionary): CaseResult {
  resetUnits();
  const file = (f: string) => join(caseDir, f);
  const json = (f: string) => JSON.parse(readFileSync(file(f), "utf8")) as Json;
  const pass = { folder, name, pass: true };
  const fail = (detail: string) => ({ folder, name, pass: false, detail });
  try {
    const input = existsSync(file("input.crubal")) ? readFileSync(file("input.crubal"), "utf8") : "";
    if (folder === "store-errors") {
      const want = Number(readFileSync(file("error.txt"), "utf8").trim().split(/\s/)[0]);
      try {
        for (const r of readRecipes(input)) checkRecipe(r, shared);
        return fail("published without refusing");
      } catch (e) {
        if (!(e instanceof CrubalError)) return fail(String(e));
        return e.line === want ? pass : fail(`refused at line ${e.line} (${e.message}), expected line ${want}`);
      }
    }
    // Redaction (8.5.2): per entry, whether it may go whole, else which of its writes may, and why not.
    if (existsSync(file("expected-redact.json"))) {
      const entries = json("log.json") as JsonObject[];
      const got: JsonObject = {};
      for (const e of entries) {
        const whole = redactable(e);
        const writes = Array.isArray(e.writes) ? e.writes.filter((w): w is JsonObject => typeof w === "object" && w !== null && !Array.isArray(w)) : [];
        got[String(e.log)] = whole === null ? "redactable" : e.witnessed === true ? whole : writes.map((w) => redactableWrite(e, w) ?? "redactable");
      }
      const want = json("expected-redact.json") as JsonObject;
      for (const [k, v] of Object.entries(want)) if (serialize((got[k] ?? "∅") as Json) !== serialize(v)) return fail(`${k}: got ${serialize((got[k] ?? "∅") as Json)}`);
      return pass;
    }
    // Rebuild (8.5.3): the log alone gives back the state.
    if (existsSync(file("expected-state.json"))) {
      const got = stateJson(rebuild(json("log.json") as JsonObject[]));
      const want = json("expected-state.json") as JsonObject;
      for (const [k, v] of Object.entries(want)) {
        if (serialize((got[k] ?? "∅") as Json) !== serialize(v)) return fail(`${k}: ${firstDiff(serialize((got[k] ?? "∅") as Json), serialize(v))}`);
      }
      return pass;
    }
    if (existsSync(file("log.json"))) {
      const keys = existsSync(file("keys.json")) ? (json("keys.json") as unknown as Keys) : undefined;
      const got = verifyChain(json("log.json") as JsonObject[], keys) as unknown as { [k: string]: Json };
      const want = json("expected-verify.json") as { [k: string]: Json };
      const p = subset(got, want);
      return p ? fail(`${p} (got ${serialize(got)})`) : pass;
    }
    if (existsSync(file("answer.bin"))) {
      const got = rawOf(readFileSync(file("answer.bin")), "text/plain") as unknown as Json;
      return serialize(got) === serialize(json("expected-raw.json")) ? pass : fail(`got ${serialize(got)}`);
    }
    const { defs, data } = splitCaseInput(input);
    const dict = copy(shared);
    if (defs.trim()) readDefinitions(defs, dict);
    const records = readText(data, dict).records.map((r) => foldRecord(r, dict));
    const one = (r: Rec) => canonical({ crubal: "2", records: [r] }, dict);

    // Arrival (9.2a): a sequence of payloads through one contract, each finding or making its record.
    if (existsSync(file("answers.json"))) {
      const text = readFileSync(file("contract.crubal"), "utf8");
      readDefinitions(text, dict);
      const [contract] = readContracts(text);
      if (!contract) return fail("no contract");
      // Every arrival is an operation on the journal's draft, logged as entries (8.5).
      const journal = new Journal("test.example", records, "2026-10-15T00:00:00Z");
      const store: ArrivalStore = journal.draft;
      if (existsSync(file("bindings.json"))) journal.commit({ migration: "backfill" }, (d) => { for (const [k, v] of Object.entries(json("bindings.json") as JsonObject)) d.bindings.set(k, String(v)); }, "2026-10-15T00:00:01Z");
      const answersFile = json("answers.json");
      const level = isPlainObject(answersFile) ? String(answersFile.level) : "product";
      const answers = (isPlainObject(answersFile) ? answersFile.answers : answersFile) as Json[];
      let n = 0;
      const mint = () => `${level.charAt(0).toUpperCase()}-NEW${++n}`;
      const owner = records[0]?.owner ?? "test.example";
      const got: Json[] = [];
      let held: { intake: IntakeRecord; ref?: string } | null = null;
      answers.forEach((a, i) => {
        const at = `2026-10-15T00:01:${String(i).padStart(2, "0")}Z`;
        if (isPlainObject(a) && isPlainObject(a.decide)) {
          if (!held) throw new Error("a decision with nothing held");
          const choice = a.decide.new === true ? ({ new: true } as const) : { record: String(a.decide.record) };
          const h = held;
          journal.commit({ person: "reviewer" }, (d) => {
            got.push(decide(contract, h, choice, d, dict, { mint, owner, level }).arrival as unknown as Json);
          }, at);
          held = null;
          return;
        }
        journal.commit({ contract: contract.name, run: `R-${i + 1}` }, (d) => {
          const r = arrive(contract, JSON.stringify(a), level, d, dict, { mint, owner, intakeId: `I-${i + 1}` });
          if (r.arrival.outcome === "held") held = { intake: r.intake, ...(r.arrival.ref !== undefined ? { ref: r.arrival.ref } : {}) };
          got.push(r.arrival as unknown as Json);
        }, at);
      });
      const want = json("expected-arrival.json") as { [k: string]: Json }[];
      if (got.length !== want.length) return fail(`${got.length} arrivals, expected ${want.length}: ${serialize(got)}`);
      for (let i = 0; i < want.length; i++) {
        const p = subset(got[i] as { [k: string]: Json }, want[i] as { [k: string]: Json }, `arrival ${i + 1}: `);
        if (p) return fail(p);
      }
      if (existsSync(file("expected.json"))) {
        const want2 = json("expected.json") as { records: Rec[] };
        for (const w of want2.records) {
          const r = store.records.get(w.id);
          if (!r) return fail(`no record ${w.id}`);
          if (one(r) !== one(w)) return fail(`${w.id}: ${firstDiff(one(r), one(w))}`);
        }
      }
      return pass;
    }

    // Lifecycle (1.7, 1.12) and instructions (10.7): operations in order, then the records.
    if (existsSync(file("ops.crubal"))) {
      // Every operation runs on the journal's draft and is logged; a change the entries don't describe
      // is refused by the journal itself (8.5).
      const journal = new Journal("test.example", records, "2026-10-15T00:00:00Z");
      const store = journal.draft as unknown as ReturnType<typeof emptyStore>;
      if (existsSync(file("bindings.json"))) journal.commit({ migration: "backfill" }, (d) => { for (const [k, v] of Object.entries(json("bindings.json") as JsonObject)) d.bindings.set(k, String(v)); }, "2026-10-15T00:00:01Z");
      const caseRules = readRules(defs);
      const decisionDefs = { dict, contracts: new Map(readContracts(defs).map((c) => [c.name, c])) };
      let adoptFlag: string | undefined;
      let n = 0;
      for (const op of readTree(readFileSync(file("ops.crubal"), "utf8"))) {
        if (op.kind !== "pair" || !op.key) continue;
        const piece = readPiece(op.value, op.line);
        const detail = (k: string) => piece.detail.find(([n]) => n === k)?.[1].text;
        const [a = "", b] = piece.text.split(" -> ").map((s) => s.trim());
        const key = op.key;
        let problem: string | null = null;
        const extra: JsonObject[] = [];
        journal.commit({ person: "tester" }, () => {
          if (key === "archive") archive(store, a, detail("reason") ?? "archived", dict, detail("into"));
          else if (key === "unarchive") unarchive(store, a, dict);
          else if (key === "merge" && b) merge(store, a, b, dict);
          else if (key === "attach" && b) attach(store, a, b, dict, detail("edit") !== "no");
          else if (key === "detach") detach(store, a, dict);
          else if (key === "instruct") issue(store, piece.text, op.children);
          else if (key === "apply") applyInstructions(store, a, dict);
          else if (key === "adopt" && b) adoptFlag = adopt(store, a, b, caseRules).flagged ?? adoptFlag;
          else if (key === "give-back" && b) giveBack(store, a, b);
          else if (key === "clone" && b) clone(store, a, b, detail("owner") ?? "test.example");
          else if (key === "split" && b) {
            const list = (k: string) => (op.children.find((c) => c.key === k)?.value ?? "").split(",").map((x) => x.trim()).filter(Boolean);
            const vals: JsonObject = {};
            for (const c of op.children.find((c) => c.key === "values")?.children ?? []) if (c.key) vals[c.key] = dict.facets.get(c.key) ? (readUnder(dict.facets.get(c.key) as Facet, c.value, dict) ?? c.value) : c.value;
            split(store, a, b, { children: list("children"), values: vals, bindings: list("bindings") });
          }
          else if (key === "suggest") {
            // Test scaffolding: a suggestion on a record, as a gated or lands: suggestion run would leave it.
            const r = store.records.get(a) as Rec & { suggestions?: { [x: string]: JsonObject[] } };
            const address = op.children.find((c) => c.key === "address")?.value ?? "";
            const f = dict.facets.get(address);
            const raw = op.children.find((c) => c.key === "value")?.value ?? "";
            const value = f ? (readUnder(f, raw, dict) ?? raw) : raw;
            const item: JsonObject = { value, origin: op.children.find((c) => c.key === "origin")?.value ?? "reported", via: op.children.find((c) => c.key === "via")?.value ?? "L-S" };
            store.records.set(a, { ...r, suggestions: { ...(r.suggestions ?? {}), [address]: [...(r.suggestions?.[address] ?? []), item] } } as Rec);
          } else if (key === "hold") {
            // Test scaffolding: a value held by a rule, with its source kept (6.7).
            const r = store.records.get(a) as Rec & { held?: { [x: string]: JsonObject } };
            const address = op.children.find((c) => c.key === "address")?.value ?? "";
            const v = r.values[address];
            if (v === undefined) {
              problem = `${a} has nothing at ${address} to hold`;
              return;
            }
            const { [address]: _v, ...values } = r.values;
            const src = (r.sources?.[address] ?? r.sources?.["*"]) as unknown as JsonObject | undefined;
            store.records.set(a, { ...r, values, held: { ...(r.held ?? {}), [address]: { value: v, rule: op.children.find((c) => c.key === "rule")?.value ?? "rule", ...(src ? { source: src } : {}) } } } as Rec);
          } else if (key === "decide") {
            // A review decision (9.5): the item's key on the line, the decision's fields below it.
            const d: JsonObject & { key: string; decision: string } = { key: piece.text, decision: "" };
            for (const c of op.children) {
              if (!c.key) continue;
              if (c.key === "instances" || c.key === "accepts") d[c.key] = c.value.split(",").map((x) => x.trim()).filter(Boolean);
              else if (c.key === "value" && typeof d.address === "string" && dict.facets.get(d.address)) d.value = readUnder(dict.facets.get(d.address) as Facet, c.value, dict) ?? c.value;
              else d[c.key] = c.key === "factor" || c.key === "offset" ? c.value : (dict.facets.get(c.key) ? (readUnder(dict.facets.get(c.key) as Facet, c.value, dict) ?? c.value) : c.value);
            }
            extra.push(...decideReview(d, store, decisionDefs));
          }
          else if (key === "write") {
            const r = store.records.get(a);
            if (!r) {
              problem = `write to an unknown record ${a}`;
              return;
            }
            const values = { ...r.values };
            for (const c of op.children) {
              const f = c.key ? dict.facets.get(c.key) : undefined;
              if (c.key) values[c.key] = f ? (readUnder(f, c.value, dict) ?? c.value) : c.value;
            }
            store.records.set(a, { ...r, values });
          } else problem = `unknown op ${key}`;
        }, `2026-10-15T00:01:${String(++n).padStart(2, "0")}Z`, extra);
        if (problem) return fail(problem);
      }
      if (existsSync(file("expected-flag.json"))) {
        const want = json("expected-flag.json") as JsonObject;
        if (want.adopt !== (adoptFlag ?? null)) return fail(`adopt flagged ${adoptFlag ?? "nothing"}, expected ${serialize(want.adopt as Json)}`);
      }
      if (existsSync(file("expected-entries.json"))) {
        const got = journal.entries.map(({ at: _at, owner: _o, ...e }) => e);
        const wantE = json("expected-entries.json");
        if (serialize(got as Json) !== serialize(wantE)) return fail(`entries: ${firstDiff(serialize(got as Json), serialize(wantE))}`);
      }
      const want = json("expected.json") as { records: Rec[]; review?: Json; bindings?: JsonObject };
      for (const w of want.records) {
        const r = store.records.get(w.id);
        if (!r) return fail(`no record ${w.id}`);
        if (one(r) !== one(w)) return fail(`${w.id}: ${firstDiff(one(r), one(w))}`);
      }
      if (want.review !== undefined && serialize(store.review) !== serialize(want.review)) return fail(`review: got ${serialize(store.review)}`);
      if (want.bindings !== undefined && serialize(Object.fromEntries(store.bindings)) !== serialize(want.bindings)) return fail(`bindings: got ${serialize(Object.fromEntries(store.bindings))}`);
      return pass;
    }

    if (existsSync(file("recipe.crubal"))) {
      const [recipe] = readRecipes(readFileSync(file("recipe.crubal"), "utf8"));
      if (!recipe) return fail("no recipe");
      checkRecipe(recipe, dict);
      if (existsSync(file("expected-dry-run.json"))) {
        const got = dryRun(records, recipe, dict);
        return serialize(got as unknown as Json) === serialize(json("expected-dry-run.json")) ? pass : fail(`dry run: ${serialize(got as unknown as Json)}`);
      }
      const { records: out, review } = restamp(records, recipe, dict);
      const want = json("expected.json") as JsonObject;
      const got = { ...JSON.parse(canonical({ crubal: "2", package: recipe.to, records: out }, dict)), review };
      const wantC = { ...JSON.parse(canonical({ crubal: String(want.crubal), package: String(want.package), records: want.records as unknown as Rec[] }, dict)), review: want.review };
      return serialize(got) === serialize(wantC) ? pass : fail(`got ${firstDiff(serialize(got), serialize(wantC))}`);
    }
    if (existsSync(file("contract-v2.crubal"))) {
      const [v1] = readContracts(readFileSync(file("contract.crubal"), "utf8"));
      const [v2] = readContracts(readFileSync(file("contract-v2.crubal"), "utf8"));
      if (!v1 || !v2) return fail("no contract");
      const body = readFileSync(file("answer.json"), "utf8");
      const first = receive(v1, body, records[0]?.id ?? "", dict);
      const again = replay(first, v2, dict);
      const twice = replay(first, v2, dict);
      const want = json("expected-replay.json") as { first: { [k: string]: Json }[]; replayed: { [k: string]: Json }[]; replays: number };
      const replayed = (again.replays.at(-1)?.outcomes ?? []) as unknown as IntakeOutcome[];
      const check = (got: IntakeOutcome[], exp: { [k: string]: Json }[], label: string) => {
        for (const w of exp) {
          const a = got.find((o) => o.from === w.from) as unknown as { [k: string]: Json } | undefined;
          if (!a) return `${label}: no outcome for ${w.from}`;
          const p = subset(a, w, `${label} ${w.from}: `);
          if (p) return p;
        }
        return null;
      };
      const p = check(first.outcomes, want.first, "first") ?? check(replayed, want.replayed, "replayed");
      if (p) return fail(p);
      if (again.replays.length !== want.replays) return fail(`${again.replays.length} replays`);
      if (serialize(again.replays as unknown as Json) !== serialize(twice.replays as unknown as Json)) return fail("replay isn't deterministic");
      if (again.raw.body !== body || again.raw.sha256 !== first.raw.sha256) return fail("replay changed the kept bytes");
      return pass;
    }
    if (existsSync(file("expected-review.json"))) {
      const got = reviewByKey(json("intakes.json") as unknown as { for: string; outcomes: IntakeOutcome[] }[]);
      const want = json("expected-review.json") as { "by-key": { [k: string]: Json }[]; proposals: { [k: string]: Json }[] };
      if (got["by-key"].length !== want["by-key"].length) return fail(`by-key: got ${serialize(got["by-key"] as unknown as Json)}`);
      for (let i = 0; i < want["by-key"].length; i++) {
        const p = subset(got["by-key"][i] as { [k: string]: Json }, want["by-key"][i] as { [k: string]: Json }, `by-key[${i}] `);
        if (p) return fail(p);
      }
      return serialize(got.proposals as unknown as Json) === serialize(want.proposals as unknown as Json) ? pass : fail(`proposals: got ${serialize(got.proposals as unknown as Json)}`);
    }
    if (existsSync(file("contract.crubal"))) {
      const text = readFileSync(file("contract.crubal"), "utf8");
      readDefinitions(text, dict);
      const [contract] = readContracts(text);
      if (!contract) return fail("no contract");
      const intake = receive(contract, readFileSync(file("answer.json"), "utf8"), records[0]?.id ?? "", dict);
      const want = (json("expected-intake.json") as { outcomes: { [k: string]: Json }[] }).outcomes;
      if (intake.outcomes.length !== want.length) return fail(`got ${intake.outcomes.length} outcomes: ${serialize(intake.outcomes as unknown as Json)}`);
      for (const w of want) {
        const a = intake.outcomes.find((o) => o.from === w.from) as unknown as { [k: string]: Json } | undefined;
        if (!a) return fail(`no outcome for ${w.from}`);
        const p = subset(a, w, `${w.from}: `);
        if (p) return fail(p);
      }
      return pass;
    }
    if (existsSync(file("answer.json"))) {
      const answer = json("answer.json") as { parts: { slot: string; [k: string]: Json }[] };
      const got = matchParts(records[0] as Rec, answer.parts, dict);
      const want = json("expected.json");
      return serialize(got as unknown as Json) === serialize(want) ? pass : fail(`got ${serialize(got as unknown as Json)}`);
    }
    if (existsSync(file("observations.json")) && existsSync(file("expected-proposal.json"))) {
      const got = proposeSplit(records, json("observations.json") as unknown as Observation[]);
      return serialize(got) === serialize(json("expected-proposal.json")) ? pass : fail(`proposal: ${serialize(got)}`);
    }
    if (existsSync(file("observations.json"))) {
      const want = json("expected-validation.json") as { [k: string]: Json };
      const rec = records.find((r) => r.id === want.record) as Rec;
      const got = validate(rec, String(want.address), json("observations.json") as unknown as Observation[]);
      const p = subset(got as { [k: string]: Json }, want);
      return p ? fail(p) : pass;
    }
    const intakes = existsSync(file("intakes.json")) ? (json("intakes.json") as JsonObject[]) : [json("intake.json") as JsonObject];
    let rec = records[0] as Rec;
    for (const i of intakes) rec = land(rec, i as unknown as Parameters<typeof land>[1], { origin: "reported", via: String(i.log) }, dict.trust, dict.facetTrust);
    const want = json("expected.json") as unknown as Rec;
    const got = one(rec);
    const wantC = one(want);
    const alts = serialize(((rec as unknown as JsonObject).alternatives ?? {}) as Json) === serialize(((want as unknown as JsonObject).alternatives ?? {}) as Json);
    return got === wantC && alts ? pass : fail(`got ${firstDiff(got, wantC)} alternatives ${serialize(((rec as unknown as JsonObject).alternatives ?? {}) as Json)}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function runExchangeCase(folder: string, caseDir: string, name: string, shared: Dictionary, root: string): CaseResult {
  const file = (f: string) => join(caseDir, f);
  const json = (f: string) => JSON.parse(readFileSync(file(f), "utf8")) as Json;
  const pass = { folder, name, pass: true };
  const fail = (detail: string) => ({ folder, name, pass: false, detail });
  try {
    const input = existsSync(file("input.crubal")) ? readFileSync(file("input.crubal"), "utf8") : "";
    if (folder === "exchange-errors" || folder === "package-errors") {
      const want = Number(readFileSync(file("error.txt"), "utf8").trim().split(/\s/)[0]);
      try {
        if (folder === "package-errors") {
          checkPackages(input);
          checkPackage(readDefinitions(input));
        }
        else if (/^(edge|permissions|ownership): /m.test(input)) {
          // Access (14.12, 14.13): the declarations, every record's owner, and every edge, in order.
          const { defs, data } = splitCaseInput(input);
          const d = copy(shared);
          readDefinitions(defs, d);
          const { perms, edges } = readAccess(defs);
          checkPermissions(perms, d, new Set(readContracts(defs).map((c) => c.name)));
          const recs = data.trim() ? readText(data, d).records.map((r) => foldRecord(r, d)) : [];
          const access = new Access(d, perms, new MemoryRecords(recs.map((r) => [r.id, r])), [], "test.example");
          // A record's refusal names the line its header was written at.
          const lineOf = (id: string) => {
            const i = input.split("\n").findIndex((l) => new RegExp(`^\\w+: ${id}(\\s|$)`).test(l));
            return i < 0 ? undefined : i + 1;
          };
          access.checkWithin(lineOf);
          for (const r of recs) {
            access.checkOwnership(r, lineOf(r.id));
            access.checkWears(r, lineOf(r.id));
          }
          for (const e of edges) {
            access.checkEdge(e);
            access.edges.set(e.edge, e);
          }
        } else {
          const d = copy(shared);
          readDefinitions(input, d);
          checkPackage(d);
          checkContracts(readContracts(input), d);
        }
        return fail("published without refusing");
      } catch (e) {
        if (!(e instanceof CrubalError)) return fail(String(e));
        return e.line === want ? pass : fail(`refused at line ${e.line} (${e.message}), expected line ${want}`);
      }
    }
    if (existsSync(file("border.json"))) {
      const got = verifyBorder(json("border.json") as unknown as { records: Rec[]; log: JsonObject[] }, json("keys.json") as unknown as Keys);
      const p = subset(got as { [k: string]: Json }, json("expected-border.json") as { [k: string]: Json });
      return p ? fail(`${p} (got ${serialize(got)})`) : pass;
    }
    const { defs, data } = splitCaseInput(input);
    const dict = copy(shared);
    if (defs.trim()) readDefinitions(defs, dict);
    checkPackage(dict);

    // Access (chapter 14): edges over the records, then questions.
    if (existsSync(file("ask.crubal"))) {
      const accessText = readFileSync(file("access.crubal"), "utf8");
      readDefinitions(accessText, dict);
      const { perms, edges } = readAccess(accessText);
      checkPermissions(perms, dict, new Set(readContracts(accessText).map((c) => c.name)));
      const recs = readText(data, dict).records.map((r) => foldRecord(r, dict));
      const now = existsSync(file("now.txt")) ? readFileSync(file("now.txt"), "utf8").trim() : undefined;
      const access = new Access(dict, perms, new MemoryRecords(recs.map((r) => [r.id, r])), edges, "test.example", now);
      access.checkWithin();
      const got: JsonObject[] = [];
      for (const q of readTree(readFileSync(file("ask.crubal"), "utf8"))) {
        if (q.kind !== "pair" || !q.key) continue;
        const words = q.value.trim().split(/\s+/);
        const ask = `${q.key}: ${q.value.trim()}`;
        if (q.key === "may") {
          // may: <caller> <verb> <target> on <record>
          const [caller = "", verb = "", target = "", , record = ""] = words;
          got.push({ ask, result: access.may(caller, verb, target, record) });
        } else if (q.key === "mode") {
          const [caller = "", , record = ""] = words;
          got.push({ ask, result: access.effective(caller, record).mode });
        } else if (q.key === "stands") {
          // stands: <caller> <partition…> on <record>
          const on = words.indexOf("on");
          got.push({ ask, result: access.standsIn(words[0] ?? "", words[on + 1] ?? "", words.slice(1, on).join(" ")) });
        } else if (q.key === "gated") {
          const [caller = "", , record = ""] = words;
          got.push({ ask, result: access.gated(caller, record)?.edge ?? false });
        } else if (q.key === "ancestors") {
          got.push({ ask, result: access.ancestors(words[0] ?? "") });
        } else if (q.key === "audience") {
          got.push({ ask, result: access.audienceOf(words[0] ?? "") });
        } else return fail(`unknown ask ${q.key}`);
      }
      const want = json("expected-access.json") as JsonObject[];
      if (got.length !== want.length) return fail(`${got.length} answers, expected ${want.length}`);
      for (let i = 0; i < want.length; i++) {
        const p = subset(got[i] as { [k: string]: Json }, want[i] as { [k: string]: Json }, `${(want[i] as JsonObject).ask}: `);
        if (p) return fail(p);
      }
      return pass;
    }

    const shared_ = readFileSync(join(root, "exchange", "_contracts.crubal"), "utf8");
    const contracts = [...readContracts(shared_), ...readContracts(defs)];
    // A case that defines views lets its stream contracts (12.6.2) carry their projection streams.
    const ownViews = readViews(defs);
    checkContracts(contracts, dict, "", ownViews.views.size ? new Set(ownViews.views.keys()) : undefined);
    const ex = new Exchange(dict, contracts, readRoles(defs), readRules(defs));
    if (ownViews.views.size) {
      checkViews(ownViews, dict);
      ex.views = new Views(dict, ownViews);
    }
    for (const r of readText(data, dict).records.map((x) => foldRecord(x, dict))) {
      ex.put(r);
      ex.views?.put(r);
    }
    // With access.crubal, the border consults access (chapter 14): permission to run, gates, consumer edges.
    if (existsSync(file("access.crubal"))) {
      const accessText = readFileSync(file("access.crubal"), "utf8");
      const { perms, edges } = readAccess(accessText);
      const now = existsSync(file("now.txt")) ? readFileSync(file("now.txt"), "utf8").trim() : undefined;
      ex.access = new Access(dict, perms, ex.records, edges, "test.example", now);
    }
    // Every run is a transaction (8.5): the border works on a journal's draft and commits each run.
    const journal = new Journal("test.example", [], "2026-01-01T00:00:00Z");
    ex.useJournal(journal);
    journal.commit({ migration: "backfill" }, () => {}, "2026-01-01T00:00:00Z");

    // The runs, in order.
    const results: Json[] = [];
    let current: { run?: string; on?: string; caller?: string; offer?: string; presenter?: string; arrive?: string; level?: string; answer?: string; stream?: string; ack?: string; cursor?: string; tick?: string; now?: string; prepare?: string; acted?: string; failed?: string; reason?: string; undo?: string; forRun?: string; decideRun?: string; decision?: string } = {};
    const parseCursor = (s: string | undefined) => (s ? Object.fromEntries(s.split(",").map((p) => p.trim().split("=")).map(([v, n]) => [v ?? "", Number(n)])) : undefined);
    const flush = () => {
      // The send split (docs/design/runs.md): prepare, then acted or failed; undo names its cause.
      if (current.prepare && current.on) {
        results.push(ex.prepare(current.prepare, current.on, current.caller) as Json);
        current = {};
        return;
      }
      if (current.acted) {
        results.push(ex.acted(current.acted) as Json);
        current = {};
        return;
      }
      if (current.failed) {
        results.push(ex.failed(current.failed, current.reason ?? "failed") as Json);
        current = {};
        return;
      }
      if (current.undo) {
        results.push(ex.undo(current.undo, current.caller) as Json);
        current = {};
        return;
      }
      if (current.decideRun) {
        results.push(ex.decideRun(current.decideRun, current.decision === "drop" ? "drop" : "retry", current.caller) as Json);
        current = {};
        return;
      }
      if (current.tick) {
        results.push(ex.tick(current.tick, current.now ?? "", current.caller) as Json);
        current = {};
        return;
      }
      if (current.stream) {
        results.push(ex.streamRun(current.stream, current.caller, parseCursor(current.cursor)) as Json);
        current = {};
        return;
      }
      if (current.ack) {
        results.push(ex.ack(current.ack, parseCursor(current.cursor) ?? {}) as Json);
        current = {};
        return;
      }
      if (current.arrive) {
        results.push(ex.arriveRun(current.arrive, readFileSync(file(current.answer ?? "answer.json"), "utf8"), current.level ?? "product", current.caller, current.on) as Json);
        current = {};
        return;
      }
      if (!current.run || !current.on) return;
      const c = contracts.find((x) => x.name === current.run);
      if (current.offer) {
        results.push(ex.take(current.run, current.offer, current.on, json(current.presenter ?? "presenter.json") as unknown as Rec) as Json);
      } else if (c?.kind === "receive" || current.forRun) {
        // A late answer names its run (7.5): the receive closes it and lands with its via.
        results.push(ex.receiveRun(current.run, current.on, readFileSync(file(current.answer ?? "answer.json"), "utf8"), current.caller, current.forRun) as Json);
      } else {
        results.push(ex.run(current.run, current.on, current.caller) as Json);
      }
      current = {};
    };
    for (const n of readTree(readFileSync(file("run.crubal"), "utf8"))) {
      if (n.key === "run") {
        flush();
        current.run = n.value;
      } else if (n.key === "arrive") {
        flush();
        current.arrive = n.value;
      } else if (n.key === "stream") {
        flush();
        current.stream = n.value;
      } else if (n.key === "ack") {
        flush();
        current.ack = n.value;
      } else if (n.key === "prepare" || n.key === "acted" || n.key === "failed" || n.key === "undo") {
        flush();
        current[n.key] = n.value;
      } else if (n.key === "decide-run") {
        flush();
        current.decideRun = n.value;
      } else if (n.key === "decision") current.decision = n.value;
      else if (n.key === "reason") current.reason = n.value;
      else if (n.key === "for-run") current.forRun = n.value;
      else if (n.key === "cursor") current.cursor = n.value;
      else if (n.key === "tick") {
        flush();
        current.tick = n.value;
      } else if (n.key === "now") current.now = n.value;
      else if (n.key === "revise") {
        flush();
        const [view = "", version = ""] = n.value.split(" /");
        ex.views?.revise(view.trim(), version.trim());
      } else if (n.key === "on") current.on = n.value;
      else if (n.key === "level") current.level = n.value;
      else if (n.key === "answer") current.answer = n.value;
      else if (n.key === "caller") current.caller = n.value;
      else if (n.key === "offer") current.offer = n.value;
      else if (n.key === "presenter") current.presenter = n.value;
      else if (n.key === "give") {
        // The owner's own offer (7.8), as its host would serve it.
        flush();
        results.push(ex.offer(n.value, "test.example") as unknown as Json);
      } else if (n.key === "expire") {
        flush();
        results.push(ex.expire(n.value) as unknown as Json);
      } else if (n.key === "write") {
        flush();
        const r = ex.get(n.value);
        if (!r) return fail(`write to an unknown record ${n.value}`);
        const values = { ...r.values };
        for (const c of n.children) {
          const f = c.key ? dict.facets.get(c.key) : undefined;
          if (c.key) values[c.key] = f ? (readUnder(f, c.value, dict) ?? c.value) : c.value;
        }
        ex.put({ ...r, values });
        ex.views?.put({ ...r, values });
      }
    }
    flush();

    if (existsSync(file("expected.json"))) {
      const id = (json("expected.json") as JsonObject).id as string;
      const got = ex.get(id) as Rec;
      const want = json("expected.json") as unknown as Rec;
      const one = (r: Rec) => canonical({ crubal: "2", records: [r] }, dict);
      const extra = (r: Rec) => serialize({ a: ((r as unknown as JsonObject).alternatives ?? {}) as Json, s: ((r as unknown as JsonObject).suggestions ?? {}) as Json });
      if (one(got) !== one(want)) return fail(`record: ${firstDiff(one(got), one(want))}`);
      if (extra(got) !== extra(want)) return fail(`alternatives/suggestions: got ${extra(got)}`);
      return pass;
    }
    if (existsSync(file("expected-entries.json"))) {
      const got = journal.entries.map(({ at: _at, owner: _o, ...e }) => e);
      const wantE = json("expected-entries.json");
      if (serialize(got as Json) !== serialize(wantE)) return fail(`entries: ${firstDiff(serialize(got as Json), serialize(wantE))}`);
    }
    if (existsSync(file("expected-edges.json"))) {
      const got = [...(ex.access?.edges.values() ?? [])].map(({ line: _l, ...e }) => e as unknown as Json);
      const want = json("expected-edges.json") as JsonObject[];
      for (const w of want) {
        const a = got.find((e) => (e as JsonObject).edge === w.edge) as { [k: string]: Json } | undefined;
        if (!a) return fail(`no edge ${w.edge}`);
        const p = subset(a, w as { [k: string]: Json }, `${w.edge}: `);
        if (p) return fail(p);
      }
    }
    const wantRaw = json("expected-run.json");
    const want = (Array.isArray(wantRaw) ? wantRaw : [wantRaw]) as { [k: string]: Json }[];
    if (results.length !== want.length) return fail(`${results.length} runs, expected ${want.length}`);
    for (let i = 0; i < want.length; i++) {
      const w = { ...(want[i] as { [k: string]: Json }) };
      const a = results[i] as { [k: string]: Json };
      if (Array.isArray(w.outcomes)) {
        for (const wo of w.outcomes as { [k: string]: Json }[]) {
          const ao = (a.outcomes as { [k: string]: Json }[]).find((x) => x.from === wo.from);
          if (!ao) return fail(`run ${i + 1}: no outcome for ${wo.from}`);
          const p = subset(ao, wo, `run ${i + 1} ${wo.from}: `);
          if (p) return fail(p);
        }
        if ((a.outcomes as Json[]).length !== (w.outcomes as Json[]).length) return fail(`run ${i + 1}: ${(a.outcomes as Json[]).length} outcomes`);
        delete w.outcomes;
      }
      if (isPlainObject(w.sources)) {
        const p = subset(a.sources as { [k: string]: Json }, w.sources as { [k: string]: Json }, `run ${i + 1} sources `);
        if (p) return fail(p);
        delete w.sources;
      }
      // Stopping is the verdict, not a detail: an expectation must say so when a run stopped.
      if (a.stopped !== undefined && w.stopped === undefined) return fail(`run ${i + 1}: stopped at ${serialize(a.stopped)}, expected it to run`);
      const p = subset(a, w, `run ${i + 1}: `);
      if (p) return fail(p);
    }
    return pass;
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const RUN_KEYS = new Set(["pick", "context", "audiences", "callers", "page"]);

function runViewsCase(folder: string, caseDir: string, name: string, shared: Dictionary, root: string): CaseResult {
  const file = (f: string) => join(caseDir, f);
  const json = (f: string) => JSON.parse(readFileSync(file(f), "utf8")) as Json;
  const pass = { folder, name, pass: true };
  const fail = (detail: string) => ({ folder, name, pass: false, detail });
  try {
    const input = readFileSync(file("input.crubal"), "utf8");
    if (folder === "views-errors") {
      const want = Number(readFileSync(file("error.txt"), "utf8").trim().split(/\s/)[0]);
      try {
        const d = copy(shared);
        readDefinitions(input, d);
        checkPackage(d);
        checkViews(readViews(input), d);
        return fail("published without refusing");
      } catch (e) {
        if (!(e instanceof CrubalError)) return fail(String(e));
        return e.line === want ? pass : fail(`refused at line ${e.line} (${e.message}), expected line ${want}`);
      }
    }
    // Run lines (a bodiless "view:", pick, context, audiences, callers, page) are instructions, not definitions.
    const lines = input.split("\n");
    const run: { view?: string; picks: { [f: string]: string[] }; context?: string; audiences?: string[]; callers?: string[]; page?: number } = { picks: {} };
    const tree = readTree(input);
    for (const n of tree) {
      const isRun = (n.key === "view" && n.children.length === 0) || (n.key !== null && RUN_KEYS.has(n.key));
      if (!isRun) continue;
      const blank = (x: typeof n) => {
        lines[x.line - 1] = "";
        for (const c of x.children) blank(c);
      };
      blank(n);
      if (n.key === "view") run.view = n.value;
      if (n.key === "pick") for (const c of n.children) if (c.key) run.picks[c.key] = c.value.split(",").map((x) => x.trim());
      if (n.key === "context") run.context = n.value;
      if (n.key === "audiences") run.audiences = n.value.split(",").map((x) => x.trim());
      if (n.key === "callers") run.callers = n.value.split(",").map((x) => x.trim());
      if (n.key === "page") run.page = Number(n.value);
    }
    const { defs, data } = splitCaseInput(lines.join("\n"));
    const dict = copy(shared);
    const sharedViews = readFileSync(join(root, "views", "_views.crubal"), "utf8");
    readDefinitions(sharedViews, dict);
    if (defs.trim()) readDefinitions(defs, dict);
    checkPackage(dict);
    const set = readViews(sharedViews);
    const own = readViews(defs);
    for (const k of ["shapes", "filters", "views", "roles", "shown"] as const) for (const [key, val] of own[k]) (set[k] as Map<string, unknown>).set(key, val);
    checkViews(set, dict);
    const views = new Views(dict, set);
    const text = data.trim() ? data : readFileSync(join(root, "views", "_records.crubal"), "utf8");
    const records = readText(text, dict).records.map((r) => foldRecord(r, dict));
    for (const r of records) views.put(r);
    const byId = new MemoryRecords(records.map((r) => [r.id, r]));
    const viewName = run.view as string;
    // Partitioned views (12.6): the case's edges decide which rows a caller is served.
    let access: Access | undefined;
    if (existsSync(file("access.crubal"))) {
      const { perms, edges } = readAccess(readFileSync(file("access.crubal"), "utf8"));
      access = new Access(dict, perms, byId, edges, "test.example");
    }
    const opts = { picks: run.picks, ...(run.context ? { context: byId.get(run.context) as Rec } : {}), ...(run.page ? { page: run.page } : {}), ...(access ? { access } : {}) };
    const same = (got: Json, want: Json, label: string) => (serialize(got) === serialize(want) ? pass : fail(`${label}: got ${serialize(got)}`));

    if (existsSync(file("expected-stream.json"))) {
      const first = views.stream(viewName, opts);
      for (const w of readText(readFileSync(file("write.crubal"), "utf8"), dict).records) {
        const was = byId.get(w.id);
        views.put(was ? { ...was, values: { ...was.values, ...w.values } } : foldRecord(w, dict));
      }
      const second = views.stream(viewName, opts);
      return same([first, second] as unknown as Json, json("expected-stream.json"), "stream");
    }

    if (existsSync(file("expected-stale.json"))) {
      views.project(viewName, opts);
      const stale = new Set<string>();
      for (const w of readText(readFileSync(file("write.crubal"), "utf8"), dict).records) for (const id of views.staleAfter(viewName, w)) stale.add(id);
      const want = json("expected-stale.json") as { stale: string[]; "not-stale": string[] };
      const wrong = [...want.stale.filter((id) => !stale.has(id)), ...want["not-stale"].filter((id) => stale.has(id))];
      return wrong.length ? fail(`stale: got ${[...stale].join(", ")}`) : pass;
    }
    if (existsSync(file("expected-by.json"))) {
      const got: JsonObject = {};
      for (const a of run.audiences ?? []) got[a] = views.project(viewName, { ...opts, audience: a }).rows;
      for (const c of run.callers ?? []) got[c] = views.project(viewName, { ...opts, caller: byId.get(c) as Rec }).rows;
      return same(got, json("expected-by.json"), "by audience");
    }
    const p = views.project(viewName, opts);
    if (existsSync(file("expected-counts.json"))) return same({ records: p.records, counts: p.counts, ...(p.nested ? { nested: p.nested } : {}), indexable: p.indexable } as unknown as Json, json("expected-counts.json"), "counts");
    if (existsSync(file("expected-jsonld.json"))) return same(p.rows as unknown as Json, json("expected-jsonld.json"), "jsonld");
    if (existsSync(file("expected-pages.json"))) return same({ pages: p.pages, records: p.records, indexable: p.indexable } as unknown as Json, json("expected-pages.json"), "pages");
    const wantFile = existsSync(file("expected-portable.json")) ? "expected-portable.json" : "expected-projection.json";
    return same(p.rows as unknown as Json, json(wantFile), "projection");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const isPlainObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Forms as data (7.7, docs/design/index-and-forms.md): `form.crubal` names the contract, the record and
 * optionally the caller (several `form:` blocks give several forms); `access.crubal` makes editability
 * follow edges and gates; `arrival.json` is a held arrival whose candidates the form offers;
 * `expected-form.json` is the form (or the forms) exactly.
 */
function runFormsCase(folder: string, caseDir: string, name: string, shared: Dictionary): CaseResult {
  const file = (f: string) => join(caseDir, f);
  const json = (f: string) => JSON.parse(readFileSync(file(f), "utf8")) as Json;
  const pass = { folder, name, pass: true };
  const fail = (detail: string) => ({ folder, name, pass: false, detail });
  try {
    const input = readFileSync(file("input.crubal"), "utf8");
    const { defs, data } = splitCaseInput(input);
    const dict = copy(shared);
    if (defs.trim()) readDefinitions(defs, dict);
    const contracts = readContracts(defs);
    const records = data.trim() ? readText(data, dict).records.map((r) => foldRecord(r, dict)) : [];
    const byId = new MemoryRecords(records.map((r) => [r.id, r]));
    let access: Access | undefined;
    if (existsSync(file("access.crubal"))) {
      const { perms, edges } = readAccess(readFileSync(file("access.crubal"), "utf8"));
      access = new Access(dict, perms, byId, edges, "test.example");
    }
    const arrival = existsSync(file("arrival.json")) ? (json("arrival.json") as unknown as import("./arrival.ts").Arrival) : undefined;
    // form.crubal reads like run.crubal: `form:` starts one, `record:` and `caller:` belong to it.
    const asks: { form: string; record?: string; caller?: string }[] = [];
    for (const n of readTree(readFileSync(file("form.crubal"), "utf8"))) {
      if (n.key === "form") asks.push({ form: n.value.trim() });
      else if ((n.key === "record" || n.key === "caller") && asks.length) (asks[asks.length - 1] as { [k: string]: string })[n.key] = n.value.trim();
    }
    const forms: Json[] = [];
    for (const ask of asks) {
      const c = contracts.find((x) => x.name === ask.form);
      if (!c) return fail(`no contract ${ask.form}`);
      const rec = ask.record ? byId.get(ask.record) : undefined;
      forms.push(formOf(c, rec, dict, { records: byId, ...(ask.caller ? { caller: ask.caller } : {}), ...(access ? { access } : {}), ...(arrival ? { arrival } : {}) }));
    }
    const want = json("expected-form.json");
    const got: Json = Array.isArray(want) ? forms : (forms[0] ?? {});
    return serialize(got) === serialize(want) ? pass : fail(`form: ${firstDiff(serialize(got), serialize(want))}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Run one level's corpus folders under `root`. */
export function runCorpus(root: string, level: string): CaseResult[] {
  const folders = LEVEL_FOLDERS[level];
  if (!folders) throw new Error(`no corpus runner for level ${level} yet`);
  const results: CaseResult[] = [];
  for (const folder of folders) {
    const dir = join(root, folder);
    const dict = loadDictionary(root, folder);
    const rulesFile = join(root, "rules", "_rules.crubal");
    const sharedRules = folder === "rules" && existsSync(rulesFile) ? readRules(readFileSync(rulesFile, "utf8")) : [];
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith("_")) continue;
      if (!["input.crubal", "log.json", "border.json"].some((f) => existsSync(join(dir, name, f)))) continue;
      if (folder === "store" && existsSync(join(dir, name, "expected-redact.json"))) {
        results.push(runStoreCase(folder, join(dir, name), name, dict));
        continue;
      }
      const r = folder === "forms"
        ? runFormsCase(folder, join(dir, name), name, dict)
        : folder.startsWith("views")
        ? runViewsCase(folder, join(dir, name), name, dict, root)
        : folder.startsWith("exchange") || folder === "package-errors"
        ? runExchangeCase(folder, join(dir, name), name, dict, root)
        : folder.startsWith("store")
        ? runStoreCase(folder, join(dir, name), name, dict)
        : folder.startsWith("rules")
        ? runRulesCase(folder, join(dir, name), name, dict, sharedRules)
        : folder.startsWith("dictionary")
          ? runDictionaryCase(folder, join(dir, name), name, dict)
          : runCase(folder, dir, name, dict);
      if (r) results.push(r);
    }
  }
  return results;
}
