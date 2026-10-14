#!/usr/bin/env node
// crubal: read, print and test CRUBAL.
//   crubal test <corpus> [--level reader]   run a level's corpus folders
//   crubal read <file> --defs <file>...      text to JSON
//   crubal print <file.json> --defs <file>... JSON to text

import { readFileSync } from "node:fs";
import { canonical, emptyDictionary, printText, readDefinitions, readText, runCorpus } from "../src/index.ts";
import type { Wrapper } from "../src/model.ts";

const [cmd, target, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.flatMap((a, i) => (a === name ? [rest[i + 1] as string] : []));

function dictionary() {
  const dict = emptyDictionary();
  for (const f of flag("--defs")) readDefinitions(readFileSync(f, "utf8"), dict);
  return dict;
}

if (cmd === "test" && target) {
  const level = flag("--level")[0] ?? "reader";
  const results = runCorpus(target, level);
  for (const r of results) console.log(`${r.pass ? "pass" : "FAIL"}  ${r.folder}/${r.name}${r.detail ? `  ${r.detail}` : ""}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed (${level})`);
  process.exit(failed ? 1 : 0);
} else if (cmd === "read" && target) {
  const dict = dictionary();
  const w = readText(readFileSync(target, "utf8"), dict);
  console.log(rest.includes("--canonical") ? canonical(w, dict) : JSON.stringify(w, null, 2));
} else if (cmd === "print" && target) {
  console.log(printText(JSON.parse(readFileSync(target, "utf8")) as Wrapper, dictionary(), rest.includes("--plain") ? "plain" : "full"));
} else {
  console.log("usage: crubal test <corpus> [--level reader] | crubal read <file> --defs <file> | crubal print <file.json> --defs <file>");
  process.exit(2);
}
