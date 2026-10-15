# 9. Intake and evidence

Everything that arrives from outside, whether a catalog answer, an import, a scan, an OCR reading or
another owner's data, comes in through **intake**. Intake keeps what arrived, folds it into facets, and says
what happened to every field. **Evidence** is intake from a real instance: it validates values instead of
just supplying them.

## 9.1 Every object arrives through a receive contract

- Data enters only through a contract of kind `receive`, `form` or `take` (chapter 7). A one-time dump or
  legacy data gets a minimal receive contract of its own.
- **The raw payload is kept forever**, as its exact bytes with their hash, in an **intake record** (chapter
  3.8). It is never parsed and re-serialized for storage.
- Every field of the payload gets exactly one **outcome** (9.3), recorded on the intake record.

## 9.2 The fold

A payload is folded in a fixed order. Rules run only on the result.

1. **The contract's map** (chapter 7.3): fields to addresses, and value maps.
2. **Aliases** (chapter 4.3): key aliases and value aliases fold to real names.
3. **Shapes**: the value is read by its facet (chapter 1.4), from the text form's spellings (chapter 2.4) and
   the units table's spellings of each unit (`97 MIN.` is `97min` when the table lists `MIN.`).

A value that no step can make fit is not changed: it goes to step 4 as it is, and the check reports it.

**Rows and parts are matched before they are minted.** Incoming rows of a compound, and incoming parts, bind
to existing ones in this order: by identity child; else by the fold key of the declared `match` child
(chapter 1.6); else, when the record already holds rows that could be the same, the row goes to review
instead of becoming a new row. A contract MAY propose a consolidation ("disc hub" and "inner tray" are one
part); it lands as a suggestion. Re-deriving the same record MUST NOT grow its rows by renaming them.

4. **Check** each value against its facet (chapter 4.9), its worn classes (chapter 5.3.1) and the `must`
   rules it touches (chapter 6).

## 9.2a Arrival: finding the record

The fold works on a record, so a payload that doesn't name one must find or make one first. A run that names
its record (`for`) skips this.

**The source's own ID.** A receive or take contract declares which field of the payload is the other side's
own ID for the thing (`ref: epid`, chapter 7.2). The store keeps a **binding** for every pair of contract and
reference it has decided: `(ebayCatalog, 110245563)` is `P-4QX7`.

**Resolving.** In this order, at the level the payload arrives at:

| Step | When | Outcome |
|---|---|---|
| 1 | the reference is already bound | **bound**: it goes to that record |
| 2 | a strong key (`identify`, chapter 11.2) matches one active record | **matched**: it goes there, and the binding is kept |
| 3 | weak keys (`match`) find candidates, or strong keys find several | **held**: nothing is minted; the payload waits in review with its candidates |
| 4 | nothing matches | **new**: a record is minted, and the binding is kept |

- **A review decision is a binding.** "This one", "a new record" or "these two are the same" is saved against
  the reference, so the same thing arriving again goes straight to its record. Nothing is decided twice.
- **Minted at commit.** A record is minted only when the arrival commits. A form left unsaved, or a pick that
  is never confirmed, leaves nothing behind.
- **A person decides on the spot.** In a form, the candidates are shown to the person, and their choice is the
  review decision.
- **Archived records are never candidates** (chapter 1.12).

**Levels.** A payload for a lower level resolves its own record first, then its parent the same way. A parent
that resolves to one record is attached (chapter 1.7). No parent, or candidates only, is not a reason to
hold: the record is minted standing alone, and the candidates are kept as a suggestion to attach.

The intake record carries the arrival's outcome and the binding it used, as `arrival` (chapter 3.8).

## 9.3 Outcomes

| Outcome | When | What happens |
|---|---|---|
| **absorbed** | it fits | it lands, with its source |
| **new** | a choice value the list doesn't hold yet (open or closed list) | it lands, marked new, and goes to vocabulary review |
| **conflict** | it fits, and disagrees with the current value from another source | the trust order picks the current value; the other is kept as an alternative (chapter 8.4) |
| **contradiction** | it can be shown impossible | it is parked beside the facet with its citation; the record doesn't change |
| **unknown** | no facet for the field | it stays on the intake record, or is carried under a prefix (9.4) |
| **ignored** | the contract says skip it | it stays on the intake record only |

**A contradiction must cite what it contradicts**, exactly one of:

- `type`: the facet, when the value can't have its shape, is off a fixed list, or holds more values than
  `pick` allows (review then offers both fixes: the data or the definition);
- `rule`: a `must` rule the value would break;
- `value`: another value on the same record that it can't stand beside;
- `global`: a global rule and the other record (a duplicate GTIN).

A value the vocabulary lacks is growth, not a contradiction. Off-list values contradict only a fixed list.

**Landing with a flag.** A value outside a `should` range or length, or less precise than the facet
wants, lands and is flagged. A value more precise than the facet keeps lands cut to what it keeps, and the
intake record keeps the rest.

**Comparing.** Agreement and conflict compare values by the facet's `agree-by` (chapter 4.2): "The Secret of
NIMH (DVD)" and "Secret of NIMH" can agree under a title normalizer while the stored value stays one real
title.

