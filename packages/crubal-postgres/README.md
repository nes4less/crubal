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

## This version

The working set an operation runs over is the owner's whole state, loaded at the start of the
transaction. `RecordSet` already carries the questions a loader needs (`atLevel`, `childrenOf`,
`forTarget`, `byKey`), so loading only what an operation touches is the next step, not a redesign. Not
yet here: the projector and the projection stream tables in use, intake rows with raw bytes, cursors and
schedules, the operations command. Each lands with a test of the same kind.
