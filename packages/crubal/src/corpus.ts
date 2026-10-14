// corpus.ts: runs the conformance corpus (spec chapter 13). A Reader passes a case when reading the input
// gives the expected canonical JSON, printing that and reading it back gives the same, and printing the
// expected JSON reads back to the same. An error case passes when the input is refused at the given line.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./canonical.ts";
import { type Dictionary, emptyDictionary, readDefinitions, splitCaseInput } from "./defs.ts";
import { checkRules, Engine, readRules, type Result, type Rule } from "./rules.ts";
import { checkPackage, checkRecord, facetJson, foldRecord, type Outcome, resolve, resolvedJson } from "./dictionary.ts";
import type { Json } from "./model.ts";
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
};

/** The shared definitions a folder's cases run under: the reader package, then the folder's own files. */
function loadDictionary(root: string, folder: string): Dictionary {
  const dict = emptyDictionary();
  const files = [join(root, "reader", "_package.crubal")];
  const own = folder.replace(/-errors$/, "");
  for (const f of ["_facets.crubal", "_classes.crubal"]) files.push(join(root, own, f));
  if (own !== "reader" && !folder.endsWith("-errors")) files.splice(1, 0, join(root, "reader", "_facets.crubal"));
  for (const p of files) if (existsSync(p)) readDefinitions(readFileSync(p, "utf8"), dict);
  return dict;
}

function copy(d: Dictionary): Dictionary {
  return { facets: new Map(d.facets), classes: new Map(d.classes), levels: new Map(d.levels), vary: new Map(d.vary) };
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
      if (name.startsWith("_") || !existsSync(join(dir, name, "input.crubal"))) continue;
      const r = folder.startsWith("rules")
        ? runRulesCase(folder, join(dir, name), name, dict, sharedRules)
        : folder.startsWith("dictionary")
          ? runDictionaryCase(folder, join(dir, name), name, dict)
          : runCase(folder, dir, name, dict);
      if (r) results.push(r);
    }
  }
  return results;
}
