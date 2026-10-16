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

A `rules/` case MAY hold a `now.txt`: the moment `now` means in its conditions (chapter 6.3).

`rules/` results are compared by kind: for every result kind a case lists (`complete`, `filled`, `derived`,
`flagged`, `incomplete`, `refused`, `held`, `completeness`), the set of (record, address) pairs of that kind
must match exactly, and each listed field must be equal. Kinds a case doesn't list aren't compared.

`store/` cases hold a `log.json` and `expected-verify.json` (does the chain check out, and where does it
break), or a record, an `intake.json` and the `expected.json` record after it lands. Intake cases add a
`contract.crubal`, an `answer.json` and `expected-intake.json`; evidence cases add `observations.json` and
`expected-validation.json`. Signed-chain cases add a `keys.json` (the owner's published public key, from
`store/_keys.json`); a chain case without one checks links only. Replay cases add `contract-v2.crubal` and
`expected-replay.json`; an observations case with `expected-proposal.json` instead of `expected-validation.json`
checks the version splits proposed at the package's threshold (9.7.3); a restamp case with `expected-dry-run.json` instead of `expected.json` checks what the
recipe would do per step without doing it (10.4); review cases add `intakes.json` and `expected-review.json`; raw-byte cases add
`answer.bin` and `expected-raw.json`. `tools/` holds the generators for cases that need real hashes or
signatures. Migration cases add a `recipe.crubal` and expect the restamped data plus its
`review` queue; `store-errors/` holds recipes a publish must refuse. `package-errors/` holds packages a
publish must refuse (chapter 11.5). `views/` cases project a view over `_records.crubal` and expect
`expected-projection.json` or, with a `pick:`, `expected-counts.json` (with `nested` when a filter has dependents). `exchange/` cases add `run.crubal` (which contract runs on
which record), an optional `answer.json` (what the other side sent back) and `expected-run.json`. A
`run.crubal` may hold several runs in order, each `run:` with `on:`, and optionally `caller:` and `offer:`;
`write: ID` with indented values changes a record between runs. The runner names each run's log entry
`L-R1`, `L-R2` …, in order. The send split (docs/design/runs.md): `prepare:` with `on:` does steps 1–3 and
starts the run; `acted: L-Rn` and `failed: L-Rn` (with `reason:`) finish it; `undo: L-Rn` runs the
reversing contract naming its cause; a `run:` with `for-run: L-Rn` is a late answer that closes that run. Offer-and-take cases add the presenter's record as `presenter.json`; border cases
hold a signed wrapper in `border.json`, the presenter's key in `keys.json` and `expected-border.json`.

`forms/` cases (Exchange level; 7.7, docs/design/index-and-forms.md) hold definitions, a form contract and
records in `input.crubal`, a `form.crubal` read like `run.crubal` (`form:` names the contract, `record:` and
`caller:` belong to it; several `form:` lines give several forms), an optional `access.crubal` so editability
follows edges and gates, an optional `arrival.json` (a held arrival whose candidates the form offers), and
`expected-form.json`: the form as data, exactly.

Lifecycle cases (`ops.crubal`) also take `adopt: ID -> address`, `give-back: ID -> address`, `clone: ID -> NEW
[owner: …]` (8.2; `expected-flag.json` says which should rule flagged an adoption), `decide: <key>` with the
decision's fields indented below it (9.5, 11.9, 14.7, 10.4: `facet:<key>`, `contract:<name>`,
`unit:<spelling>`, `suggestion`, `held`), `split: A -> B` with `children:`, `values:` and `bindings:` below it (1.12; a `bindings.json` beside the
case seeds the bindings and `expected.json` may check them), and the scaffolding `suggest: ID` and `hold: ID` (address, value,
origin, via; address, rule) that leave a record as a gated run or a changed verdict would. A take run names its `offer:` and may name a `presenter: <file>.json` beside the default
`presenter.json`; `give: <offer>` runs the owner's own offer; `expire: <moment>` sweeps taken values past
their terms (7.8). An exchange `run.crubal` takes `decide-run: L-Rn` with `decision: retry|drop` (runs.md).

A views case with `expected-jsonld.json` projects the core `crubal:jsonld` shape (12.5).

### Cases for the backbone chapters

- **Rebuild (8.5.3):** a `store/` case with `log.json` and `expected-state.json` rebuilds the state from the
  log alone and compares every member the expectation names (`records`, `edges`, `bindings`,
  `instructions`, `runs`, `installed`, `definitions`, `reviews`, …). Links aren't checked by this case; `prev` may be a placeholder.
