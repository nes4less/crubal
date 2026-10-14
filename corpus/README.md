# The CRUBAL test corpus

A conformance claim (spec README, "Conformance levels") is proven by passing that level's folders here. The
corpus is part of the spec: when a case and a chapter disagree, one of them is a bug and gets fixed.

## Layout

```
corpus/
  reader/            cases every Reader must pass
    _package.crubal  the kinds and levels the cases use
    _facets.crubal   the facet definitions the cases use (shorthand facet lines)
    001-scalars/
      input.crubal   text in
      expected.json  the data it must read to
  reader-errors/     input a Reader must refuse
    e01-tab-indent/
      input.crubal
      error.txt      line number, then a short description of the error
  dictionary/        cases every Dictionary-level implementation must pass
    _facets.crubal   the definitions the data cases use
    _classes.crubal  the classes the class cases use
    001-…/
      input.crubal   definitions or data in
      long.crubal    (definition cases) the same definitions in the long form
      expected.json  the definitions (JSON, chapter 4.6) or the folded data it must read to
      expected-outcomes.json  (check cases) the outcome for each address (chapters 4.9, 5.5)
    a `resolve: Class` input expects the resolved class lines (chapter 5.4)
  dictionary-errors/ definitions a package publish must refuse
  rules/             cases every Rules-level implementation must pass
    _facets.crubal · _rules.crubal   the facets and rules every case runs under
    001-…/
      input.crubal   records written, in order
      write.crubal   (optional) a later write to those records, read like input
      expected-results.json  the rule results after the last write (chapter 6.9)
  rules-errors/      rule sets a package publish must refuse
```

Later levels (`store/`) follow the same layout. `exchange/` cases add `run.crubal` (which contract runs on
which record), an optional `answer.json` (what the other side sent back) and `expected-run.json`.

## Passing a case

For a case with `expected.json`, a Reader passes when all three hold:

1. reading `input.crubal` gives JSON whose canonical form (chapter 3.9) equals the canonical form of
   `expected.json`;
2. printing that JSON in full mode and reading the print gives the same canonical form;
3. reading `expected.json` and printing it gives text that reads to the same canonical form.

Layout, quoting and comment choices never decide a pass: only the pairs are compared.

For a case with `error.txt`, a Reader passes when it refuses the input and names the given line. The wording
of the message is free.

## Writing a case

- One idea per case, named for it.
- Use the shared `_package.crubal` and `_facets.crubal`; add facets there, never per case.
- The owner is `test.example` and the package is `test`, so the corpus stays independent of any adopter.
