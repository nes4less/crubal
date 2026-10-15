# The persistent store

**Status:** design, 2026-10-15. Not part of the specification: how a store keeps its data is not part of
conformance (spec chapter 13.6). This is the design of one conforming store, the one crubal.com ships.

## What it is

The engine in `packages/crubal` conforms at the Views level, in memory, against the corpus. Everything it
holds vanishes when the process ends. The persistent store is the same engine with its log, records,
definitions and projections kept in a database, so a store survives restarts, holds real volumes, serves
many owners, and can be rebuilt from its log alone.

It is CRUBAL-side infrastructure with no notion of a tenant plan, a shop or a sign-in. A host (Cashierfu,
or anyone's) runs owners' stores on it, does authentication, holds secrets and attaches packages.

## The calls

1. **Postgres**, plain SQL, nothing a managed Postgres lacks. No Supabase-specific feature in the store;
   a host may run it on Supabase, Neon, RDS or a laptop.
2. **One database, many owners.** Every table is keyed by `owner`: a domain, or a hosted person's
   `domain:ID`, who is an owner with a chain of their own (spec 14.1). Isolation is the store's query
   discipline; a host MAY add row-level security on top, and the schema is laid out so it can.
3. **The engine's state becomes an interface.** Today `State` is a set of maps. It becomes a `Backend`
   with two implementations, `memory` (what exists) and `postgres`. The corpus runs against both: the
   Postgres backend conforms when it passes the same cases the memory backend passes, which is the proof
   that the database changed nothing. All rule, fold, access and view logic stays in `packages/crubal`,
   pure, and runs the same over either backend.
4. **A package of its own**, `packages/crubal-postgres`, so `crubal` keeps no database dependency.
5. **The log is the truth; every other table is a cache.** `rebuild` empties an owner's state tables and
   applies the log in order, and MUST reproduce them exactly (spec 8.5.3). Nothing is stored that the log
   cannot give back, except what the spec says is kept beside it: raw intake bytes, observations.
6. **Search is not the store's job.** Pages, counts, full-text search and caching belong to an index that
   reads the projection stream (spec 12.6.1). The store answers by key, by selection and by condition, and
   publishes the stream.

## Tables

All owner-scoped: every table's primary key begins with `owner`. JSON columns hold the spec's JSON form
unchanged, so what the database holds is what the border carries.

| Table | Holds | Notes |
|---|---|---|
| `chains` | `owner`, `chain`, `head_seq`, `head_hash` | one row per chain; locked by a writer for the length of one entry |
| `log` | `owner`, `chain`, `seq`, `log_id`, `prev`, `hash`, `at`, `by`, `intake`, `source`, `writes`, `crubal`, `witnessed`, `sig` | append-only; the one update allowed is redaction (below) |
| `records` | `owner`, `id`, `kind`, `level`, `of`, `within`, `ancestors[]`, `status`, `applied`, `wears[]`, `created`, `updated`, `doc` | `doc` is `{values, parts, sources, alternatives, suggestions, held}`; GIN index on `doc->'values'`; `ancestors` is the lookup spec 14.2 requires |
| `record_keys` | `owner`, `level`, `facet`, `key`, `record` | one row per value of a facet that is `unique`, `identify` or `match`; `is unique` and arrival resolve here with an index, never a scan |
| `definitions` | `owner`, `member`, `name`, `json`, `retired`, `since` | the working package, built from `define` writes (spec 11.4) |
| `installed` | `owner`, `package`, `version`, `bundle`, `at` | published packages the owner pins; the standard packages are installed like any other |
| `edges` | `owner`, `edge`, `who`, `relation`, `mode`, `on`, `grants[]`, `where`, `until`, `gate`, `reviewer`, `by`, `json`, `removed` | live-ness is computed (grantor chain, `until`, `where`), never stored |
| `bindings` | `owner`, `contract`, `ref`, `record` | arrival bindings (spec 9.2a) |
| `instructions` | `owner`, `issuer`, `n`, `json` | pending-ness is computed against `records.applied` |
| `review` | `owner`, `item`, `key`, `json`, `decided` | the queue, grouped by `key` (spec 9.5) |
| `runs` | `owner`, `run`, `contract`, `key`, `state`, `json` | unique on `(owner, contract, key)`: the idempotency key (spec 7.5) |
| `cursors` | `owner`, `contract`, `view`, `version`, `audience`, `seq` | an index's acknowledged position (spec 12.6.2) |
| `schedules` | `owner`, `contract`, `last_tick` | the last tick run (spec 7.11) |
| `intake` | `owner`, `intake`, `contract`, `received`, `for`, `raw` (bytea), `sha256`, `type`, `outcomes`, `arrival`, `replays` | the bytes as received, forever (spec 9.1) |
| `observations` | `owner`, `obs`, `on`, `supports`, `json` | evidence (spec 9.7) |
| `reads` | `owner`, `log_id`, `record`, `who` | reads under an emergency edge (spec 14.13) |
| `projections` | `owner`, `view`, `version`, `audience`, `record`, `row`, `buckets`, `marks`, `ancestors[]`, `seq` | one row per selected record (spec 12.6) |
| `projection_stream` | `owner`, `view`, `version`, `audience`, `seq`, `record`, `row` or `removed`, `reset` | append-only; what index contracts carry |
| `stale` | `owner`, `view`, `record`, `since` | rows awaiting a rebuild; filled inside the write transaction, drained outside it |

## The write path

One entry is one database transaction (spec 8.5):

1. Begin. Lock the owner's chain row (`SELECT … FOR UPDATE`). Writers to one chain serialize here; readers
   never block, and other chains never wait.
2. Load what the action needs: the records it touches and reads through, the definitions in force, the
   caller's edges and the records' ancestors, the keys an `is unique` or an arrival must check.
3. Run the engine, unchanged: fold, rules, access, lifecycle. It produces the entry's writes, or a refusal.
4. A refusal rolls back and nothing is written, not even the attempt (a refused write is not a result,
   spec 6.9).
5. Insert the entry with its `prev`, `hash` and `seq`; apply its writes to the state tables with the same
   `applyEntry` logic the memory backend uses; update `record_keys` and `ancestors`; insert `stale` marks
   for every view whose read set the entry touched (a mark is a row, so the write's cost doesn't grow with
   the number of views, spec 12.6).
6. Commit. The host signs the entry's hash with the owner's key before step 5 when it holds one.

What the engine needs in step 2 is the `Backend` interface: a small set of loads (records by ID, by key,
by selection; definitions; edges by caller and by record; bindings; instructions by issuer; runs by key)
and one apply. The memory backend answers them from its maps; the Postgres backend from the tables.

## Reads

- A record by ID is one row. A view's selection is a query over the envelope columns (`kind`, `level`,
  `wears`, `status`, `within`, `ancestors`) and key equality through the GIN index; the `when` condition
  runs in the engine over the rows that come back. Which conditions compile to SQL is an implementation
  choice that never changes a result (spec 13.6); the first version compiles the envelope and key equality
  and leaves the rest to the engine.