- **Arrival (9.2a):** a `store/` case with `contract.crubal` (with `ref`), `answers.json` (an array of
  payloads, or `{"level", "answers"}`; an answer `{"decide": {"record": ID}}` or `{"decide": {"new": true}}`
  decides the last held arrival) and `expected-arrival.json` (one object per answer, compared as a subset:
  `outcome`, `record`, `candidates`, `by`, `ref`). An optional `expected.json` lists records to compare
  after the sequence. Minted records are named `P-NEW1`, `P-NEW2` … by the level's initial.
- **Lifecycle and instructions (1.7, 1.12, 10.7):** a `store/` case with `ops.crubal`, operations in order:
  `archive: ID [reason: …, into: …]`, `unarchive: ID`, `merge: LOSER -> SURVIVOR`, `attach: LOWER -> UPPER
  [edit: no]`, `detach: ID`, `instruct: ISSUER` with instruction lines indented under it, `apply: ID`, and
  `write: ID` with values indented under it. `expected.json` lists the records to compare (canonical form,
  status, alternatives and suggestions included) and may list the `review` queue.
- **Access (chapter 14):** an `exchange/` case with `access.crubal` (contracts, `permissions:`, `edge:`
  blocks), an optional `now.txt`, and `ask.crubal`: `may: CALLER VERB TARGET on RECORD`, `mode: CALLER on
  RECORD`, `stands: CALLER PARTITION… on RECORD`, `gated: CALLER on RECORD`, `ancestors: RECORD`, `audience:
  CALLER`.
  `expected-access.json` holds one `{"ask", "result"}` per question. An `exchange-errors/` case whose
  input holds `permissions:`, `ownership:` or `edge:` blocks checks the declarations, every record's owner
  and every edge in order, and expects the refusal at the given line; a record's refusal names the line of
  its header.
- **Redaction (8.5.2):** a `store/` case with `log.json` and `expected-redact.json`: for each entry, by its
  `log` id, `"redactable"` when it may go whole, the reason when nothing in it may (witnessed), else one
  answer per write. A redacted write is `{"redacted": "sha256:…"}` in place; rebuild and chain cases
  (033, 034) cover an erasure inside the entry that created the record.
- **The border and access (7.4, 14.4, 14.7):** an `exchange/` run case may add `access.crubal`; the border
  then needs the caller's `run` item (a run stops at `permission`), lands a receive run as suggestions when
  the caller's access is gated (`landed`, `gated`, `reviewer` on the result), and an `arrive: CONTRACT`
  run (with `level:`, `caller:`, optional `on:` for the parent and `answer:` for the payload file) makes or
  finds a record and grants the caller's consumer edge when the contract names a `relation`.
  `expected-edges.json` lists edges to find afterwards, compared as subsets. Rules in a case's input run on
  what a receive or arrival lands (7.4 step 6): a value a `must` rule won't have comes back as a
  `contradiction` citing the rule, fills and derivations show under `rules` on the result, and
  `expected-entries.json` pins the entries the runs journal. A case that defines views in
  its input may run stream contracts (12.6.2): `stream: CONTRACT` (push from the acknowledged cursor;
  with `caller:` and `cursor: view=seq` a pull), `ack: CONTRACT` with `cursor: view=seq`, and
  `revise: VIEW /VERSION` to start a view's stream over. A scheduled contract (7.11) is ticked with
  `tick: CONTRACT` and `now: MOMENT`; the result lists the ticks run, the ticks skipped and each run.
- **Partitions and the stream (12.6):** a `views/` case may add `access.crubal`; `callers:` are then served
  only the rows their edges match, and rows carry `ancestors`. A case with `write.crubal` and
  `expected-stream.json` (entries carry `buckets`, and `sort` and `pin` when the view orders or pins, 12.7) compares the stream entries of the first publish and of the publish after the
  write.

## Passing a case

For a case with `expected.json`, a Reader passes when all three hold:

1. reading `input.crubal` gives JSON whose canonical form (chapter 3.9) equals the canonical form of
   `expected.json`;
2. printing that JSON in full mode and reading the print gives the same canonical form;
3. reading `expected.json` and printing it gives text that reads to the same canonical form.

Layout, quoting and comment choices never decide a pass: only the pairs are compared.

For a case with `error.txt`, a Reader passes when it refuses the input and names the given line. The wording
of the message is free.

A case's `input.crubal` MAY start with definitions (facets, classes, rules) that apply to that case only; the
data part begins at the `crubal:` header line.

## Writing a case

- One idea per case, named for it.
- Use the shared `_package.crubal` and `_facets.crubal` where they fit. Definitions only one case needs go at
  the top of that case's input.
- The owner is `test.example` and the package is `test`, so the corpus stays independent of any adopter.
