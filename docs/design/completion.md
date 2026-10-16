# Completing the engine

**Status:** plan, 2026-10-15; A, B and C built (review decisions with replay, held release, adopt / give
back / clone), corpus 163. The units table is global per process: one owner's extension at a time until it
is made per dictionary. Everything the specification states that the engine, the store or the host
doesn't do yet, and nothing that depends on a kind, a vocabulary or an adopter. Each item says what it is,
how it works, what it writes, and what proves it. The coding round takes them in the order of the last
section.

## A. Review decisions (9.5, 9.6, 11.9, 14.7, runs.md)

The queue fills from six places; only an arrival's decision is an operation today. A decision is **one
entry**: the `review` write that records it, plus the writes it causes. The engine gets a pure
`decide(item, decision, state) → writes`; the store wraps it in a commit; the host's review route calls it.

| Item (`key`) | Decisions | What the entry also writes |
|---|---|---|
| vocabulary, `facet:<key>` (an unknown or new value) | `add value`, `add alias <of value>`, `reject` | a `define` of the facet with the value or alias; reject closes the item and the values stay raw |
| map, `contract:<name>` (an unknown field or value) | `map <field> -> <facet>`, `map value <theirs> -> <ours>`, `ignore` | a `define` of the contract with the line added |
| unit question, `unit:<spelling>` (11.9) | `alias of <unit>`, `new unit {dimension, factor, offset?}`, `not a unit` | a `define` of member `units`: the owner's units extension as records; the store reads it into the units table in force |
| arrival, `arrival:<contract>` (9.2a) | `record <id>`, `new`, `same as` | as today: a binding, and the arrival lands |
| gated write, `gate:<edge>` (14.7) | `accept`, `deny` | accept: the value write from the suggestion with its original source; deny: the suggestion removed, kept in the history as denied |
| migration, `migration:<step>` (10.4) | `value <v>`, `drop` | the held value written current, or removed |
| dead run, `run:<contract>` (runs.md) | `retry`, `drop` | retry: a new run from the record as it now is, the dead run's key released (`releases` on the review write), so the same payload may go again; drop closes it |
| version split, `split:<record>` (9.7.3) | `split <instances>`, `not a version` | see D |

**Replay follows a vocabulary or map decision** (9.6): every kept intake record whose outcomes hold the key
is folded again under the new definitions, each landing as its own entry `by: {migration: "replay"}`
with the original origin, under the trust order. The store finds them by key in `intake.outcomes`.

Proof: `store/` cases for each row (a held intake replaying after `add value`; a map decision landing a
field that was unknown; a unit alias folding `2.5 stone`; accept and deny under a gate; a migration's
held value chosen; a dead run retried with its key released), and the host route decided end to end.

## B. A held value comes back (6.7)

Holding is written; release isn't. When a write changes a value a holding rule reads, the engine
re-evaluates every held address of the record: a verdict that no longer holds the value releases it, a
value write `as: current` from the held bag with its original source, logged with the rule as `by`.
Proof: a `rules/` case where `format` changes from DVD to Blu-ray, `hdrFormats` held by the gate comes
back, and the entry names the rule.

## C. Adopt and give back (8.2)

Two lifecycle operations. `adopt(record, address)` writes the current value again with `adopted: true` on
its source; a `must` production refuses, a `should` flags. `giveBack(record, address)` writes it without
the mark, and the next rule run or presenter update replaces it. Adopting a whole record of another owner
is `clone`: a new record with `crubal:clonedFrom`, every value copied with its source. Proof: a `store/`
case with the three.

## D. Split, and the version split proposal (1.12, 9.7.3)

`split(record, {into: new id, children: [ids], values: {address: value}, bindings: [refs]})`: a new record
minted, the named children's `of` moved to it, the named values written on it (and removed from the
origin when they were the origin's own), the named bindings moved. The reverse of a merge is a split that
names what the merge brought. **The proposal**: after an observation lands, when at least `split` (11.1)
instances carry observations that agree with each other and disagree with the value, a review item
`split:<record>` opens listing them; the decision calls `split`. Proof: a `store/` case for the operation
and one for the proposal appearing at the threshold and not below it.

## E. `store` contracts (7.1, 7.3)

A `stores` block is both maps: read, each line is `theirField -> ourAddress` inverted; written, it is
`ourAddress -> theirField`. The reader fills `reads` and `writes` from it; the kind `store` allows it and
refuses separate `reads`/`writes`. Proof: an `exchange/` case that writes a location out and reads it
back through one contract.

## F. `frame:` on image lines (5.3.3, 5.10)

A class line tail `frame: front` kept on the line, in the JSON and in the form field; a frame on a
non-image facet refused at publish. Proof: a `dictionary-errors/` case and a `forms/` field carrying it.

## G. Hand-made lists (12.2)

A list is a record whose core facet `crubal:items` holds ordered links (added to `crubal.com/core`).
`select: list: L-1` selects those records in that order, whatever their levels; `pin`, `hide` and `order`
don't apply. Staleness: a write to the list's `crubal:items` stales every row of the view. Proof: a
`views/` case.

## H. Page shapes with nested views (12.1, 12.2)

A slot `view:<name> -> slot` holds another view's rows, projected with the page's record as `context`
(its `of:` condition). The page row carries the nested rows under the slot; the page view's read set is
the union; a write that changes what the nested view selects for a page record stales that page row (the
projector asks the nested view, per page record, whether the written record is or was among its rows).
The index serves the page row whole. Proof: a `views/` case with a product page holding "also on other
formats", and its stream after a sibling arrives.

## I. Dependent facets in filters (12.3, 11.2 `follows`)

