# @cruba/crubal

The CRUBAL reference implementation. Pure functions, JSON in and JSON out, so a compiled core can replace
the internals later behind the same API.

**Level reached: Store** (spec chapters 1–6 and 8–10).

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

It passes `corpus/reader*`, `corpus/dictionary*`, `corpus/rules*` and `corpus/store*` (61 cases).

Store also checks Ed25519 signatures against the owner's published key, replays intake records from their
kept bytes (deterministically, keeping earlier outcomes), reviews unknown and new values by key across all
records and proposes candidate facets by recurrence, keeps non-UTF-8 payloads as base64, and lands values by
the package's own trust order and facets' orders.

```sh
npm test                                   # unit tests and the Reader corpus
node bin/crubal.ts test ../../corpus --level store   # the corpus runner, case by case
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
| `src/corpus.ts` | the conformance runner (13) |

Next: the Exchange level (contracts, offer and take, signatures across owners).
