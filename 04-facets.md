# 4. Facets

A **facet** says what a key means: its type, how many values it holds, its choices, its unit, its other
names and its version. A facet's definition is pairs about a key, written in the long form (4.2), in one
line of shorthand (4.5), or as JSON (4.6). All three hold the same settings.

A facet never says what is true of a record, what a kind of thing asks for, or what must hold. Those are
data (chapter 1), classes (chapter 5) and rules (chapter 6). Some settings are **shortcuts** for rules
(4.4): they are written on the facet because nearly every facet needs them, and they expand to rules with
one engine behind them.

## 4.1 Identity and versions

- **The key is the identity** and never changes. It is written with its owner's prefix (`me:videoCodec`);
  inside the owner's own files the bare key is enough. A rename changes the `label`, and the old spelling
  becomes a key alias (4.3).
- **Versions are dated:** `YYYY-MM-DD`, with `.2`, `.3` … for a second or later version published the same
  day (`2026-10-13.2`). A published version MUST NOT change. Each facet is versioned on its own; a package
  version is a frozen set of member versions (chapter 11).
- A facet MAY carry a short ID (`F-7KQ2`) for display or tooling. It is never the identity.
- Stored values carry no version. A breaking change (4.8) ships a migration recipe (chapter 10).

## 4.2 The long form

```crubal
facet: videoCodec
  label: Video codec
  ask: How is the picture encoded on the disc?
  describe: The codec of the main feature, as read from the disc or its case.
  type: choice
  values: MPEG-2, H.264, VC-1 ~vc1, HEVC, AV1
  aliases: codec, "Video Format"
  same-as: schema:encodingFormat
  version: 2026-10-13
```

A definition is a block under `facet: key`. Its settings:

### Every type

| Setting | Holds | Default |
|---|---|---|
| `type` | `text`, `number`, `date`, `yes-no`, `choice`, `link`, `image` or `compound` | required |
| `label` | the name people see | the key, split at capitals |
| `ask` | the short question beside the control | none |
| `describe` | what the facet means: where it comes from, what it drives | none |
| `pick` | how many values: `1`, a number N for "up to N", or `any` | `1` |
| `ordered` | many-valued only: `yes` makes the list an ordered list; otherwise it is a set (chapter 1.6) | `no` |
| `qualifiers` | the facets whose values may qualify this facet's values (chapter 1.8) | none |
| `aliases` | other spellings of the key (4.3) | none |
| `same-as` | the same property elsewhere: `schema:name`, `wd:P577` | none |
| `version` | the dated version (4.1) | required when published |

### By type

| Type | Setting | Holds |
|---|---|---|
| text | `length` | the most characters (a shortcut, 4.4) |
| number | `unit` | a unit spelling (`min`, `lb`), an ISO 4217 code (`USD`), or `currency` for money in any currency |
| number | `accepts` | other units a value may arrive in; they are converted to `unit` by the units table on the way in, with the rounding the table states |
| number | `range` | `1..600`, optionally `step 0.5` (a shortcut, 4.4) |
| number | `places` | the most decimal places kept |
| date | `precision` | `year`, `month`, `day`, or `any` (all three accepted) |
| yes-no | `words` | the two words when they aren't yes and no: `Sealed, Opened` |
| choice | `values` | the list, in order, each with `~` spellings (4.3); ends in `...` when people may add to it (4.2.1) |
| choice | `fixed` | `yes` when the list is fixed by definition (4.2.1) |
| choice | `ranked` | `yes` when the list's order is a ranking (`NM` > `VG` > … > `P`), so `best`, `worst`, `over` and `under` mean something |
| choice | `scored` | `yes` when each pick also takes a grade from 0 to 10, stored as the qualifier `grade` |
| link | `to` | what it points at: a kind, a class, `url`, or a shared vocabulary's prefix (`wd`) |
| compound | `facets` | the child facets: blocks or shorthand lines (4.5) |
| compound | `identity` | the child that identifies a row; it MUST be a link child (chapter 1.6) |

### Shortcuts for rules

`required`, `na`, `unique`, `when`, `length`, `range` and `combine` (4.4).

### Package settings

A setting key with a prefix (`me:scanRank`) belongs to that package. A reader that doesn't know it MUST
carry it unchanged and MUST NOT let it change what the facet means. Machinery (which service fills a facet,
how a scanner ranks it) lives here, never in the core settings.

### 4.2.1 Open, closed and fixed lists

