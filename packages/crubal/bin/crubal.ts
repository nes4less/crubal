#!/usr/bin/env node
// crubal: read, print and test CRUBAL.
//   crubal test <corpus> [--level reader]   run a level's corpus folders
//   crubal claim <corpus> [--level views] [--out CLAIM.md]   run every level up to one and print the claim (13.3)
//   crubal read <file> --defs <file>...      text to JSON
//   crubal print <file.json> --defs <file>... JSON to text
//   crubal publish <dir> [--previous <package.json>] [--date YYYY-MM-DD] [--key <file>] [--out <dir>]
//                                            cut a version: members by diff, recipes required, hash, signature

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, emptyDictionary, printText, publish, readDefinitions, readText, runCorpus } from "../src/index.ts";
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
} else if (cmd === "claim" && target) {
  // A claim names the language version, the level and the corpus version it passed (13.3), and links the run.
  const LEVELS = ["reader", "dictionary", "rules", "store", "exchange", "views"];
  const upTo = flag("--level")[0] ?? "views";
  if (!LEVELS.includes(upTo)) {
    console.log(`unknown level ${upTo}; one of ${LEVELS.join(", ")}`);
    process.exit(2);
  }
  const version = existsSync(join(target, "VERSION")) ? readFileSync(join(target, "VERSION"), "utf8").trim() : "unversioned";
  const lines: string[] = [];
  let failed = 0;
  for (const level of LEVELS.slice(0, LEVELS.indexOf(upTo) + 1)) {
    const results = runCorpus(target, level);
    const bad = results.filter((r) => !r.pass);
    failed += bad.length;
    const name = level.charAt(0).toUpperCase() + level.slice(1);
    lines.push(`${bad.length ? "FAILED" : "CRUBAL 2"} · ${name} · corpus ${version}  (${results.length - bad.length}/${results.length})`);
    for (const r of bad) lines.push(`  FAIL ${r.folder}/${r.name}${r.detail ? `  ${r.detail}` : ""}`);
  }
  for (const l of lines) console.log(l);
  const out = flag("--out")[0];
  if (out && !failed) {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(out, `# Conformance claim\n\n${lines.map((l) => `- ${l}`).join("\n")}\n\nRun on ${today} with \`crubal claim\` from this package against the corpus tagged \`corpus/${version}\` (spec 13.3, 13.4).\n`);
    console.log(`written ${out}`);
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === "read" && target) {
  const dict = dictionary();
  const w = readText(readFileSync(target, "utf8"), dict);
  console.log(rest.includes("--canonical") ? canonical(w, dict) : JSON.stringify(w, null, 2));
} else if (cmd === "publish" && target) {
  const dir = target;
  const src = readFileSync(join(dir, "package.crubal"), "utf8");
  const dict = emptyDictionary();
  readDefinitions(src, dict);
  // Reference records (11.1): every other .crubal file in the directory.
  const records = readdirSync(dir).filter((f) => f.endsWith(".crubal") && f !== "package.crubal").flatMap((f) => readText(readFileSync(join(dir, f), "utf8"), dict).records as unknown as import("../src/model.ts").Json[]);
  const previousFile = flag("--previous")[0];
  const previous = previousFile ? (JSON.parse(readFileSync(previousFile, "utf8")) as import("../src/model.ts").JsonObject) : undefined;
  const keyFile = flag("--key")[0];
  const keyJson = keyFile ? (JSON.parse(readFileSync(keyFile, "utf8")) as { public: string; private: string }) : undefined;
  const date = flag("--date")[0] ?? new Date().toISOString().slice(0, 10);
  const { bundle, changes } = publish(src, { date, ...(previous ? { previous } : {}), ...(records.length ? { records } : {}), ...(keyJson ? { key: { d: keyJson.private, x: keyJson.public } } : {}) });
  for (const ch of changes) if (ch.kind !== "unchanged") console.error(`  ${ch.kind.padEnd(9)} ${ch.member}${ch.why.length ? `  (${ch.why.join("; ")})` : ""}`);
  const out = flag("--out")[0];
  if (out) {
    const at = join(out, String(bundle.package), String(bundle.version));
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), `${JSON.stringify(bundle, null, 2)}\n`);
    writeFileSync(join(at, "package.crubal"), src);
    const latest = join(out, String(bundle.package));
    writeFileSync(join(latest, "package.json"), `${JSON.stringify(bundle, null, 2)}\n`);
    writeFileSync(join(latest, "package.crubal"), src);
    console.error(`published ${bundle.id} /${bundle.version} to ${at}${bundle.sig ? " (signed)" : " (unsigned)"}`);
  } else console.log(JSON.stringify(bundle, null, 2));
  void existsSync;
} else if (cmd === "print" && target) {
  console.log(printText(JSON.parse(readFileSync(target, "utf8")) as Wrapper, dictionary(), rest.includes("--plain") ? "plain" : "full"));
} else {
  console.log("usage: crubal test <corpus> [--level reader] | crubal claim <corpus> [--level views] [--out CLAIM.md] | crubal read <file> --defs <file> | crubal print <file.json> --defs <file> | crubal publish <dir> [--previous <package.json>] [--date YYYY-MM-DD] [--key <file>] [--out <dir>]");
  process.exit(2);
}
