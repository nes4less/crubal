# 1. Data and the value model

This chapter defines what data *is*, independent of how it is written. Chapter 2 writes it as text and
chapter 3 as JSON; both MUST express exactly the model here, so either form converts to the other without
losing a pair.

## 1.1 Records

A **record** is one thing: a product, a unit, a film, a person, a booking. It has an **envelope** and
**values**.

The envelope is defined by the core and written by the engine. No person or contract writes it directly,
and it carries no source. Every change to it is still a write, logged like any other (chapter 8.5): the
engine makes it on behalf of whoever decided it.

| Field | Holds | Notes |
|---|---|---|
| `id` | the record's identifier | unique within its owner; never reused |
| `kind` | the record's root type | fixed when the record is created (1.2) |
| `level` | which of the kind's levels this record sits at | `product`, `unit` … (1.2) |
| `of` | the record one level up, by ID | optional at every level; absent when the record stands alone (1.7) |
| `owner` | who holds the record's key | a domain (`mediaencyclopedia.com`), or a person hosted by one (chapter 14.1) |
| `within` | the record this one belongs to for access, by ID | optional; any depth; chapter 14.2 |
| `status` | `active` or `archived`, with a `reason`, and `into` for a merge | 1.12 |
| `applied` | for a record below the top level: for each issuer of instructions (the record above, each kind version, each class version), the last one it has applied | chapter 10.7 |
| `wears` | the classes the record wears, in order | classes refine the kind (chapter 5) |
| `created` · `updated` | times, UTC | RFC 3339, `Z` |
| `parts` | owned parts (1.6) | absent when there are none |
| `sources` | where each value came from (1.9) | |

**Identifiers.** An ID is one or more of `A–Z a–z 0–9 - _ .`, starting with a letter or digit. Inside one
owner's data a bare ID names that owner's record. Another owner's record is written `prefix:ID`, where the
package maps the prefix to the owner (chapter 11). IDs are case-sensitive.

## 1.2 Kinds and levels

A **kind** is a record's root type. A package declares its kinds; the core defines none of them. Each kind
declares:

- its **levels**, top to bottom (an item kind: `group > product > unit`; a kind with one level names that
  level after itself);
- a **base class** every record of the kind wears;
- its **schema.org type** (`schema:Product`), for publishing.

Level names MUST be unique across the kinds of one package, so a level names its kind. A record's level MUST
be one of its kind's levels. Its `of`, when present, MUST name a record of the same kind at the level directly
above. **`of` is optional at every level:** a kind's levels say where a record may attach, never that it
must. A unit with no product is a whole record that can be shown, sold and printed on its own (1.7).

## 1.3 Keys

A **key** names a facet. Its grammar:

```
key     = [ prefix ":" ] name
prefix  = lower *( lower / digit / "-" )
name    = ( ALPHA / "_" ) *( ALPHA / DIGIT / "_" )
```

- A bare key belongs to the document's own package. Any other package's key MUST carry a prefix.
- **A prefix is a local nickname.** Each package (and each border wrapper) maps its prefixes to full package
  identities, `domain/name` (chapter 11.1). Two keys are the same key when their prefixes map to the same
  identity and their names are equal; readers MUST compare after resolving, never by the nickname.
- Keys are case-sensitive and MUST be in Unicode NFC. Other spellings (aliases) are folded away before
  storage (chapter 4); stored data never holds an alias.
- A key never begins with `$`, so `$` is free for the JSON form's tags (chapter 3).
- A key the reader has no definition for is an **unknown key**. Its value is kept, as written, and never
  interpreted (1.4.9).

## 1.4 Values

A value has one of the shapes below. The **facet decides** which shape a key's value takes: chapter 2's
lexical shapes only suggest. A value that doesn't fit its facet is a type contradiction (chapter 9), not a
different type.

### 1.4.1 Text

A sequence of Unicode characters in NFC. Text is compared exactly; case-folding and trimming belong to
aliases and contracts, not to text.

### 1.4.2 Number

A decimal number: an optional `-`, digits, and an optional `.` and digits. No exponent, no `+`, no leading
zeros except a lone `0` before the point. Implementations MUST keep the value exactly as a decimal (no
binary floating point) and MUST compare by numeric value (`2.50` equals `2.5`). A facet may limit places and
range (chapter 4).

### 1.4.3 Quantity

