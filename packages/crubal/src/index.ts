// @cruba/crubal: the CRUBAL reference implementation. Pure functions; JSON in, JSON out.

export { CrubalError, readTree } from "./tree.ts";
export { readDefinitions, emptyDictionary, type ClassDef, type Dictionary, type Facet } from "./defs.ts";
export { readText } from "./read-text.ts";
export { printText, type PrintMode } from "./print-text.ts";
export { canonical, serialize } from "./canonical.ts";
export { checkWrapper, type Wrapper, type Record, type Json } from "./model.ts";
export { runCorpus, type CaseResult } from "./corpus.ts";
export { checkPackage, checkRecord, facetJson, foldKey, foldRecord, resolve, resolvedJson, type Outcome, type Warning } from "./dictionary.ts";
export { evaluate, parseCondition, type Truth } from "./conditions.ts";
export { checkRules, Engine, readRules, shortcutRules, type Result, type Rule, type Strength } from "./rules.ts";
export { entryHash, fieldPath, land, matchParts, readContracts, receive, sha256, validate, verifyChain, writeHash, type Contract, type IntakeRecord, type Observation } from "./store.ts";
export { checkRecipe, dryRun, readRecipes, restamp, type Recipe, type ReviewItem, type Step, type StepStats } from "./migrate.ts";
export { checkContracts, Exchange, readRoles, verifyBorder, type Role, type RunResult } from "./exchange.ts";
export { checkPackages, readPackages, type PackageInfo } from "./packages.ts";
export { AUDIENCES, checkViews, partitionOf, readViews, Views, type Projection, type ProjectOptions, type StreamEntry, type View, type ViewSet } from "./views.ts";
export { applyEntry, emptyState, rebuild, redactable, redactableWrite, redactWrite, stateJson, type Entry, type State } from "./log.ts";
export { MemoryRecords, type RecordSet } from "./records.ts";
export { arrive, decide, surviving, type Arrival, type ArrivalStore } from "./arrival.ts";
export { apply, archive, attach, detach, effective, emptyStore, foldUp, issue, issuersFor, merge, ownedKeys, pending, readInstructionBlocks, unarchive, type Instruction, type Store } from "./lifecycle.ts";
export { Access, checkPermissions, foreign, MODES, readAccess, VERBS, type Edge, type Effective, type MenuItem, type Mode, type Permissions, type Preset } from "./access.ts";
export { isSchedule, nextTick, readSchedule, ticksDue, type Schedule } from "./schedule.ts";
export { bundleHash, bundleOf, classJson, contractJson, emptyParsed, kindJson, parsePackage, printBundle, readBundle, readBundleInto, readBundleOnto, recipeJson, ruleJson, signBundle, verifyBundle, viewJson, type Parsed } from "./bundle.ts";
export { classify, publish, type Change, type PublishOptions } from "./publish.ts";
export { formOf, type FormOptions } from "./forms.ts";
