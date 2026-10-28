# 10. Migrations

Stored data is always current. When a definition changes in a breaking way (chapter 4.8, 5.11), the new
package version ships a **recipe**, and every store **restamps** its data with it. Nothing inside a store
carries a version, and nothing is translated on read.

## 10.1 The rules

- A breaking change MUST ship a recipe in the same package version (chapter 11).
- A store MUST restamp before it accepts data written under the new version.
- **Restamp or pend.** A step that changes the shape or meaning of stored values (10.3) restamps. A change
  to which keys lower records are projected (a `level::` line added or removed, chapter 5.3.3) is an
  instruction (10.7): it pends per record and never blocks the store.
- **Mapping on read is banned.** A store MUST NOT serve data at a version other than its own by translating it
  as it is read. Everything it serves is current.
- At a border, the wrapper names the package version the data was written under (chapter 3.8). A receiver
  on a newer version restamps incoming data on intake, with every recipe between the two versions, in
  order. A receiver on an older version MUST NOT guess: it holds the intake until it upgrades.
- Recipes are published with the package, so any adopter can restamp their own data.

## 10.2 A recipe

```crubal
migration: me /2026-10-13 -> me /2026-11-01
  facet: videoCodec
    rename: "VC 1" -> VC-1
    merge: AVC, "H264" -> H.264
  facet: runtime
    convert: h -> min
    rounding: nearest
  facet: releaseDate
    precision: day -> month
  facet: format
    split: Blu-ray
      when: hdrFormats has -> 4K
      else: Blu-ray
  facet: audioLanguage
    move: -> audioTracks[*].language
  facet: languages
    review: count of languages over 2
  facet: condition
    recompute
```

A recipe names the version it leaves and the version it reaches, then lists **steps** grouped by facet.
Steps run in the order written, across the whole recipe, so a `move` can come before the steps that work on
its target.

## 10.3 The verbs

| Verb | Written | Does | Needs a person? |
|---|---|---|---|
| `rename` | `rename: old -> new` | a value gets a new real name; the old one MAY become an alias in the new version | no |
| `merge` | `merge: a, b -> c` | several values become one | no |
| `convert` | `convert: h -> min` with `rounding: nearest`, `down` or `up` | a number changes unit by the units table, rounded as stated | no |
| `precision` | `precision: day -> month` | dates are cut to the new precision | no |
| `split` | `split: v` with `when: condition -> new` lines and an `else` | one value becomes one of several, by a condition (chapter 6.3) on the same record | where no branch decides and there is no `else` |
| `move` | `move: -> otherAddress` | values move to another key, or into a compound's rows | sometimes (a target already holding a different value) |
| `hand` | `hand: -> owner/package` | the key is that package's now: the values stay under the same address for its definition to read; nothing moves, nothing is held. Covers a facet this version retires because another package in the dictionary declares it (chapter 11.4) | no |
| `review` | `review: condition` | values where the condition holds go to the review queue | yes |
| `recompute` | `recompute` | produced values (rollups, derivations) are rebuilt by the new rules | no |
| `retype` | `retype: text -> choice` | a facet's values are read under its new type; values that fit land, the rest go to review | the leftovers |
| `fill` | `fill: 1` with `for: unit::` and an optional `when:` beneath | records lacking the key, at the level named, where the condition holds, get the value read under the facet; a record that has one is left alone. A backfill for a key the new version adds | no |
| `parts` | `parts: -> slot` under a compound, with an optional `when:` and `child -> facet` lines beneath | the compound's rows the condition picks become parts of the slot (5.6), keyed as the rows were, wearing the slot's class, each named child read into the facet named; a row whose key the record already holds as a part is left alone; the compound stays as it was | no The step acts only on a record wearing a class that declares the slot (5.6): a record that wears none keeps its rows until it does, and the step runs for it when it does (10.4). A backfill like `fill`: a recipe of parts steps alone rides a version where nothing broke, and run again it makes nothing twice (a row without a key of its own binds to the part it made before, each taken once). |

A key never renames: keys are identity (chapter 4.1). A text facet takes a part's or a value's words whole: brackets in a name are a name, never a detail (chapter 2). A new label is not a migration. Moving values to a new
key is `move`. A key that passes from one package to another keeps its address: the package that drops it
writes `hand`, the package that takes it declares the key with the same type (chapter 11.4), and the records
notice nothing.

## 10.4 Restamping

Restamping applies a recipe to everything a store holds **for the package**: records of the kinds it defines
and records wearing the classes it defines, never another package's records that happen to hold a key of the
same name. It covers:

- record values, at every level and in every part;
- `alternatives` and `suggestions`;
- observations;
- held values (chapter 6.7).

It does **not** rewrite intake records: their raw bytes are as received, and replay (chapter 9.6) folds them
under the current version.

**Sources.** A restamped value keeps its `origin` and `owner`. Each restamp write is logged with `by:
{"migration": "<from> -> <to>"}`; one entry MAY hold many writes.

**The review queue.** `review`, an undecided `split` and a blocked `move` send items to the store's review
queue, each with the record, the address, the value, the step and the reason. **Nothing is dropped.** Until
an item is resolved, its value is held (chapter 6.7): kept, hidden, flagged with the step.

