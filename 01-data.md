# 1. Data and the value model

This chapter defines what data *is*, independent of how it is written. Chapter 2 writes it as text and
chapter 3 as JSON; both MUST express exactly the model here, so either form converts to the other without
losing a pair.

## 1.1 Records

A **record** is one thing: a product, a unit, a film, a person, a booking. It has an **envelope** and
**values**.

The envelope is defined by the core and written by the engine. No person or contract writes it directly,
and it carries no source.

| Field | Holds | Notes |
|---|---|---|
| `id` | the record's identifier | unique within its owner; never reused |
| `kind` | the record's root type | fixed when the record is created (1.2) |
| `level` | which of the kind's levels this record sits at | `product`, `unit` … (1.2) |
| `of` | the record one level up, by ID | absent at the top level |
| `owner` | who controls the record | a domain (`mediaencyclopedia.com`) |
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
be one of its kind's levels, and its `of` MUST name a record of the same kind at the level directly above.

## 1.3 Keys

A **key** names a facet. Its grammar:

```
key     = [ prefix ":" ] name
prefix  = lower *( lower / digit / "-" )
name    = ( ALPHA / "_" ) *( ALPHA / DIGIT / "_" )
```

- A bare key belongs to the document's own package. Any other owner's key MUST carry that owner's prefix.
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

A number with a unit: `97 min`, `2.4 lb`. The unit is a spelling from the units table. A quantity is a
number facet's value when the facet names a unit. Two quantities are equal only with the same unit;
conversion is a facet setting (chapter 4), never implicit.

### 1.4.4 Money

A number with an ISO 4217 currency: `12.50 USD`. Money is a number facet whose unit is a currency. The amount
is an exact decimal with any number of places; conversion to minor units (cents) happens only at a border
whose contract asks for it. A three-letter uppercase spelling is always a currency, so the units table MUST
NOT use one as a unit.

### 1.4.5 Date

A calendar date at one of three precisions: year (`1997`), month (`1997-10`) or day (`1997-10-03`),
proleptic Gregorian. The precision is part of the value: `1997` and `1997-01` are different values. A facet
says which precisions it accepts (chapter 4). Envelope times are RFC 3339 date-times in UTC and are not facet
values.

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
- Otherwise the first writer mints a row key, and it MUST NOT be reused for another row of that list.
- A minted row key follows the ID grammar (1.1); a derived one is an ID or `prefix:ID`.

**Parts.** Owned parts (disc 2 of a set, the case) are rows of the record's `parts`. Each has a row key, its
own `wears` and its own values. Shared parts are not parts: they are records of their own, linked by a link
facet, and read through.

**Units mirror parts.** A record at a lower level holds parts with the same row keys as the record above,
carrying only the values that vary at its level (1.7).

## 1.7 Values down the levels

A record reads the values of the records above it. A lower record stores a value only for a facet the
package declares to **vary** at that level step; for any other facet it MUST NOT store one, and readers see
the upper record's value. A stored value at the lower level overrides the upper one for that record only.

A value is stored once, at the highest level where it is true.

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
| `unit::condition` | `condition` at the `unit` level, written from above (rules and classes only) |

A list item of a plain list is addressed by its value: the item's text form (chapter 2), with its
qualifiers but not its sources, written as a quoted text: `genres["Holiday"]`, `rating["15 [region: UK]"]`. A selector that matches nothing addresses nothing; it is
not an error to read, and it is an error to write a source to.

## 1.11 Equality and identity

Two values are equal when they have the same shape and, by shape: text and choice exactly; numbers, quantity
amounts and money amounts by numeric value, with the same unit or currency; dates with the same precision and
fields; links with the same target string; images by `sha256` when both have one, otherwise by location;
compounds pair by pair; lists item by item, in order for an ordered list and as sets otherwise. Qualifiers
take part in equality. Sources never do.
