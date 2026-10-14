// corpus.ts: runs the conformance corpus (spec chapter 13). A Reader passes a case when reading the input
// gives the expected canonical JSON, printing that and reading it back gives the same, and printing the
// expected JSON reads back to the same. An error case passes when the input is refused at the given line.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./canonical.ts";
import { type Dictionary, emptyDictionary, readDefinitions, splitCaseInput } from "./defs.ts";
import { type Keys, land, matchParts, rawOf, readContracts, receive, replay, reviewByKey, validate, verifyChain, type IntakeOutcome, type Observation } from "./store.ts";
import { checkRecipe, readRecipes, restamp } from "./migrate.ts";
import { checkContracts, Exchange, readRoles, verifyBorder } from "./exchange.ts";
import { checkPackages } from "./packages.ts";
import { checkViews, readViews, Views } from "./views.ts";
import { readUnder } from "./read-text.ts";
import { readTree } from "./tree.ts";
import type { Record as Rec } from "./model.ts";
import { checkRules, Engine, readRules, type Result, type Rule } from "./rules.ts";
import { checkPackage, checkRecord, facetJson, foldRecord, type Outcome, resolve, resolvedJson } from "./dictionary.ts";
import type { Json, JsonObject } from "./model.ts";
import { serialize } from "./canonical.ts";
import { checkWrapper, type Wrapper } from "./model.ts";
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
    "exchange", "exchange-errors", "package-errors",
  ],
  views: [
    "reader", "reader-errors", "dictionary", "dictionary-errors", "rules", "rules-errors", "store", "store-errors",
    "exchange", "exchange-errors", "package-errors", "views", "views-errors",
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
  return { facets: new Map(d.facets), classes: new Map(d.classes), levels: new Map(d.levels), vary: new Map(d.vary), trust: [...d.trust], facetTrust: new Map(d.facetTrust) };
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
      const expected = serialize(JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as Json);
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
      const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as { class: string; resolved: Json };
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
    const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as Wrapper;
    checkWrapper(expected);
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
    const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as Wrapper;
    checkWrapper(expected);
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

    if (existsSync(file("recipe.crubal"))) {
      const [recipe] = readRecipes(readFileSync(file("recipe.crubal"), "utf8"));
      if (!recipe) return fail("no recipe");
      checkRecipe(recipe, dict);
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
        if (folder === "package-errors") checkPackages(input);
        else {
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
    const shared_ = readFileSync(join(root, "exchange", "_contracts.crubal"), "utf8");
    const contracts = [...readContracts(shared_), ...readContracts(defs)];
    checkContracts(contracts, dict);
    const ex = new Exchange(dict, contracts, readRoles(defs));
    for (const r of readText(data, dict).records.map((x) => foldRecord(x, dict))) ex.put(r);

    // The runs, in order.
    const results: Json[] = [];
    let current: { run?: string; on?: string; caller?: string; offer?: string } = {};
    const flush = () => {
      if (!current.run || !current.on) return;
      const c = contracts.find((x) => x.name === current.run);
      if (current.offer) {
        results.push(ex.take(current.run, current.offer, current.on, json("presenter.json") as unknown as Rec) as Json);
      } else if (c?.kind === "receive") {
        results.push(ex.receiveRun(current.run, current.on, readFileSync(file("answer.json"), "utf8")) as Json);
      } else {
        results.push(ex.run(current.run, current.on, current.caller) as Json);
      }
      current = {};
    };
    for (const n of readTree(readFileSync(file("run.crubal"), "utf8"))) {
      if (n.key === "run") {
        flush();
        current.run = n.value;
      } else if (n.key === "on") current.on = n.value;
      else if (n.key === "caller") current.caller = n.value;
      else if (n.key === "offer") current.offer = n.value;
      else if (n.key === "write") {
        flush();
        const r = ex.get(n.value);
        if (!r) return fail(`write to an unknown record ${n.value}`);
        const values = { ...r.values };
        for (const c of n.children) {
          const f = c.key ? dict.facets.get(c.key) : undefined;
          if (c.key) values[c.key] = f ? (readUnder(f, c.value, dict) ?? c.value) : c.value;
        }
        ex.put({ ...r, values });
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
    const byId = new Map(records.map((r) => [r.id, r]));
    const viewName = run.view as string;
    const opts = { picks: run.picks, ...(run.context ? { context: byId.get(run.context) as Rec } : {}), ...(run.page ? { page: run.page } : {}) };
    const same = (got: Json, want: Json, label: string) => (serialize(got) === serialize(want) ? pass : fail(`${label}: got ${serialize(got)}`));

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
    if (existsSync(file("expected-counts.json"))) return same({ records: p.records, counts: p.counts, indexable: p.indexable } as unknown as Json, json("expected-counts.json"), "counts");
    if (existsSync(file("expected-pages.json"))) return same({ pages: p.pages, records: p.records, indexable: p.indexable } as unknown as Json, json("expected-pages.json"), "pages");
    const wantFile = existsSync(file("expected-portable.json")) ? "expected-portable.json" : "expected-projection.json";
    return same(p.rows as unknown as Json, json(wantFile), "projection");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

const isPlainObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

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
      const r = folder.startsWith("views")
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