| List | Written | A person in a form | A value from intake |
|---|---|---|---|
| **open** | `values` ends in `...` | may add a value ("+ Other…"); it is new | lands as **new**, for vocabulary review |
| **closed** | no `...`, no `fixed` | picks from the list | lands as **new**, for vocabulary review |
| **fixed** | `fixed: yes` | picks from the list | is a **contradiction** with the definition |

A list is fixed only when the world fixes it (Blu-ray regions A, B, C). A closed list is just the list we
have so far. `...` and `fixed: yes` MUST NOT both be set.

## 4.3 Aliases

Aliases are naming, not rules. They mean the same thing always, everywhere, for that facet.

- **Key aliases** (`aliases: codec`) are other spellings of the key.
- **Value aliases** (`VC-1 ~vc1 ~"VC 1"`) are other spellings of one choice value.

**Folding.** Aliases are folded before any rule runs. Stored data never holds an alias, and printers write
only the real name. Matching compares **fold keys**: the spelling in NFC, with Unicode default case folding,
leading and trailing spaces removed, and every run of white space made one space. The real key and the real
value match under the same folding, so `dvd` folds to `DVD` without an alias.

**What isn't an alias.** If it depends on context, it is a `suggest` rule. If it is another system's
vocabulary, it is a contract's value map (`->`). If it is the same thing under different facets, it is a
shared link (`&wd:…`).

**Dictionary rules** (checked when a package is published, 4.7):

- a key alias MUST NOT fold to the same key as another facet's key or key alias in the package;
- a value alias MUST NOT fold to the same key as another value or value alias of the same facet;
- two values of one facet MUST NOT fold to the same key.

**Changes.** Adding an alias is safe. Removing one is safe for stored data but can break imports, so it is a
minor change. Turning a value into an alias of another is a **merge**, which is breaking (4.8).

## 4.4 Shortcuts for rules

Each shortcut expands to one rule (chapter 6), with the facet as its subject. The expanded rule is the
truth; the setting is a short way to write it.

