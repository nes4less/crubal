# 5. Classes

A **class** says what a kind of thing asks for: which facets, in what order, at which level, and how much
narrower than the dictionary allows. A record **wears** classes (chapter 1.1, `wears`), and the classes it
wears decide what its forms ask, what counts as complete, and which catalogs it belongs to.

A class never says what a facet *means*: type, the full list of values and other names belong to the facet
(chapter 4). So a class and the dictionary can't disagree about a facet; a class can only ask for less.

## 5.1 Identity

A class is named like a key (chapter 1.3), by convention with a capital first (`OpticalDisc`), and written
with its owner's prefix outside its own package (`me:OpticalDisc`). Class names and facet keys are separate
namespaces. Classes are versioned like facets (chapter 4.1).

## 5.2 The long form

```crubal
class: OpticalDisc
  label: Optical disc
  describe: A film or show released on a disc.
  for: item
  uses: VideoRelease
  facets:
    format{DVD|Blu-ray|4K|HD-DVD}          // narrows the dictionary's format
    videoCodec
    !runtime                                // required for this class
    section: Audio
    audioTracks
    unit::discCondition
  version: 2026-10-13
```

| Setting | Holds | Default |
|---|---|---|
| `label` · `describe` | the name people see · what it's for | the name, split at capitals · none |
| `for` | the kinds that may wear it | every kind |
| `uses` | other classes this one is built from, in order (5.4) | none |
| `facets` | class lines (5.3), in order | required |
| `version` | the dated version | required when published |

A setting key with a prefix is a package setting, carried unchanged (as in chapter 4.2).

## 5.3 Class lines

Each line under `facets` names a facet and, optionally, narrows it and places it. A class line is written in
the shorthand's marks (chapter 4.5), read the same way, with three differences:

1. **The facet must already exist.** A class line names a facet from the dictionary; it never defines one.
   A bare key (`videoCodec`) asks for the facet as it is.
2. **A type mark narrows.** When a line carries a type mark, it MUST be the facet's own type, and every
   setting on it MUST be narrower than or equal to the facet's (5.3.1).
3. **A line may be prefixed with a level** (`unit::discCondition`), and may carry placement settings
   (5.3.2).

### 5.3.1 Narrowing

| On the line | Means | Narrower when |
|---|---|---|
| `!` | required for wearers | always (it adds a `must` rule) |
| `{a\|b}` | only these values | every value is in the facet's list, written in its real name |
| `$80` | at most 80 characters | ≤ the facet's `length` |
| `*2`, or no count on a many-valued facet | at most two values; one | ≤ the facet's `pick` |
| `1..300` | this range | inside the facet's `range` |
| `@ym` … | these precisions | a subset of the facet's |
| `#min` | this unit | equal to the facet's `unit` (a class can't change a unit) |
| `+worst` … | combine rule | equal to the facet's; a class may restate it, never change it |

Each narrowing expands to a rule for wearers of the class (chapter 6): values `in` the list, `under` the
length, and so on, with the same strengths as the facet's shortcuts (chapter 4.4): narrowing values and
`pick` is `must`, length and range are `should`.

A line MUST NOT set a facet's meaning: `label`, `ask`, `describe`, `aliases`, `same-as`, `values` with
aliases, `fixed`, `ranked` or `type`.

### 5.3.2 Placement

Placement says where and when a facet is collected. It never changes a value.

| Placement | Written | Means |
|---|---|---|
| order | the order of the lines | the order forms and pages show the facets in |
| section | a `section: Name` line | the lines after it, until the next section, are shown under that heading |
| level | `unit::` before the key | the facet **varies** at that level for records wearing this class: it is collected there and stored there (chapter 1.7) |
| frame | `frame: front` on an image facet's line | which photo slot the image fills |

The level prefix names a level of the wearer's kind. It declares a vary step in addition to the kind's own
`vary` declarations; it never stops a facet from varying where the kind says it does.

## 5.4 Composition with `uses`

A class is built from other classes by `uses`. There is no inheritance and no overriding: the result is the
**meet** of everything used, so a class can only ask for the same or less.

To resolve a class:

1. Resolve each class it uses, in the order listed, then take its own lines last.
2. Collect every facet that appears anywhere. A facet appearing more than once **meets**: values intersect,
   `pick`, `length` and precisions take the narrowest, ranges intersect, and `required` is set when any
   line sets it.
3. **Placement:** a facet takes the position and section of its *first* appearance, so narrowing a used
   facet never moves it. Levels from every appearance apply.
