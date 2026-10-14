// @cruba/crubal: the CRUBAL reference implementation. Pure functions; JSON in, JSON out.

export { CrubalError, readTree } from "./tree.ts";
export { readDefinitions, emptyDictionary, type Dictionary, type Facet } from "./defs.ts";
export { readText } from "./read-text.ts";
export { printText, type PrintMode } from "./print-text.ts";
export { canonical, serialize } from "./canonical.ts";
export { checkWrapper, type Wrapper, type Record, type Json } from "./model.ts";
export { runCorpus, type CaseResult } from "./corpus.ts";
