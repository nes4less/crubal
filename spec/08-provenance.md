# 8. Provenance and logs

Every stored value says where it came from (chapter 1.9). This chapter says how sources are assigned, how
ownership moves, how disagreements are kept, and how the full history lives in each owner's signed log.

## 8.1 Origin

`origin` records how a value was first established, and it never changes.

| Origin | Means | Assigned by |
|---|---|---|
| `observed` | read off a real instance | a contract whose `origin` is `observed` (a form at the bench, OCR of a photo, a scale) |
| `declared` | its maker or a person said so | a form (the default), a maker's feed |
| `derived` | a rule computed it | the engine, for fills, derivations and rollups (chapter 6.4) |
| `reported` | a catalog says so, origin unknown | a receive contract (the default) |

- A value that arrives with its own source (from another owner's data, chapter 7.8) keeps that source's
  `origin`. Otherwise it takes the contract's.
- **Rule or contract?** A value that can be produced again from the record's own values, with the same
  answer, is `derived` by a rule; it can be dropped and rebuilt. A value that can't (AI text, a price from
  comparables, a drawn SKU) came through a contract, carries that contract's origin, and is irreplaceable, so
  it is kept.
- A migration never becomes a value's origin or owner (8.6).

## 8.2 Owner and adopting

`owner` is who controls a value now. It changes in one way: **adopting** (✎, "made your own"). The same verb
works at every scale.

| You adopt | From | Then |
|---|---|---|
| a produced value, by editing it | a rule | the value stops following the rule; the source gains `adopted: true` |
| another owner's value | that owner | `owner` becomes you; `origin` stays theirs; their later changes arrive as suggestions |
| another owner's whole record | that owner | a new record of yours, with `crubal:clonedFrom` linking the original |

- An adopted value doesn't update until it is **given back**: removing the adoption returns it to following
  its rule or its presenter, and the next run or update replaces it.
- A presenter's `terms` may forbid adopting (chapter 7.8). Then a consumer's edit is refused.
- Strength limits adopting a produced value (chapter 6.2): `must` forbids it, `should` flags it.

## 8.3 Link, copy, adopt

| You hold | Readable on its own? | Updates? | Owner |
|---|---|---|---|
| a link | no: it's their current value while they're reachable | always theirs | them |
| a copy | yes, self-contained | by the mode (chapter 7.8) | them, until adopted |
| an adopted copy | yes | no; their changes arrive as suggestions | you |

A copy is always self-contained: it holds the values and their sources, so it reads without the original.

## 8.4 Trust and alternatives

When two sources disagree about a value (a **conflict**, chapter 9), the **trust order** picks the current
value. The trust order is per package (chapter 11); by default a person comes first. A facet MAY override it.

The losing values are kept, in the record's **`alternatives`**, keyed by address like `sources`:

```json
"alternatives": {
  "title": [
    { "value": "National Lampoon's Christmas Vacation", "origin": "reported", "via": "L-55ZT" }
  ]
}
```

Each alternative is a value with its full source. An alternative becomes current only by a person's choice
or a change in the trust order, and the value it replaces becomes an alternative in turn. **Suggestions**
(values that `land: suggestion`, chapter 7.5) are kept the same way, in `suggestions`.

Sources stay hidden when printing in plain mode (chapter 2.6), and so do alternatives and suggestions.

## 8.5 The log

Each owner keeps a **log**: an append-only list of entries, one per write, however many values the write
touched (chapter 3.8 gives the JSON).

- **Hash-linked.** An entry's **hash** is the SHA-256 of its canonical form (chapter 3.9) without `sig`.
  `prev` is `sha256:` and the previous entry's hash, in hex. The first entry of a chain has no `prev`.
- **Signed.** `sig` is the owner's Ed25519 signature over the entry's hash (its 32 bytes, not the hex
  text), written as base64url without padding, made with the key published for the owner's domain (chapter
  7.8). A redacted entry carries no `owner`; it is checked against its chain's owner. When the owner's key is
  known, an entry without a valid `sig` breaks the chain there.
- **Chains.** An owner MAY keep several chains, each linear (one per shard of a large store); every entry
  then names its `chain`. A record's writes MUST all go to one chain.
