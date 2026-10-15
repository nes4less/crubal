# Runs with a real act: the send split

**Status:** design, 2026-10-15; ruled. Spec 7.4 and 7.5 say a run acts once and is logged; today the border
logs `acted` the moment it maps out, because nothing acts. With a host performing the act (host.md), a send
is two entries with the act between them. This document fixes the entries, the payload's keeping, retry,
failure and late answers, and the corpus cases that prove them.

## The entries

| Step | Entry | Run write | Else in the entry |
|---|---|---|---|
| 1–3: permission, needs, map out | **started** | `{run, contract, record, key, state: "started", payload: "sha256:…"}` | nothing: no value changed yet |
| 4: the host acts | (no entry while acting) | | |
| 4 succeeded | **acted** | `{run, contract, record, key, state: "acted", at}` | nothing |
| 4 failed | **failed** | `{run, contract, record, key, state: "failed", reason, attempt}` | nothing |
| 5–6: the answer | the receive run's own entry, `by: {contract, run}` with the **same run** | `{run, …, state: "closed"}` | the values that landed, as any receive |

- **The idempotency key** (7.5) is logged at `started`, so a host that restarts between `started` and
  `acted` finds the run and asks the adapter whether it acted (an adapter MAY answer by the key it was
  given) instead of acting again; an adapter that can't say leaves the run `failed` with reason `unknown`
  for a person.
- **The payload is kept beside the log**, not in it (ruled): a run write holds only its hash. The mapped-out
  payload goes to an `outtake` table (the mirror of `intake`: owner, run, contract, record, bytes, hash,
  type) so it can be shown, replayed to the adapter on retry, and **erased**: a shipping label's address
  must not live in an unredactable run write. `erase` covers outtake rows as it covers intake rows.
- **Nothing between `started` and `acted` is a transaction.** The act is the world's; the store holds a
  run in `started` and nothing else changes. Views don't see runs.

## Retry

`retry: N every D` (7.5): after `failed`, the host schedules the next attempt at `at + D` and retries up to
N times, each attempt a `failed` or `acted` entry with its `attempt` number, re-reading the payload from
outtake (never re-mapping: the record may have changed, and the key is the payload's hash). With no
`retry`, one attempt.

**After the last attempt** (ruled): the run stays `failed` and a **review item** is opened,
`{key: "run:<contract>", run, record, reason}`, grouped by contract across records like every review (9.5),
so a dead printer shows once with its forty runs, not forty times. A person's decision is `retry` (a new
run, new key if the record changed, else the same key with the old runs' attempts behind it) or `drop`
(the run stays `failed`, the item closed).

## Late answers and callbacks

(ruled) **The run ID travels with the act.** The adapter puts it where the partner will return it: a
reference field of the payload when the contract maps one (`"{run}" -> clientReference`), else a header or
idempotency header the adapter knows for that system. An answer that comes back later, by callback or by
polling, names the run; the host feeds it to `receive` for that run, which lands it against the run's
record with `via` that run's entry (7.5 "late answers"). An answer naming no run the store knows is intake
with arrival `held` and goes to review; it is never guessed onto a record.

## Undo

`undo: <contract>` names the reversing contract (7.5). Running it is an ordinary send on the same record,
with `cause: <run>` in its run write so the pair is visible; the engine never assumes reversibility and
never runs an undo on its own.

## What changes in the engine

- `Exchange.run` splits: `prepare(name, record, caller)` does steps 1–3 and returns the payload and the
  `started` write; `acted(run)` and `failed(run, reason, attempt)` write the rest; `receiveRun` takes an
  optional run to close. The memory border keeps a one-call `run` that does all three with a no-op act, so
  today's corpus stays green.
- `PgBorder.send` becomes: `prepare` in one transaction (keeping the payload in outtake), the adapter outside
  any transaction, then `acted` or `failed` in another. A host loop retries `failed` runs whose next attempt
  is due.
- The store gains `outtake` and erases it with intake.

## Corpus cases (exchange/)

| Case | Proves |
|---|---|
| `send-started-acted` | a send is two entries; the first holds the key and the payload's hash and nothing else; the second `acted`; the run's state reads `acted` |
| `send-failed-retry` | three attempts under `retry: 3 every 10m`, each an entry with its attempt; the payload isn't re-mapped between them |
| `send-dead-review` | after the last attempt a review item `run:<contract>` exists, grouping two records' dead runs |
| `send-restart-once` | a `started` run with no `acted` is not acted again: the adapter is asked by key |
| `late-answer-by-run` | an answer naming the run lands on its record with `via` the run; one naming no run is held |
| `undo-cause` | an undo run names its cause |
| `send-erased` | after `erase`, the run writes stand and the outtake row is gone |
