// @cruba/crubal: the CRUBAL reference implementation. Pure functions; JSON in, JSON out.

export { CrubalError, readTree } from "./tree.ts";
export { readDefinitions, emptyDictionary, type ClassDef, type Dictionary, type Facet } from "./defs.ts";
export { readText } from "./read-text.ts";
export { printText, type PrintMode } from "./print-text.ts";
export { canonical, serialize } from "./canonical.ts";
export { checkWrapper, parseJson, type Wrapper, type Record, type Json, type JsonObject } from "./model.ts";
export { decide as decideReview, openItems, unitsExtensionText, type Decision } from "./review.ts";
export { extendUnits, resetUnits } from "./units.ts";
export { runCorpus, type CaseResult } from "./corpus.ts";
export { checkPackage, checkRecord, facetJson, foldKey, foldRecord, resolve, resolvedJson, type Outcome, type Warning } from "./dictionary.ts";
export { evaluate, parseCondition, type Truth } from "./conditions.ts";
export { checkRules, Engine, readRules, shortcutRules, type Result, type Rule, type Strength } from "./rules.ts";
export { entryHash, fieldPath, keyFor, land, matchParts, proposeSplit, readContracts, receive, sha256, validate, verifyChain, verifySig, writeHash, type Contract, type IntakeOutcome, type IntakeRecord, type Key, type Keys, type Observation } from "./store.ts";
export { checkRecipe, dryRun, readRecipes, restamp, type Recipe, type ReviewItem, type Step, type StepStats } from "./migrate.ts";
export { checkContracts, Exchange, readRoles, verifyBorder, type Role, type RunResult, type Offer } from "./exchange.ts";
export { checkPackages, readPackages, type PackageInfo, type Utility } from "./packages.ts";
export { STANDARD_PACKAGES, standardDefinitions } from "./std-packages.ts";
export { AUDIENCES, checkViews, partitionOf, readViews, shownAudience, Views, visibleTo, type Nested, type Projection, type ProjectOptions, type ShownFor, type StreamEntry, type View, type ViewSet } from "./views.ts";
export { applyEntry, diffWrites, differs, emptyState, Journal, rebuild, redactable, redactableWrite, redactWrite, stateJson, type Draft, type Entry, type State } from "./log.ts";
export { MemoryRecords, type RecordSet } from "./records.ts";
export { arrive, decide, surviving, type Arrival, type ArrivalStore } from "./arrival.ts";
export { apply, archive, attach, detach, effective, emptyStore, foldUp, issue, issuersFor, merge, ownedKeys, pending, readInstructionBlocks, unarchive, type Instruction, type Store } from "./lifecycle.ts";
export { Access, checkPermissions, foreign, MODES, readAccess, VERBS, type Edge, type Effective, type MenuItem, type Mode, type Permissions, type Preset } from "./access.ts";
export { isSchedule, nextTick, readSchedule, ticksDue, type Schedule } from "./schedule.ts";
export { bundleHash, bundleOf, classJson, contractJson, emptyParsed, kindJson, parsePackage, printBundle, readBundle, readBundleInto, readBundleOnto, recipeJson, ruleJson, signBundle, utilityJson, verifyBundle, viewJson, type Parsed } from "./bundle.ts";
export { classify, publish, type Change, type PublishOptions } from "./publish.ts";
export { formOf, type FormOptions } from "./forms.ts";