**Agreement.** A value equal to the current one is absorbed; the current source stays (its origin never
changes), and the log records the second source.

## 9.4 Bypass

| Part | Scope | Effect |
|---|---|---|
| `absorb: no` | the whole contract | nothing folds: every field is recorded as `ignored`, and the payload is kept for later review and replay |
| `ignore: a, b` | fields | those fields are `ignored` |
| `keep-raw: a, b` | fields | those fields are carried onto the record as raw values (chapter 1.4.10), each under the contract's `prefix` and its last field name: with `prefix: market`, `aspects.Studio` becomes `market:Studio` |

A `keep-raw` field whose last name isn't a valid key name (chapter 1.3) must be mapped explicitly instead
(chapter 7.3). A contract that uses `keep-raw` MUST declare `prefix`.

## 9.5 Review

Review works **by key across all objects**, never object by object: `market:Studio`: 40,112 objects, 812
distinct values.

- A review decision changes a contract's map or the vocabulary (add a value, add an alias, map a value,
  reject a value). It never edits objects directly.
- After a decision, the held intake records are **replayed** (9.6), and the objects change through the fold
  like any other intake.
- New and unknown values are searchable by staff and never shown in customer filters or pages.
- AI may propose mappings. It never applies them. A review item shows the deterministic evidence (the
  mechanical match, the fold collision, the counts) beside any AI recommendation, so a reviewer can check
  one against the other.
- **Candidates.** Proposed vocabulary lands as a `candidate` facet or class (chapter 4.1), never active.
  Candidates are matched against active vocabulary only.
- **Promotion by recurrence.** A notable key (chapter 1.6) or unknown key seen on enough distinct records (a
  package threshold, `recur:`, default 5) is proposed as a candidate facet. Below the threshold it stays a
  one-off.

## 9.6 Replay

Replay is not rebuild (chapter 8.5.3): rebuild restores the past exactly from the log; replay does new work
under today's definitions.

Replaying an intake record runs the fold again, from its kept bytes, with the current maps, vocabulary and
rules. Replay is deterministic: the same bytes under the same versions give the same outcomes.

- Each replay records its outcomes and the versions it used on the intake record, beside the earlier ones.
- Replay lands values with the original source's origin and a new log entry. The trust order applies as
  usual, so replay never overrides a person's or an adopted value it would lose to.

## 9.7 Evidence and observations

An **observation** is not a value. A value is the current answer for a record. An observation is a claim
made on one instance, backed by evidence, that supports or contradicts a value.

```
evidence       a photo, a scan, a disc read, a scale or measure-grid reading   (origin: observed)
  → measurement  a receive contract (OCR, barcode, vision, the grid)   with lands: observation
  → raw reading  kept forever, as an intake record
  → fold         the same fold (9.2): "97 MIN." becomes runtime 97min
  → observation  on that instance, supporting a value on the record it belongs to
```

A measurement contract declares `lands: observation` and `evidence: <type>` (`photo`, `scan`, `disc-read`,
`scale`, or a type the package names). Its outcomes produce observation documents (chapter 3.8), not
writes, each naming its `evidence-type`.

### 9.7.1 Support goes up

An observation is made on an instance (a unit) and supports the value where it is stored (usually the
product). This is the third flow along the version relationship: **values flow down, rollups go up, and
support goes up.** Parts work the same way.

- If the value is empty, the first observation fills it, with origin `observed` and the measurement's run as
  its `via`, as long as the trust order lets an observation fill it.
- Otherwise the observation counts for or against the current value.

### 9.7.2 Validation

| State | When |
|---|---|
| **confirmed** | at least *n* independent observations agree with the value (*n* is per package, default 2), and nothing vetoes it |
| **contradicted** | an independent observation disagrees; this is a conflict (9.3), and the observed value is an alternative |
| **unobserved** | the value is declared or reported only |

**Independence** counts instances and evidence types, not runs: two photos of one unit are one witness, and
a photo and a disc read of one unit are two. Re-measuring the same evidence replaces its earlier reading; the
raw readings all stay for replay.

Rules decide what confirmation is worth. A package MAY rank `observed` above `declared` for physical facts
(runtime, weight, the barcode).

### 9.7.2a Vetoes

Evidence can say a value is **not** true. A receive contract or an observation MAY **veto** a value
(`format is not DVD`: "Media Storage / DVD Racks" means a rack, not a disc) or a class (5.5).

- A vetoed value can't become confirmed and can't win consensus; a value already current becomes
  contradicted, citing the veto.
- A veto counts as an independent witness like any observation. An observation document carries `veto`
  (the value it denies) in place of `value`.
- A veto that targets nothing current is kept, and blocks that value until a person overrides it.

### 9.7.3 Version splits

When a consistent cluster of independent observations agrees with itself and disagrees with the value (at
least *k* instances, *k* per package, default 3), the instances are probably a different version. The engine
**proposes** a new product or fork with those instances under it. It never splits on its own.

### 9.7.4 Learned patterns

A pattern learned from many readings (this OCR layout means this studio) is a proposed map or alias. It goes
through review (9.5) like any other.

## 9.8 Any kind

Evidence works for any kind of thing: an ID document gives a person's name, an invoice gives a service's
lines, end credits give the cast of a Work, a meter photo gives a reading.
