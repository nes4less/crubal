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

## Not yet here

Intake rows with raw bytes, cursors and schedules on their tables, the stream contract run from the
store, and the operations command. Each lands with a test of the same kind.
