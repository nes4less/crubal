// @cruba/crubal/browser: the pure levels, with nothing from Node (no file system, no crypto). For pages,
// playgrounds and edge runtimes. Store and Exchange need Node's crypto and stay in the main entry.

export { CrubalError, readTree } from "./tree.ts";
export { readDefinitions, emptyDictionary, type ClassDef, type Dictionary, type Facet } from "./defs.ts";
export { readText } from "./read-text.ts";
export { printText, type PrintMode } from "./print-text.ts";
export { canonical, serialize } from "./canonical.ts";
export { checkWrapper, type Wrapper, type Record, type Json } from "./model.ts";
export { checkPackage, checkRecord, facetJson, foldKey, foldRecord, resolve, resolvedJson, type Outcome } from "./dictionary.ts";
export { evaluate, parseCondition, type Truth } from "./conditions.ts";
export { checkRules, Engine, readRules, shortcutRules, type Result, type Rule } from "./rules.ts";
export { checkViews, readViews, Views } from "./views.ts";
