# @cruba/crubal

The CRUBAL reference implementation. Pure functions, JSON in and JSON out, so a compiled core can replace
the internals later behind the same API.

**Level reached: Rules** (spec chapters 1–6).

- **Reader:** the text form and JSON both ways, facet types, unknown keys kept exactly, plain-words refusals
  with line numbers.
- **Dictionary:** full definitions, publish checks on facets and classes, resolution by meet, alias and unit
  folding, value checks against facets and worn classes.
- **Rules:** rule blocks and facet shortcuts, publish checks (layered by address, no contradictions, one
  spelling), and an engine that runs writes in order: refused, held, filled (including a failing gate's
  `-`), derived (templates with `??` and `?`, rollups), flagged, incomplete, complete and completeness, with
  value-state tests and global uniqueness.

It passes `corpus/reader*`, `corpus/dictionary*` and `corpus/rules*` (44 cases).

```sh
npm test                                   # unit tests and the Reader corpus
node bin/crubal.ts test ../../corpus --level rules   # the corpus runner, case by case
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
| `src/corpus.ts` | the conformance runner (13) |

Next: the Store level (sources and signed logs, intake with raw bytes, migrations).
