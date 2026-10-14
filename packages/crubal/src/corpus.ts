// corpus.ts: runs the conformance corpus (spec chapter 13). A Reader passes a case when reading the input
// gives the expected canonical JSON, printing that and reading it back gives the same, and printing the
// expected JSON reads back to the same. An error case passes when the input is refused at the given line.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "./canonical.ts";
import { type Dictionary, emptyDictionary, readDefinitions } from "./defs.ts";
import { checkWrapper, type Wrapper } from "./model.ts";
import { printText } from "./print-text.ts";
import { readText } from "./read-text.ts";
import { CrubalError } from "./tree.ts";

export type CaseResult = { folder: string; name: string; pass: boolean; detail?: string };

const LEVEL_FOLDERS: { [level: string]: string[] } = {
  reader: ["reader", "reader-errors"],
};

function loadDictionary(dir: string): Dictionary {
  const dict = emptyDictionary();
  for (const f of ["_package.crubal", "_facets.crubal"]) {
    const p = join(dir, f);
    if (existsSync(p)) readDefinitions(readFileSync(p, "utf8"), dict);
  }
  return dict;
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

/** Run one level's corpus folders under `root`. */
export function runCorpus(root: string, level: string): CaseResult[] {
  const folders = LEVEL_FOLDERS[level];
  if (!folders) throw new Error(`no corpus runner for level ${level} yet`);
  const results: CaseResult[] = [];
  const dict = loadDictionary(join(root, folders[0] as string));
  for (const folder of folders) {
    const dir = join(root, folder);
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith("_") || !existsSync(join(dir, name, "input.crubal"))) continue;
      results.push(runCase(folder, dir, name, dict));
    }
  }
  return results;
}
