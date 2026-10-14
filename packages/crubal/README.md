# @cruba/crubal

The CRUBAL reference implementation. Pure functions, JSON in and JSON out, so a compiled core can replace
the internals later behind the same API.

**Level reached: Reader** (spec chapters 1–3): reads and prints the text form, converts to and from JSON,
applies facet types from definitions, keeps unknown keys exactly, and refuses bad input in plain words with
a line number. It passes `corpus/reader/` and `corpus/reader-errors/`.

```sh
npm test                                   # unit tests and the Reader corpus
node bin/crubal.ts test ../../corpus       # the corpus runner, case by case
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
| `src/corpus.ts` | the conformance runner (13) |

Next: the Dictionary level (aliases, classes, value checks).