A filter with `dependent: label` counts the dependent facet's buckets inside each of its own: the
projection row's `buckets` gains the dependent facet's values, and counts carry
`nested[filter][bucket][dependent][value]`. The index does the same arithmetic. Proof: a `views/` counts
case.

## J. Structured data and machine shapes (12.1, 12.5)

The core shape `crubal:jsonld`: for a record, a JSON-LD object with `@context` schema.org, `@type` from
the kind's schema per level (11.2), and one property per facet with a `same-as` in the `schema:` prefix,
values as plain text (quantities with unit, money as `price` and `priceCurrency`, links as `@id`), the
public audience only. A view MAY name it beside its card shape; the index serves it at
`?shape=crubal:jsonld`. Proof: a `views/` case with `expected-jsonld.json`.

## K. Offer and take between hosts (7.8, 8.5.1)

- **The offer**, served by the presenter's host at `GET /o/<owner>/offer/<contract>`: the records the
  contract's `for` selects, the facets its `gives` lists, each with its source, the signed log entries
  those values came from, the `mode` and `terms`, as a border wrapper (3.8). `to:` decides who: `public`
  to anyone; `followers` and named parties by the caller's edges or signed request; `link` by a token the
  owner mints (`POST …/offer/<contract>/link`), unpublishing revokes it, republishing keeps it; `private`
  to nobody.
- **The take**, run by the consumer's host: `host.take(owner, contract)` fetches the presenter's offer
  with a signed request, verifies the wrapper against the presenter's keys (`verifyBorder`), and runs the
  engine's `take`: `dump` and `gathered` copy with sources, `controlled` copies under the presenter's
  terms, `observed` stores a link only. The consumer's entry names the presenter's entry (8.5.1).
- **Terms**: `expires` puts an `until` on the taken values' sources and the loop re-takes or removes
  them; `reshare: no` keeps them out of the consumer's own offers; `revocable` lets the presenter's
  withdrawal remove them at the next take.
Proof: `exchange/` cases for each mode and term; a host test with two owners on one host taking from each
other.

## L. Pushing a stream (12.6.2)

A stream contract with `when: entry` is run by the loop after each publish: the entries since the cursor
are POSTed to the contract's `host:url` (or to `to:`'s host at its `stream` inbox), the index's 2xx
acknowledges them. Proof: a host test with a fake endpoint receiving the batches and the cursor moving.

## M. Hosted persons as owners (14.1)

A run that creates a record of a kind or class the package's `ownership` lets a person own, for a person
caller, writes it with owner `<domain>:<caller>` into **that person's chain**: the store opens the hosted
owner's chain in the same transaction (two chain rows locked, in a fixed order), and the host makes the
owner, with its key, on the first such write. The person exports and erases their own data as its owner
(`/o/<domain>:<id>/export`, `…/erase`). Proof: an `exchange/` case where a collection arrives owned by
its person; a host test exporting it as the person and finding nothing of it in the host's chain.

## N. Key rotation (8.5, 11.7)

`host.rotateKey(owner)`: a new key signs from now; the well-known file lists the old with `until` and
the new with `from`; `verifyChain` picks the key whose span holds the entry's `at`. Proof: a store test
verifying a chain across a rotation and refusing an entry signed with the retired key after `until`.

## O. Operations

`GET /health` (database reachable, each owner's chain head); request body limits; one structured log line
per request (owner, caller, route, status, ms); a CORS allowlist option; credentials behind a `SecretStore`
interface with the table and an environment implementation, a vault to follow; a container (`Dockerfile`,
a compose file with Postgres) as the first deployment shape, with a smoke script that migrates, makes an
owner and runs the host test suite against it. The serverless adapter waits for ME's wiring, as ruled.

## P. Background work the design named

`crubal-pg drain <owner>`: apply pending instructions at a rate; the host loop publishes views with
`fresh: <delay>` on that interval; sharded chains stay deferred (the schema already names the chain).
`retype` restamps by re-reading each value under the new type, the rest to review; `crubal-pg restamp
--dry-run` reports counts per step without writing.

## Q. The MUST audit (13.4)

A pass over every MUST in chapters 1–14, each mapped to the case that tests it in `corpus/COVERAGE.md`;
a case written for every MUST without one. Mechanical, and the last proof the release gate asks for.

## R. Performance

A benchmark script over a store of 100,000 records and 500 units each for 200 products: commit of an
attach, a receive, a publish of one view after one write, an index page with two picks and a search.
Targets: a commit under 50 ms, a page under 100 ms. What misses is fixed (the first suspects: a view
selecting by `all()` where `atLevel` serves, and projection publish loading more than the stale rows).

## S. Conformance tooling (13.3)

`crubal claim <corpus>` runs the levels and prints `CRUBAL 2 · <level> · corpus <tag>`; the corpus is
tagged `corpus/<date>` in git at each dated revision; the claim is written to `packages/crubal/CLAIM.md`.

## Calls made here

- A hand-made list is a record with the core facet `crubal:items` (G).
- The structured-data shape is the core's `crubal:jsonld`, public only (J).
- Dependent counts nest under the filter's own bucket (I).
- A person-owned record is written into the person's chain in the same transaction, the owner made on
  first write (M).
- A container is the first deployment shape; serverless when ME wires (O).

## The order of the coding round

1. A (review decisions and replay), B, C: the operations that make the queue and the log complete.
2. E, F, P's `retype` and dry run: the small spec gaps.
3. D: split and the proposal.
4. G, H, I, J: what a consumer page needs from views.
5. K, L: exchange between hosts and the stream push.
6. M, N: hosted persons and key rotation.
7. O, P's drain and timers: operations and the container.
8. Q, R, S: the MUST audit, the benchmark, the claim.