| Setting | Expands to | Strength |
|---|---|---|
| `required: yes` | `then: key has` | must |
| `na: yes` | `-` is an allowed value for `key` | must (without it, `-` breaks a must rule) |
| `unique: yes` | `then: key is unique` (a global rule) | must |
| `when: condition` | outside the condition, `key` is `-` | must |
| `length: 80` | `when: key has` `then: key under 81 characters` | should |
| `range: 1..600` | `when: key has` `then: key in 1..600` | should |
| `combine: worst` | `then: key is worst of parts[*].key` (chapter 6's rollups) | must |

A rule written in full and a shortcut that say the same thing are the same rule; a package MUST NOT carry
both.

**Combine rules**: `join`, `sum`, `best`, `narrow`, `worst`, `deduct`, `replace`, `keep`. The default is
`join` for many-valued facets and `replace` for single ones. `best` and `worst` need a ranked choice, a
number or a date. Only `replace` depends on the order contributions arrive in.

## 4.5 Shorthand

One facet on one line, for the common case. It always expands to the long form.

```crubal
!title$200 ~name =schema:name
videoCodec{MPEG-2|H.264|VC-1~vc1|HEVC|AV1} ~codec =schema:encodingFormat /2026-10-13
productionFormat{Full Length Movie|Shorts|...}
releaseDate@any
runtime#min 1..600
price#USD
sealed?
condition{NM|VG|G|F|P} ranked
cast(person&Person character$)* identity: person
genres{Comedy|Holiday|Drama|...}*
```

Read left to right:

```
line     = [ "!" ] key type [ count ] *( " " tail )
type     = "$" [ digits ]                      ; text, optional length
         / "#" [ unit ]                        ; number, optional unit or currency
         / "@" ( "y" / "ym" / "ymd" / "any" )  ; date and its precision
         / "?"                                 ; yes-no
         / "{" choice *( "|" choice ) [ "|..." ] "}"   ; choice, optionally open
         / "&" target                          ; link
         / "^"                                 ; image
         / "(" line *( " " line ) ")"          ; compound
choice   = value *( "~" value )                ; a value and its spellings
count    = "*" [ digits ]                      ; any, or up to N
tail     = "~" key                             ; key alias
         / "=" key                             ; same as
         / "+" combine                         ; combine rule
         / "/" version                         ; version
         / number ".." number                  ; range
         / setting                             ; a bare word or "name: value" from 4.2
```

- `!` is `required: yes`. `@` alone means `@any`.
- A choice value holding `|`, `~`, `{`, `}`, `(`, `)` or a space at either end is quoted with chapter 2's
  quoting: `{"A|B"|C}`.
- Inside a compound's parentheses, children are separated by spaces and are themselves shorthand lines.
- **Settings with no mark** (`label`, `ask`, `describe`, `qualifiers`, `accepts`, `places`, `words`,
  `ranked`, `scored`, `fixed`, `na`, `unique`, `when`, `ordered`, `identity`, package settings) go on the line
  as bare tails: a word alone means `yes` (`ranked`), and `name: value` gives a value
  (`identity: person`). A value with a space is quoted.
- **The level mark** `unit::` belongs to class lines (chapter 5), not to a facet's own definition. Where a
  facet varies is declared by kinds and classes, never by the facet.

A printer SHOULD write the shorthand when every setting fits on one line within 100 characters, and the long
form otherwise. It MUST NOT drop a setting to make a line fit.

## 4.6 The JSON form of a definition

The long form's pairs as one object. Member names are the setting names; values follow chapter 3, with
`yes`/`no` as `true`/`false` and numbers as strings.

```json
{
  "facet": "videoCodec",
  "type": "choice",
  "label": "Video codec",
  "ask": "How is the picture encoded on the disc?",
  "values": [
    { "value": "MPEG-2" }, { "value": "H.264" }, { "value": "VC-1", "aliases": ["vc1"] },
    { "value": "HEVC" }, { "value": "AV1" }
  ],
  "aliases": ["codec", "Video Format"],
  "same-as": ["schema:encodingFormat"],
  "version": "2026-10-13"
}
```

- `values` is an array of `{"value", "aliases"?}`; an open list adds `"open": true` at the top level.
- `facets` (compound) is an array of child definitions, each with its own `facet` key.
- `range` is `{"min": "1", "max": "600", "step"?: "0.5"}`.
- Settings equal to their default are left out. Package settings keep their prefix as the member name.
- A shortcut is stored as its setting. The expansion (4.4) happens when rules are built, never in storage.

## 4.7 Well-formed definitions

A package MUST be refused at publish when any definition breaks these:

1. `type` is one of the eight types, and every setting is one its type allows (4.2).
2. A choice facet has at least one value. A compound has at least one child.
3. `identity` names a child of the compound, and that child is a link.
4. `ordered` is set only when `pick` is not `1`.
5. `ranked`, `scored`, `fixed` and `...` are set only on choice facets; `fixed` and `...` not both.
6. `unit` and `accepts` are spellings from the units table or ISO 4217 codes, and `accepts` is set only with
   `unit`.
7. Every `qualifiers` entry names a facet whose own values can't be qualified.
8. No alias collides (4.3).
9. `range` has `min` ≤ `max`, and `step`, when set, divides the span.
10. A compound's children have distinct keys, and none is named `row`, `origin`, `via` or `owner`.

## 4.8 Changes and versions

| Change | Kind | Needs a recipe? |
|---|---|---|
| `label`, `ask`, `describe`, `same-as` | safe | no |
| add a key alias or value alias, add a value | safe | no |
| remove an alias | minor (imports may break) | no |
| open a closed list (`...`), widen `pick`, widen `range` or `length` | safe | no |
| remove a value, merge values, rename a value | breaking | `rename` · `merge` |
| narrow `pick`, `precision` or `places`; change `unit` | breaking | `review` · `convert` |
| change `type` | breaking | `merge` + `review` |
| fix a list, add `required`, add a `must` rule | breaking for data that breaks it | `review` |
| change `combine` | breaking for rollups | recompute |

A breaking version MUST ship a recipe (chapter 10). A store applies it before it accepts data written under
the new version.

## 4.9 Checking a value against its facet

At the Dictionary level, after aliases fold, each value is checked against its facet. The result is one of
chapter 9's intake outcomes, and the checks are:

| Check | Fails as |
|---|---|
| the value has the facet's shape (a date where a date is wanted) | contradiction, citing `type` |
| a date has a precision the facet accepts; a more precise date is cut to what the facet keeps, and the intake record keeps the rest | flagged when less precise than every accepted precision (it still lands) |
| a quantity's unit is `unit` or in `accepts` | contradiction, citing `type` |
| a choice value is in the list | **new** for an open or closed list; contradiction, citing `type`, for a fixed list |
| no more values than `pick` allows | contradiction, citing `type`; review offers both fixes |
| qualifiers are among `qualifiers` | the unknown qualifier is kept and flagged |
| `length`, `range` | flagged (they are `should` rules) |

A value that fails is kept: on the intake record and beside the facet, never dropped.