- **No consensus.** There is no mining and no global ledger. Every record has an owner, and the owner's log is
  the truth for the owner's data. Anyone holding entries can check the links and signatures.

**The log records effects, not causes.** An entry says exactly what changed in the stored state, so the state
can be rebuilt from the log alone (8.5.3). Why it changed is linked, not re-derived: the intake record, the
run, the rule or the recipe.

**What an entry holds:** `log` (its ID), `prev`, `chain` (when there are several), `owner`, `at`, `by`
(exactly one of `person`, `contract` with `run`, `rule`, `migration`, `instruction` or `take` with the
presenter's entry), `intake` (when the write came through intake), `source` (the default source of its
value writes: `origin`, and `owner` and `adopted` when they apply; `via` is the entry itself), `writes`, and
`sig`.

Each write is one of these:

| Write | Names | Effect |
|---|---|---|
| **value** | `record`, `address`, `value` or `"removed": true`, `as`, and `source` when it differs from the entry's | `as` says where the value lands: `current` (the default), `alternative`, `suggestion` or `held` |
| **envelope** | `record` and one `envelope` member: `created`, `of`, `within`, `wears`, `status`, `applied` | the record's envelope (chapter 1.12) |
| **edge** | the edge (chapter 14.3), or its ID and `"removed": true` | access and relations; a lapse it causes down the grantor chain is computed, not written |
| **observation** | the observation document (chapter 3.8) | it is kept, beside the record it supports |
| **binding** | `contract`, `ref`, and `record` or `"removed": true` | an arrival binding (chapter 9.2a) |
| **review** | the item, and its `decision` or `"opened": true` | the review queue (chapters 9.5, 10.4) |
| **instruction** | `record`, its number and the instruction | the record's instructions (chapter 10.7) |
| **run** | `run`, `contract`, its idempotency key and `state`: `started`, `acted`, `failed`, `closed` | the run's state (chapter 7.5) |
| **install** | the package identity and version | the store's package; the restamp that follows is its own entries |

What can be computed from the log and the package versions it installs is never logged: completeness and the
other rule results (chapter 6.9), projections (chapter 12.6), and whether instructions are pending.

### 8.5.1 Values that crossed a border

When a value comes from another owner, the consumer's entry says so: `by` is `{"take": "catalogTake",
"from": "distributor.example/L-91AC"}`. The value keeps its origin, and the presenter's entry can be checked
against the presenter's own log.

### 8.5.2 Redaction

A hop can be hidden without breaking the chain. A **redacted entry** keeps only `log`, `prev`, `chain`,
`sig` and `"redacted": "sha256:…"`, the hash of the full entry. Its hash is that value, so the next entry's
`prev` still matches and the signature still verifies. Redaction is how private hops are shared and how data
is erased when the law requires it.

### 8.5.3 Rebuild and replay

Two different things, never to be confused:

- **Rebuild** applies the log's entries, in order, to an empty store. It needs no rules, no contracts and no
  engine of a particular version, and it MUST give exactly the state the store had. A store MUST be able to
  rebuild; the state it keeps is a cache of the log. Rebuilding from a log with redacted entries gives the
  state without what they held, which is what erasure means.
- **Replay** (chapter 9.6) folds kept intake records again under the *current* definitions. It is new work,
  and it writes new entries.

## 8.6 Migrations and history

A migration's write gets its own log entry, with `by: {"migration": "<recipe>"}`. It never changes a
value's `origin` or `owner`: a person's renamed value is still the person's, with the migration in its
history.

Values written before an owner kept a log (legacy data) get one entry for the whole backfill, with `by:
{"migration": "backfill"}`. Their `origin` is what is known about them, and `reported` when nothing is.

## 8.7 Read-through values

Values read through from an upper level or a shared part carry no source on the lower record. Their source
lives where they are stored, and the log entries are the upper record's.

## 8.8 Record members added by this chapter

Chapter 3.2's record gains two optional members:

| Member | JSON | Present |
|---|---|---|
| `alternatives` | object: address → array of `{value, origin, via, owner?}` | when a conflict left a losing value |
| `suggestions` | the same shape | when values landed as suggestions |

and the source object (chapter 3.7) gains `adopted: true`.
