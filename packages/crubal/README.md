# @cruba/crubal

The CRUBAL reference implementation. Pure functions, JSON in and JSON out, so a compiled core can replace
the internals later behind the same API.

**Level reached: Dictionary** (spec chapters 1–5). The Reader reads and prints the text form, converts to
and from JSON, applies facet types, keeps unknown keys exactly, and refuses bad input with a line number. The
Dictionary adds full definitions (long form, shorthand and JSON), the publish checks on facets and classes,
class resolution by meet, alias and unit folding, and checking every value against its facet and the classes
its record wears. It passes `corpus/reader*` and `corpus/dictionary*` (33 cases).

```sh
npm test                                   # unit tests and the Reader corpus
node bin/crubal.ts test ../../corpus --level dictionary   # the corpus runner, case by case
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
| `src/corpus.ts` | the conformance runner (13) |

Next: the Rules level (strengths, productions, layering and contradiction checks).