- A partitioned view's rows are served by the index from the stream; the store never answers a page.

## Projections

A **projector** drains `stale` outside any write transaction: it recomputes each marked row with the
engine, upserts `projections`, and appends one `projection_stream` entry, numbered per view and audience.
`fresh: write` runs the projector as soon as the write commits (`LISTEN`/`NOTIFY` on commit); `fresh: 5m`
lets it batch. A new view version writes `reset: true` first and starts its numbering over. Index contracts
(spec 12.6.2) read the stream from their cursor; a push run is the projector's last step for `when: entry`.

## Rebuild, redaction, erasure

- **Rebuild** truncates an owner's state tables and applies the log in `(chain, seq)` order, through the
  same `applyEntry`. It then marks every view stale, so projections follow. It needs no package outside
  the log (`installed` and `definitions` are rebuilt from `install` and `define` writes).
- **Redaction** is the one update the log table allows: a write replaced by `{"redacted": "sha256:…"}`,
  or an entry reduced to its hash (spec 8.5.2). A trigger refuses every other update and every delete.
  After a redaction, the record's rows are marked stale and the state tables are rebuilt for that record
  from its chain, so the cache forgets what the log forgot.
- **Erasure** is `redact` over every value write that holds a person's data; the store offers it as one
  command that finds those writes by record and address.

## Hosted persons

A hosted person is an owner: `owner = domain:ID`, their chain in `chains`, their records in `records`,
exportable and erasable by the `owner` key alone. The host signs their chain until they publish a key.

## Operations

`crubal-postgres` ships a command with: `migrate` (the schema, versioned; a store names its schema version
beside its language version), `rebuild <owner>`, `verify <owner>` (links and signatures), `project`
(drain `stale`), `tick` (run due schedules), `redact`, `erase <owner> <record>`, `export <owner>`.

## Testing

The corpus runs against the Postgres backend when `CRUBAL_PG_URL` is set (a local Postgres 17 is enough),
and skips it otherwise. Each case runs in its own schema, created and dropped around it, so cases never
see each other and a run leaves nothing behind. The two backends MUST give the same canonical output for
every case; a difference is a bug in the Postgres backend until shown otherwise.

## Not in this version

Sharded chains (one chain per owner for now; the schema already names the chain), row-level security (the
host's), read replicas, full-text search (the index's), and any table for a host's own concerns.
