# @cruba/crubal-postgres

The persistent CRUBAL store on Postgres: the log as the truth, every other table a cache rebuilt from it.
The design is in [docs/design/store.md](../../docs/design/store.md); this package is its first version.

## What it does

- **One owner, one chain, one `PgStore`.** `commit(by, mutate, at?, extra?)` runs an operation on a draft
  of the owner's state, turns what changed into one entry, applies it with the engine's own `applyEntry`,
  persists the difference and appends the entry, all in one transaction with the chain row locked. A
  refusal rolls everything back. `append(entry)` takes an entry made elsewhere and links it the same way.
- **The schema** (`src/schema.sql`) is the design's tables, every one keyed by owner. The log table's only
  update is redaction; a trigger refuses every other update and every delete.
- **`rebuild()`** empties the owner's state tables and applies the log again. **`verify(keys?)`** checks
  the chain's links and signatures. **`redact(logId, writeIndex?)`** replaces one write by its hash, or
  an entry by its hash (spec 8.5.2), then rebuilds, so the cache forgets what the log forgot.
- **Nothing in here decides anything.** Folding, rules, access, lifecycle and views are `@cruba/crubal`'s
  and run unchanged; this package loads a working set, persists a difference and keeps the chain.

## Proof

`test/pg.test.ts` runs against a real Postgres when `CRUBAL_PG_URL` is set (a local Postgres 17 is
enough: `CRUBAL_PG_URL=postgres:///postgres npm test`), in a schema of its own that it drops afterwards,
and is skipped otherwise. It checks that every corpus log rebuilds to the same state in Postgres as in
memory, that journaled operations (attach, merge, archive with cascade) write the same entries as the
memory journal and leave the same state, that redacting a write keeps the chain valid and the rebuilt
state without the value while the trigger refuses any other change, and that owners never see each other.

## The working set

An operation runs over a working set that loads as it is needed (`src/working.ts`). The engine is
synchronous and pure, so the operation runs on a set that answers what it has and notes what it lacks (a
record by ID, the records at a level, a record's children, a `for`'s targets, the holders of a key, a
binding, a run); the store loads what was lacking and runs the operation again on a fresh copy, until a
run asks for nothing new. Edges, instructions and definitions are loaded whole, being small. The entry's
application settles the same way, so an attach among sixty records loads the two it touches and their
neighbours, never the sixty. `store.trace` says what the last operation loaded. An operation passed to
`commit` MUST therefore be a pure function of the draft it is given: it may be run more than once.

## Projections and the stream

A store given `projecting: { dict, views, perms? }` marks, inside each write's transaction, the rows the
entry made stale: for every record it changed, in every view, what the engine's `staleAfter` names, worked
out on the state before the entry (`src/projector.ts`). `project(view?, audience?)` publishes outside any
write transaction: the first time (and after a new version) it rebuilds every row, afterwards only the
marked ones, through the engine's `Views` over a working set that loads what the view reads; it compares
them with the stored projection, appends one stream entry per row that changed or left, numbered per view
and audience, and clears the marks. `entriesSince(view, seq)` is what an index reads from its cursor.
With `fresh: "write"` every commit publishes as soon as it returns. The test replays the corpus stream case
(views/010) and the erasure removal (views/013) and gets the memory `Views.stream` entries byte for byte.

## The border

`PgBorder` runs contracts over the store (`src/border.ts`): each run builds the engine's `Exchange` over
the commit's draft, with the store's edges, its run count and the keys it has acted on, so a run is one
entry and never acts twice across restarts. `receive` and `arrive` keep the intake record with its bytes
and hash in the `intake` table; `send` acts at most once per contract, record and payload; `streamRun`
reads the projection stream from the store's tables since the index's cursor (or the caller's), refuses a
view above public to a party without `run`, and logs each batch as a run; `ack` keeps the cursor;
`tick` runs a scheduled contract's due ticks from the `schedules` table, each keyed by contract and
tick. `store.erase(record)` redacts every value write to a record across the log and leaves its shell.

## The command

`bin/crubal-pg.ts`, with `CRUBAL_PG_URL` set: `migrate`, `rebuild <owner>`, `verify <owner>`,
`export <owner>`, `redact <owner> <log> [<write>]`, `erase <owner> <record>`, `project <owner> --defs
<file>…` and `tick <owner> <contract> --now <moment> --defs <file>…`.

## Installing, and definitions from the store

`store.install(bundle, keys)` takes a published version (docs/design/publishing.md): it refuses an unsigned
bundle unless the store allows them for development, a bundle whose hash or signature doesn't verify, a
language version above the store's, and a bundle whose `extends` aren't installed at their pinned
versions; it checks the definitions that would result with every publish check; then it writes one
`install` entry, keeps the bundle in `bundles`, and, when an earlier version of the package was installed,
restamps every record through the bundle's recipes from that version, each write `by: migration`, and
leaves every view to be rebuilt. `store.define(member)` is the owner's own change: checked with the rest,
then one `define` write. `store.definitions()` builds what the engine runs with from the installed bundles
in order and then the define writes, cached per chain head; the projector and `PgBorder.over(store)` take
their dictionary, views, contracts and permissions from it, so nothing is handed in any more except in
tests.

## Sends with a real act

A send over the store is two entries with the act between them (docs/design/runs.md): `prepare` logs
`started` with the idempotency key and the payload's hash, the payload itself kept in `outtake`; the
contract's adapter (`adapters: { [contract]: (contract, payload, run) => … }`, host code, never a
package's) acts outside any transaction; then `acted` or `failed` with its attempt. A run still open
(`started`, or `failed` with attempts left under `retry`) is seeded into every fresh border from the runs
table, so a restart never acts twice and `retry(run)` acts again from the kept payload without re-mapping.
After the last attempt a review item `run:<contract>` opens. An answer the adapter brings back closes the
run as a receive with `via` that run; `undo(run)` runs the reversing contract naming its cause; `erase`
takes the record's outtake rows with its values.

## Review decisions and replay

`store.review()` lists the open items; `store.decide(decision, by)` makes one as one entry (the review
write with the define, value or release it causes), then replays every kept intake the decision reaches (a
facet's new value, a contract's unknown field, a unit's spelling), each its own entry `by: migration:
replay`, superseding what that intake landed before and leaving the rest to the trust order. A `units`
define feeds the owner's extension into the units table in force (one owner per process for now). A dead
run's `retry` releases its key, so a fresh border sends the payload again.

## Not yet here

The host: authentication, secrets, named adapters, signing, the loops and the HTTP surface
(docs/design/host.md); forms as data (docs/design/index-and-forms.md).
