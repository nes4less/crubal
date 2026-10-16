# @cruba/crubal

The CRUBAL reference implementation. Pure functions, JSON in and JSON out, so a compiled core can replace
the internals later behind the same API.

**Level reached: Views**, every chapter of the spec (1–14). Conformance claim: `CRUBAL 2 · Views · corpus 2026-10-15`.

- **Reader:** the text form and JSON both ways, facet types, unknown keys kept exactly, plain-words refusals
  with line numbers.
- **Dictionary:** full definitions, publish checks on facets and classes, resolution by meet, alias and unit
  folding, value checks against facets and worn classes.
- **Rules:** rule blocks and facet shortcuts, publish checks (layered by address, no contradictions, one
  spelling), and an engine that runs writes in order: refused, held, filled (including a failing gate's
  `-`), derived (templates with `??` and `?`, rollups), flagged, incomplete, complete and completeness, with
  value-state tests and global uniqueness.

- **Store:** hash-linked logs with redaction, intake through receive contracts (map, value maps, aliases,
  shapes, ignore, keep-raw; raw bytes and their hash kept), landing by the trust order with alternatives,
  matching parts before minting rows, evidence validation (independent witnesses, vetoes, version-split
  proposals), and migration recipes with restamping and a review queue.

- **Exchange:** contract publish checks (parts per kind, defined facets, real values in value maps,
  credentials as names only), runs in steps (`who` with roles, needs, map out with nested paths, value maps
  and literals, act once per payload), receive runs that compare with the record and land by trust or as
  suggestions, offer and take where only the overlap flows and a person's values are never overridden,
  border wrappers verified against the presenter's key and its log, and package checks (prefixes, trust
  entries, extending without changing).

- **Views:** shapes as maps into slots (addresses, aggregates over lower levels, templates, required
  slots), views with selection, context (`of`), pins, hides, order and pages, filters as sub-indexes with
  range and value buckets and counts that follow the other picks, indexable landing pages, audiences and
  `shown to` rules (new and unknown values never public), roles that narrow an audience, the portable shape,
  and read sets that decide which rows a write makes stale.

- **The backbone (chapters 1.12, 8.5, 9.2a, 10.7, 12.6, 14):** the log as effects, rebuild from the log
  alone, `define` writes for the working package, and the journal that makes entries the only way state
  changes (`log.ts`); arrival with bindings and strong and weak keys (`arrival.ts`); folded and owned keys
  with attach, detach, archive, merge and instructions (`lifecycle.ts`); owners, edges, modes, the grantor
  chain, permission menus, gates and emergency access (`access.ts`); partitioned views, the projection
  stream and stream subscriptions with cursors and resets (`views.ts`, `exchange.ts`); the record set every
  module reads through, so a backend that loads only what an operation needs can stand in for the memory
  one (`records.ts`, docs/design/store.md); a package as one JSON document, printed back to the text form so
  the text readers stay the one parser, hashed and signed (`bundle.ts`), and cut as a version with members by
  diff, the change classifier of 4.8 and 5.11 and the recipe requirement (`publish.ts`, `crubal publish`;
  docs/design/publishing.md); review decisions as writes, each one entry with the define, value or release it causes (`review.ts`); a held value
  coming back when its verdict changes again; adopt, give back, clone and split (`lifecycle.ts`); a measurement contract landing observations, the first filling an empty
  value, and the version split proposed at the threshold, never made (`exchange.ts`, `proposeSplit` in `store.ts`); hand-made lists (`select: list:` over the core facet `crubal:items`), page shapes whose slots hold
  other views run with the page's record as context, dependent counts inside a filter's buckets, further
  shapes under `shapes` and the core `crubal:jsonld` structured data for the public (`views.ts`); offer and take by the offer's mode: dump copies once, observed stores a link and no value, gathered takes
  the presenter's updates over its own earlier values and never over the consumer's, controlled copies under
  the presenter's terms (expires, reshare, revocable) and withdraws what the presenter stops giving; an
  offer builder and an expiry sweep (`exchange.ts`); a person's arrival owned `domain:id` when the package lets a person
  own that kind (14.1); dated keys, `keyFor` picking the key whose span holds an entry's moment (11.7); a form as data from a contract's needs, the record's answers and states and the caller's edges
  (`forms.ts`, docs/design/index-and-forms.md); and a border that
  consults access, journals every run, and grants a consumer's edge (`exchange.ts`).

A run applies the rules (7.4 step 6): a value a `must` rule won't have is parked as a contradiction citing
the rule and never lands, a `suggest` fills and a derivation lands with `origin: derived` and the rule as
its `via`, a changed verdict holds, and each is a logged effect.

It passes every corpus folder (183 cases). The corpus and this package name no adopter and no third party:
`test.example` owns the data, `market:` stands for any marketplace, `bench` for any in-house tool, and
product, unit and the like are the test package's own kinds, never the core's.

Store also checks Ed25519 signatures against the owner's published key, replays intake records from their
kept bytes (deterministically, keeping earlier outcomes), reviews unknown and new values by key across all
records and proposes candidate facets by recurrence, keeps non-UTF-8 payloads as base64, and lands values by
the package's own trust order and facets' orders.

```sh
npm test                                   # unit tests and the Reader corpus
node bin/crubal.ts test ../../corpus --level views   # the corpus runner, case by case
node bin/crubal.ts read data.crubal --defs facets.crubal
node bin/crubal.ts print data.json --defs facets.crubal [--plain]
```

Needs Node 23.6 or later (it runs the TypeScript directly).

| File | Does |
|---|---|
| `src/tree.ts` | lines, comments, indentation, the pair separator (chapter 2.1) |
| `src/lex.ts` | quoting, details and short lists (2.5–2.7) |
| `src/defs.ts` | what the Reader needs from definitions: types, how many, units, rows, levels (4.2, 4.5, 11.2) |
| `src/read-text.ts` | text to the JSON form (2, 3) |
| `src/print-text.ts` | the JSON form to canonical text (2.9) |
| `src/canonical.ts` | canonical JSON with sets sorted (3.9) |
| `src/dictionary.ts` | definitions as JSON, publish checks, resolution, folding, value checks (4, 5) |
| `src/conditions.ts` | conditions with three-valued empties (6.3) |
| `src/units.ts` | a starter units table, until the standard units package exists |
| `src/rules.ts` | rules, shortcuts, rule-set checks and the write engine (6) |
| `src/store.ts` | logs, receive contracts and intake, landing and trust, part matching, evidence (8, 9) |
| `src/migrate.ts` | migration recipes, checks and restamping (10) |
| `src/exchange.ts` | contract checks, runs, offer and take, borders (7, 8.5.1) |
| `src/packages.ts` | package files: prefixes, trust entries, extending (11) |
| `src/views.ts` | shapes, views, filters, audiences and roles, projections and staleness (12) |
| `src/corpus.ts` | the conformance runner (13) |

Next: make the repo public, publish `@cruba/crubal`, and start crubal.com.