4. A class used twice along different paths counts once.

A publish MUST be refused when `uses` forms a cycle, or when a meet is empty (two used classes allow no
common value of a facet).

## 5.5 Wearing

- Every record wears its kind's **base class**, whether or not `wears` lists it.
- A record MAY wear any number of other classes, in order. The worn set resolves exactly like `uses` (5.4):
  the record asks for the meet of everything it wears, in `wears` order.
- A write that makes a record wear a class whose `for` doesn't include the record's kind MUST be refused.
- A write that makes a record wear classes whose meet is empty for some facet MUST be refused: no value of
  that facet could satisfy them all.
- **Lower levels read the wears above them.** A unit wears its product's classes and its own; it MUST NOT
  shed a class worn above.
- **Owned parts wear their own classes** (`wears` on the part), resolved separately from the whole's.

**Incomplete.** A required facet with no value (absent or unknown) makes the record **incomplete** for the
class that requires it. Incomplete is a state of the record, not an intake outcome; chapter 6 defines it with
the rest of the rule results.

**Unasked values.** A record may hold a value for a facet that no worn class asks for (a class was taken
off, a line was removed, intake brought it). The value is kept, stays readable, and is flagged as
**unasked**. It is never dropped silently.

## 5.6 Asking for parts

A class may say which owned parts its wearers have:

```crubal
class: BoxSet
  for: item
  facets:
    discs
  parts:
    disc: Disc *          // any number of parts wearing Disc
    case: Case            // one part wearing Case
```

Each line names a **part slot**, the class its parts wear, and how many (the shorthand's count). A part's row
key is free; its slot is the class it wears. Units mirror the same parts (chapter 1.6). Part slots meet like
facets (5.4): counts take the narrowest.

## 5.7 Modules

"Module" is an authoring word, not part of the language. When someone builds a module in an editor, one
setting decides what it becomes:

- **stored under its own key** (Cast, Manifest, Audio tracks): a **compound facet** (chapter 4);
- **stored flat under a heading** (Optical disc, Dimensions): a **class** that other classes `use`, with the
  heading as its `label` and as a `section` where it's used.

## 5.8 Classes elsewhere

The same class lines appear in two other places, with the same meaning:

- **A contract's `needs`** is an unnamed class (chapter 7): `needs: !title$80, format{DVD|Blu-ray}` says what
  must be present, and how narrow, before the contract may run.
- **A form** is a contract with a person, so its fields are its `needs`, placed by the same placement
  settings.

Catalogs and other views select records by the classes they wear (chapter 12).

## 5.9 The JSON form of a class

```json
{
  "class": "OpticalDisc",
  "label": "Optical disc",
  "for": ["item"],
  "uses": ["VideoRelease"],
  "facets": [
    { "facet": "format", "values": ["DVD", "Blu-ray", "4K", "HD-DVD"] },
    { "facet": "videoCodec" },
    { "facet": "runtime", "required": true },
    { "section": "Audio" },
    { "facet": "audioTracks" },
    { "facet": "discCondition", "level": "unit" }
  ],
  "parts": [ { "slot": "disc", "wears": "Disc", "pick": "any" } ],
  "version": "2026-10-13"
}
```

Each class line is an object with `facet` and the settings it narrows or places, by their chapter 4.6 names,
plus `level` and `frame`. A `section` line is an object with only `section`. Narrowed `values` are plain
strings: a class carries no aliases.

## 5.10 Well-formed classes

A package MUST be refused at publish when a class breaks these:

1. Every line names a facet the package (or a package it uses) defines.
2. A type mark on a line is the facet's own type, and every narrowing is narrower than or equal to the facet
   (5.3.1).
3. No line sets a facet's meaning (5.3.1).
4. A level prefix names a level of every kind in `for`.
5. `uses` is acyclic, names existing classes, and every meet is non-empty.
6. A facet appears at most once among a class's own lines.
7. `frame` appears only on image facets.
8. Part slots name existing classes, and slot names are unique within the class.

## 5.11 Changes

| Change | Kind | Needs a recipe? |
|---|---|---|
| `label`, `describe`, order, sections, `frame` | safe | no |
| add a facet line, add a used class, widen a narrowing | safe | no |
| remove a facet line or a used class | safe for data; values become unasked (5.5) | no |
| narrow a line, add `!`, add a level prefix | breaking for data that breaks it | `review` |
| narrow `for` | breaking for records of the dropped kinds | `review` |
| remove a part slot | breaking for records with those parts | `review` |