A number with a unit: `97 min`, `2.4 lb`. The unit is a unit of the units table (chapter 11.9), by its
canonical spelling; the table's other spellings fold to it on intake (chapter 9.2), so a stored quantity
never holds one. A quantity is a number facet's value when the facet names a unit. Two quantities are equal only with the same unit;
conversion is a facet setting (chapter 4), never implicit.

### 1.4.4 Money

A number with an ISO 4217 currency: `12.50 USD`. Money is a number facet whose unit is a currency. The amount
is an exact decimal with any number of places; conversion to minor units (cents) happens only at a border
whose contract asks for it. A three-letter uppercase spelling is always a currency, so the units table MUST
NOT use one as a unit.

### 1.4.5 Date

A calendar date, proleptic Gregorian, at one of six precisions: year (`1997`), month (`1997-10`), day
(`1997-10-03`), and with a time of day, hour (`2026-11-02T14Z`), minute (`2026-11-02T14:30Z`) or second
(`2026-11-02T14:30:15Z`). The precision is part of the value: `1997` and `1997-01` are different values. A
facet says which precisions it accepts (chapter 4).

- **A date with a time is a moment** and MUST carry its UTC offset: `Z`, or `+hh:mm` / `-hh:mm`
  (`2026-10-14T18:00-05:00`). Canonical form writes a zero offset as `Z`. Two moments compare by the instant
  they name, whatever their offsets.
- **Local wall-clock dates** ("doors at 7pm, wherever the venue is") carry no offset, and are allowed only
  under a facet with `zone: local`. They compare only with other local dates; comparing one with a moment is
  undetermined (chapter 6.3.1).

Envelope times are RFC 3339 date-times in UTC and are not facet values.

### 1.4.5a Time of day

A time of day with no date, on a 24-hour clock, at minute (`14:30`) or second (`14:30:15`) precision. When a
zone matters, it is a qualifier holding an IANA time zone name: `22:30 [zone: America/Chicago]`. Two times
of day compare as clock times, and only when their zones are the same or both absent. How long something
lasts is not a time of day; it is a quantity (`90min`, chapter 1.4.3).

### 1.4.6 Yes-no

Two values, yes and no. A facet may give them other words (`Sealed`, `Opened`); the stored value is still
yes or no.

### 1.4.7 Choice

One value from the facet's list, stored as the list's canonical spelling, compared exactly. A value the list
doesn't hold is **new** (vocabulary growth) unless the list is fixed (chapter 9).

### 1.4.8 Link

A reference to another thing. Three forms:

| Form | Points at |
|---|---|
| `P-4QX7` | a record of the same owner |
| `prefix:ID` (`me:P-4QX7`, `wd:Q311319`) | another owner's record, or a shared vocabulary such as Wikidata |
| an absolute URL (`https://…`) | a web page |

A link is not a copy: the target's values are read through it, never stored beside it.

### 1.4.9 Image

A picture, by its location (an absolute URL or a package-defined content address), with optional
`sha256` (lowercase hex of the bytes), `w` and `h` (pixels) and `type` (a media type). Two images are the
same image when their `sha256` match.

### 1.4.10 Raw

The value of an unknown key: the exact text as written (text form) or the exact JSON value (JSON form). A
Reader MUST keep it unchanged and MUST NOT guess its type.

### 1.4.11 Compound

A value made of pairs: each pair is a child facet and its value, and children may be compounds themselves, to
any depth. A compound's children are real facets, addressed through their parent (`cast.character`).

## 1.5 The three empties

| State | Means | Satisfies "required"? |
|---|---|---|
| **absent** | the key isn't there; nobody has said anything | no |
| **unknown** | it applies, and the value is still owed | no |
| **does not apply** | no value, by design | yes, where a rule allows it |

The empties are data. There is no null value and no nullable flag: whether a facet may be unknown or not
apply is decided by rules (chapter 6). An empty is always the whole value of a key; it MUST NOT appear as a
list item or a qualifier.

## 1.6 Many values, rows and parts

**How many.** A facet holds one value, up to N, or any number (chapter 4). A many-valued facet's value is a
**list**, even when it holds one item. An empty list is the same as absent, and writers MUST NOT write one.

**Ordered list or set.** The facet says which. In an ordered list the order means something (billing order)
and is kept. A set has no order; canonical forms sort it (chapter 3). Neither may hold the same item twice.

