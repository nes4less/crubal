# 10. Migrations

Stored data is always current. When a definition changes in a breaking way (chapter 4.8, 5.11), the new
package version ships a **recipe**, and every store **restamps** its data with it. Nothing inside a store
carries a version, and nothing is translated on read.

## 10.1 The rules

- A breaking change MUST ship a recipe in the same package version (chapter 11).
- A store MUST restamp before it accepts data written under the new version.
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
| `review` | `review: condition` | values where the condition holds go to the review queue | yes |
| `recompute` | `recompute` | produced values (rollups, derivations) are rebuilt by the new rules | no |
| `retype` | `retype: text -> choice` | a facet's values are read under its new type; values that fit land, the rest go to review | the leftovers |

A key never renames: keys are identity (chapter 4.1). A new label is not a migration. Moving values to a new
key is `move`.

## 10.4 Restamping

Restamping applies a recipe to everything a store holds for the package:

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
5. Every breaking change between the two versions (chapter 4.8) is covered by a step.

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
    { "facet": "languages", "review": "count of languages over 2" },
    { "facet": "condition", "recompute": true }
  ]
}
```