**Writes during a restamp.** A long restamp doesn't stop the store. Writes that arrive while it runs are either
folded through the recipe as they arrive, or swept again at the end; the store MUST do one or the other, and
the result MUST be the same as if every write had arrived before the restamp started.

**Dry run.** A store SHOULD be able to run a recipe without writing, reporting how many values each step
changes and how many items go to review.

## 10.5 Well-formed recipes

A package MUST be refused at publish when a recipe breaks these:

1. `from` and `to` are consecutive versions of the same package.
2. Every value a step names on its left exists in the `from` version, and every value on its right exists in
   the `to` version.
3. `convert` names units the units table can convert between.
4. A `split` either has `else` or is accepted as sending its leftovers to review.
5. Every breaking change between the two versions (chapter 4.8) is covered by a step; a facet retired is
   covered by `review`, `move` or `hand`.
6. A recipe whose steps are all `fill` or `recompute` is a backfill and MAY accompany a version where nothing
   broke; any other recipe with nothing broken is refused.
7. A class version that stops projecting a key (a `level::` line removed, chapter 5.3.3) carries the
   instruction for it (10.7): an `instructions: class:<Name>/<version>` block with `-key`, published in the
   bundle and issued when the version installs. A publish without it is refused.

## 10.6 The JSON form

```json
{
  "migration": { "from": "me /2026-10-13", "to": "me /2026-11-01" },
  "steps": [
    { "facet": "videoCodec", "rename": { "from": "VC 1", "to": "VC-1" } },
    { "facet": "videoCodec", "merge": { "from": ["AVC", "H264"], "to": "H.264" } },
    { "facet": "runtime", "convert": { "from": "h", "to": "min", "rounding": "nearest" } },
    { "facet": "format", "split": { "value": "Blu-ray",
        "when": [ { "if": "hdrFormats has", "to": "4K" } ], "else": "Blu-ray" } },
    { "facet": "audioLanguage", "move": { "to": "audioTracks[*].language" } },
    { "facet": "holdMinutes", "hand": { "to": "cashierfu.com/commerce" } },
    { "facet": "languages", "review": "count of languages over 2" },
    { "facet": "condition", "recompute": true },
    { "facet": "qty", "fill": { "value": "1", "level": "unit" } },
    { "facet": "manifest", "parts": { "to": "disc", "when": "role is core",
        "map": [ { "from": "type", "to": "partName" }, { "from": "note", "to": "printing" } ] } }
  ]
}
```

## 10.7 Instructions

A recipe changes values. An **instruction** changes which keys lower records hold: what the record above
tells the records below it when the keys it projects change (chapter 1.7). A lower record never changes
because something above it now looks different; it changes only when an instruction reaches it.

Instructions have three **issuers**, because projection comes from three places (chapter 1.7, 11.2): a
record, named by its ID, when its own `wears` change; a class version, named `class:<Name>/<version>`, when
a package publish adds or removes a `level::` line, which reaches every wearer's lower records at once; and
a kind version, named `kind:<name>/<version>`, when a package publish changes a `vary` step. An
instruction's `+key` names a key the issuer now projects, and `-key` one it no longer does; it never adds a
key nothing asks for.

**Order.** A record applies its pending instructions issuer by issuer, in a fixed order, so every store
gets the same result (chapter 13.2): the record above first, then its kind's versions, then the class
versions, each group by name and then version; within an issuer, by number.

```crubal
instructions: P-4QX7
  1: +grade
  2: -graded -> grade
       yes -> Graded
       no -> -

instructions: class:OpticalDisc/2026-11-01
  1: -sealed

instructions: kind:item/2026-11-01
  1: +colour
```

An issuer is written as it appears in `applied` (chapter 2.3): the record's ID, `class:<Name>/<version>` or
`kind:<name>/<version>`.

| Instruction | Does |
|---|---|
| `+key` | the key is projected; lower records gain it, empty (and incomplete, if required) |
| `-key` | the key and its value leave the lower record; the value stays in the log |
| `-key -> other` | the value moves to another key, with value maps written below it as in a contract's map (chapter 7.3) |

- **Numbered and pending.** An issuer's instructions are numbered in order. Each lower record's envelope says,
  per issuer, the last one it has `applied` (chapter 1.1); the rest are pending. A change above writes one
  instruction, however many records are below.
- **Applied by touch, drain or hand.** Pending instructions are applied, in order, before anything else
  touches the lower record: a form opens it, a write reaches it, a contract runs on it. A store MAY also drain
  them in the background at a rate it chooses, and a person MAY apply them to one record or many.
- **Readers see what is applied.** Until a record applies an instruction, it shows its keys as they were.
- **Archived records are skipped** (chapter 1.12). Unarchiving makes their pending instructions apply again.
- Applying an instruction is a write, logged with `by: {"instruction": "<issuer> #<n>"}`. A value that a
  value map can't place goes to the review queue and is held, as in a recipe (10.4).
- A change that stops projecting a key lower records hold values for MUST carry the instruction for it: a
  class version in its package (chapter 5.11, checked at publish, 10.5), a record in its own `wears` write.
  A bundle carries its instruction blocks (11.6); the store issues them when the version installs and
  applies them record by record.