**Rows.** Each item of a many-valued compound is a **row** with a **row key**: a short name, unique within
the list, that never changes when rows are reordered.

- If the compound declares an identity child (cast's `person`), the row key is that child's link target
  (`wd:Q310394`), so two sources can tell they mean the same row. An identity child MUST be a link facet,
  and its row key is never written separately.
- Otherwise the first writer mints a row key, and it MUST NOT be reused for another row of that list. A
  compound or part slot without an identity child MAY declare a **match** child (`match: name`): incoming
  rows are matched to existing ones by that child's fold key (chapter 4.3) before any new row key is minted
  (chapter 9.2).
- A minted row key follows the ID grammar (1.1); a derived one is an ID or `prefix:ID`.

**Parts.** Owned parts (disc 2 of a set, the case) are rows of the record's `parts`. Each has a row key, its
own `wears` and its own values. Shared parts are not parts: they are records of their own, linked by a link
facet, and read through.

**Units mirror parts.** A record at a lower level holds parts with the same row keys as the record above,
carrying only the values that vary at its level (1.7).

**Notables.** Every record MAY hold `crubal:notables`, a core compound (`key` text, `value` text, any number,
rows matched by `key`) for facts that are true of this record and that no class asks for: signed, misprint,
edition number 4522, graded. Notables are data like any other, with sources. A notable key that recurs across
enough records is proposed as a real facet through review (chapter 9.5); a one-off stays a notable.

## 1.7 Values down the levels

Every key on an attached record is one of two kinds:

- **Folded keys.** Facets that don't vary at the record's level (a product's title, format, runtime) are
  facts about the record above. The lower record stores none of them; it reads the upper record's value, so a
  change above is a change below. A value is stored once, at the highest level where it is true.
- **Owned keys.** Facets that **vary** at the record's level (a unit's condition, price, sealed) are its own.
  The record above **projects the keys**: the kind's `vary` steps and the `level::` lines of the classes it
  wears (chapter 5.3.3) say which keys its lower records have. The lower record **owns the keys and their
  values**. A change above never changes an owned value, and a change to which keys are projected reaches a
  lower record only through an instruction (chapter 10.7).

A record that wears a class of its own (5.5) owns that class's lines **at its own level**: its `level::`
lines, and, when the record stands alone, its unprefixed lines too. Lines above its level stay folded,
whatever the record above projects.

**Standing alone.** A record without `of` reads nothing from above, so it stores every value itself, folded
keys included, and wears only its own classes. Its classes' lines with no level prefix are asked of it at its
own level. Rules and templates read its own values the same way they read through.

**Writing a folded key** is writing the record that stores it. A caller who may not `edit` that record
(chapter 14) makes a suggestion there (chapter 7.5), never a change.

**Attaching** a standing-alone record folds its values into the record above, key by key, as observations do
(chapter 9.7.1):

| The record above | The lower record's value | Result |
|---|---|---|
| holds the same value | | the lower copy is dropped and read through; it counts as support |
| holds no value | | the lower value moves up, keeping its source |
| holds a different value | | a conflict (chapter 9.3): the trust order picks, the other is kept as an alternative; a cluster of such differences across instances is the version-split signal (9.7.3) |

Owned keys stay where they are. Attaching needs `edit` on the lower record; a value that would move up to a
record the caller may not edit lands there as a suggestion instead, and the lower record keeps its own value
until it is accepted. Attaching is refused, and goes to review, when the two records' worn classes have an
empty meet (chapter 5.5).

**Detaching** copies every folded value onto the lower record, with its source, so the record keeps working as
it was. Attaching and detaching are envelope writes (1.1), logged.

## 1.8 Qualifiers

A **qualifier** is detail about one value that is part of what it means: `PG-13` *in the US*, `15` *in the
UK*. Each qualifier is a key and a value, where the key is a facet (so it has a type) and the value is not
itself qualified. A qualified value equals another only when the value and every qualifier are equal.

Four names are reserved inside a value's detail and MUST NOT be used as qualifier keys: `row`, `origin`,
`via` and `owner`.

## 1.9 Sources

Every stored value carries a source of three fields.

| Field | Holds | Changes? |
|---|---|---|
| `origin` | how the value was first established: `observed` (read off a real instance), `declared` (its maker said so), `derived` (a rule computed it), `reported` (a catalog says so, origin unknown) | never |
| `via` | the log entry of the write that put it here (chapter 8) | on every write |
| `owner` | who controls the value now | by adopting |

- A source attaches to an **address** (1.10): a whole value, one list item, or one compound leaf.
- A record has a **default source**; a source at a more specific address wins.
- `owner` is omitted when it is the record's owner.
- Values read through from an upper level or a shared part carry no source on the lower record. Their source
  lives where they are stored.
- One write makes one log entry, however many values it touches.

## 1.10 Addresses

An **address** names one place inside a record. The same addresses are used by sources, intake, observations
and rules.

```
address   = step *( "." step )
step      = key [ "[" selector "]" ]
selector  = rowkey / quoted-item
```

| Address | Names |
|---|---|
| `runtime` | the value of `runtime` |
| `cast[wd:Q229048].character` | `character` in the row of `cast` whose identity is `wd:Q229048` |
| `tracks[t3].language` | `language` in the row of `tracks` with the minted key `t3` |
| `parts[disc1].condition` | `condition` on owned part `disc1` |
| `genres["Holiday"]` | the item `Holiday` of the list `genres` |
| `works[*].genres` | `genres` on every record the link facet `works` points at: a shared part, read through (1.6); `work.title` reads a single link's target |
| `unit::condition` | `condition` at the `unit` level, written from above (rules and classes only) |

A list item of a plain list is addressed by its value: the item's text form (chapter 2), with its
qualifiers but not its sources, written as a quoted text: `genres["Holiday"]`, `rating["15 [region: UK]"]`. A selector that matches nothing addresses nothing; it is
not an error to read, and it is an error to write a source to.

## 1.11 Equality and identity

Two values are equal when they have the same shape and, by shape: text and choice exactly; numbers, quantity
amounts and money amounts by numeric value, with the same unit or currency; dates with the same precision and
fields, and moments by the instant they name; times of day by clock time and zone; links with the same target string; images by `sha256` when both have one, otherwise by location;
compounds pair by pair; lists item by item, in order for an ordered list and as sets otherwise. Qualifiers
take part in equality. Sources never do.

## 1.12 Lifecycle

A record is never deleted. Its life is a short list of envelope writes, each logged with who decided it.

| Event | What happens |
|---|---|
| **arrive** | the record is minted, or the arrival is bound to an existing record (chapter 9.2a) |
| **attach** · **detach** | `of` is set or cleared; values fold up or are copied down (1.7) |
| **apply** | a lower record applies its parent's pending instructions (chapter 10.7) |
| **archive** | `status` becomes `archived` with a reason; folded values are copied onto the record |
| **unarchive** | `status` returns to `active` |
| **merge** | two records are the same: one survives, the other is archived with reason `merged` and `into` |
| **split** | the reverse of a merge, or a version split confirmed by a person (chapter 9.7.3) |

**Archive** is one state for everything that leaves the working set: sold, discontinued, a duplicate, a
mistake. The `reason` says which; a package MAY name reasons of its own.

- **It is always a decision**, by a person or a contract (a checkout that completes archives the unit it
  sold). Rules MAY suggest archiving; they never archive.
- **It keeps history true.** Archiving copies every folded value onto the record, with its source, so a later
  change above never rewrites what an archived record says.
- **An archived record is left alone by the engine:** pending instructions skip it, rules don't recompute
  its produced values, and views leave it out unless they select archived records explicitly. Intake still
  reaches it: a bound reference or a strong key lands there, a weak key proposes it flagged as archived
  (chapter 9.2a), and what lands never changes its status.
- **It holds its snapshot.** An archived record MAY hold values for folded keys (the copies archiving made),
  the one exception to chapter 1.7's rule that an attached record stores none.
- **It is reversible.** Unarchiving returns the record to `active` as it was archived; if it is attached, its
  copied values fold up again as in attaching (1.7), differences going to review.
- **Cascade is the package's rule** (chapter 11.2, `archive`): archiving a record either archives the records
  below it, along `of`, along `within` or both, each with reason `parent archived`, or leaves them alone.
  Unarchiving undoes only what the cascade did.

**Merge.** The survivor keeps its ID. The merged record's values fold into it under the trust order (chapter
8.4), losers kept as alternatives; its bindings (chapter 9.2a), the records `of` it and the records `within`
it move to the survivor; links to the merged ID, and edges on it (chapter 14.3), resolve through `into`. An
ID is never reused.
