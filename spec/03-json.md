# 3. The JSON form

The JSON form is what CRUBAL stores, sends and signs. It holds the same pairs as the text form (chapter 2),
with nothing added: a Reader MUST convert either form into the other without losing a pair (comments and
layout are not pairs).

JSON here is RFC 8259 JSON in UTF-8. A document MUST NOT contain duplicate member names, and MUST NOT contain
`null` anywhere.

## 3.1 A record

```json
{
  "id": "P-4QX7",
  "kind": "item",
  "level": "product",
  "of": "G-2HM8",
  "owner": "mediaencyclopedia.com",
  "wears": ["OpticalDisc", "Movie"],
  "created": "2026-10-13T18:02:11Z",
  "updated": "2026-10-14T09:40:03Z",
  "values": {
    "title": "National Lampoon's Christmas Vacation",
    "format": "DVD",
    "releaseDate": "1997-10",
    "runtime": { "$qty": "97", "unit": "min" },
    "videoCodec": { "$empty": "unknown" },
    "hdrFormats": { "$empty": "n/a" },
    "genres": ["Comedy", "Holiday"],
    "rating": [{ "$value": "PG-13", "region": "US" }],
    "work": { "$link": "W-81CC" },
    "director": { "$link": "wd:Q311319" },
    "cast": [
      { "person": { "$link": "wd:Q310394" }, "character": "Clark Griswold" },
      { "person": { "$link": "wd:Q229048" }, "character": "Ellen Griswold" }
    ],
    "ebay:Studio": "Warner Home Video"
  },
  "parts": [
    { "$row": "disc1", "wears": ["Disc"], "values": { "discFormat": "DVD-9" } }
  ],
  "sources": {
    "*": { "origin": "reported", "via": "L-3A0K" },
    "runtime": { "origin": "observed", "via": "L-7Q1F" },
    "cast[wd:Q229048].character": { "origin": "declared", "via": "L-3A0K" }
  }
}
```

## 3.2 Members of a record

| Member | JSON | Required |
|---|---|---|
| `id` | string, chapter 1.1's ID grammar | yes |
| `kind` | string | yes |
| `level` | string | yes |
| `of` | string, an ID | when the record is attached (chapter 1.2); absent when it stands alone |
| `owner` | string, a domain or a hosted person's `domain:ID` (chapter 14.1) | yes |
| `within` | string, an ID | when the record belongs to another for access (chapter 14.2) |
| `status` | `{"state": "active"}` or `{"state": "archived", "reason": "sold", "into"?: ID}` | when archived; absent means active |
| `applied` | object: issuer → integer (chapter 10.7) | when the record has applied an instruction |
| `wears` | array of strings (class names, in order) | when the record wears more than its base class |
| `created` · `updated` | string, RFC 3339 in UTC with `Z` | yes in a store; MAY be left out at a border |
| `values` | object: key → value (3.3) | yes; `{}` when the record has no values |
| `parts` | array of part objects (3.6) | when there are parts |
| `sources` | object: address → source (3.7) | in full form; left out in plain form |
| `alternatives` · `suggestions` | object: address → array of values with sources (chapter 8.4) | when there are any; left out in plain form |
| `held` | object: address → a held value and what holds it (chapter 8.8) | when a value is held; left out in plain form |

A member not in this table MUST be refused. Packages extend records with facets, never with members.

## 3.3 Values

The facet decides the shape (chapter 1.4). Where JSON has the shape, the value is plain JSON. Where it
doesn't, the value is a **tagged object**: an object with exactly one member whose name starts with `$`,
plus the plain members that tag allows. Because no key starts with `$` (chapter 1.3), a tagged object can
never be mistaken for a compound.

| Shape | JSON | Example |
|---|---|---|
| text · choice | string | `"DVD"` |
| number | string holding chapter 1.4.2's decimal | `"97"`, `"2.50"` |
| quantity | `{"$qty": decimal string, "unit": string}` | `{"$qty": "97", "unit": "min"}` |
| money | `{"$money": decimal string, "currency": ISO 4217 code}` | `{"$money": "12.50", "currency": "USD"}` |
| date | string: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or with a time `YYYY-MM-DDThh[:mm[:ss]]` and its offset (`Z` when zero) | `"1997-10"`, `"2026-11-02T14:30Z"` |
| time of day | string: `hh:mm` or `hh:mm:ss` | `"14:30"` |
| yes-no | `true` · `false` | `true` |
| link | `{"$link": target}` | `{"$link": "wd:Q311319"}` |
| image | `{"$image": location}` plus optional `sha256`, `w`, `h` (integers) and `type` | `{"$image": "https://…", "w": 1600}` |
| unknown | `{"$empty": "unknown"}` | |
| does not apply | `{"$empty": "n/a"}` | |
| qualified | `{"$value": any value but an empty, …qualifiers}` | `{"$value": "PG-13", "region": "US"}` |
| compound | object: child key → value | `{"height": {"$qty": "7.5", "unit": "in"}}` |
| raw (unknown key) | the JSON value as received; from text, a string | `"Warner Home Video"` |

**Numbers are strings.** Every number, quantity amount and money amount is a decimal string, never a JSON
number, so no reader can round it through binary floating point. (This tightens the blueprint's example,
which showed `97` as a JSON number.) The string MUST match chapter 1.4.2's grammar.

**Qualifiers** are the members of a `$value` object other than `$value`. Each is a key and a value of its
own facet's shape; a qualifier's value MUST NOT be qualified or empty.

## 3.4 Many values

- A many-valued facet's value is always an array, even with one item. A single-valued facet's value is never
  an array.
- An empty array MUST NOT be written; it is the same as absent.
- An item MUST NOT be an empty (`$empty`). An array MUST NOT hold two equal items (chapter 1.11).
- An ordered list keeps its order. A set's order means nothing, and canonical form sorts it (3.9).

## 3.5 Rows

A many-valued compound is an array of row objects.

- When the compound has an identity child, the row key is derived from it and `$row` MUST NOT be written.
- Otherwise every row MUST carry `"$row": rowkey`, unique within the array.
- `$row` is the only `$` member a row may have.

## 3.6 Parts

```json
{ "$row": "disc1", "wears": ["Disc"], "values": { "discFormat": "DVD-9" } }
```

A part object has exactly `$row` (required), `wears` (when it wears classes) and `values` (required). A
lower-level record mirrors its parts by `$row` and holds only the values that vary at its level; it MAY leave
`wears` out.

## 3.7 Sources

`sources` maps an address (chapter 1.10) to a source object:

```json
{ "origin": "observed", "via": "L-7Q1F", "owner": "someone-else.org" }
```

- `origin` is one of `observed`, `declared`, `derived`, `reported`. `via` is a log entry ID. Both are
  required. `owner` is left out when it is the record's owner. `adopted: true` marks a value made one's
  own (chapter 8.2).
- The address `*` is the record's default source. A more specific address wins: a list item over its list,
  a compound leaf over its compound, a value over `*`.
- Every stored value MUST be covered by some source, `*` or more specific. An address that names nothing in
  `values` or `parts` MUST be refused.
- Addresses into parts start with `parts[rowkey]`.

## 3.8 Other documents

Each document type is a JSON object with a distinct identifying member.

**Intake record.** One object as it arrived through a receive contract (chapter 9).

```json
{
  "intake": "I-55ZT",
  "contract": "me:ebayCatalog /2026-10-01",
  "received": "2026-10-14T09:39:58Z",
  "for": "P-4QX7",
  "raw": { "type": "application/json", "sha256": "4be1…", "body": "{\"Run Time\":\"97 min.\"}" },
  "outcomes": [
    { "from": "Run Time", "to": "runtime", "outcome": "absorbed", "value": { "$qty": "97", "unit": "min" } },
    { "from": "Studio", "to": "ebay:Studio", "outcome": "unknown" },
    { "from": "Format", "to": "format", "outcome": "contradiction", "value": "Blu-ray",
      "cites": { "value": "parts[disc1].discFormat" } }
  ]
}
```

- `raw.body` is the payload's exact bytes: a string when they are valid UTF-8, otherwise `raw.base64`
  instead. `raw.sha256` is the hash of those bytes. A payload MUST NOT be parsed and re-serialized for
  storage.
- `arrival`, when the payload had to find its record (chapter 9.2a): `{"outcome": "bound" | "matched" |
  "held" | "new", "ref": "…", "by": "identify:asin"}`, plus `candidates` when held. `for` is absent while an
  arrival is held.
- `outcome` is one of `absorbed`, `new`, `conflict`, `contradiction`, `unknown`, `ignored`. A
  `contradiction` MUST carry `cites`, naming exactly one of `type` (the facet), `rule`, `value` (an
  address on the same object), `global` (a global rule and the other record) or `slot` (a part slot,
  chapter 5.6). A `new` that is a unit question carries `cites` naming `unit`, the spelling (chapter 11.9).

**Log entry.** One write, hash-linked to the owner's previous entry (chapter 8).

```json
{
  "log": "L-7Q1F",
  "prev": "sha256:2c77…",
  "owner": "mediaencyclopedia.com",
  "at": "2026-10-14T09:40:03Z",
  "by": { "contract": "me:ocr", "run": "R-118" },
  "intake": "I-56AA",
  "source": { "origin": "observed" },
  "writes": [
    { "record": "P-4QX7", "address": "runtime", "value": { "$qty": "97", "unit": "min" } },
    { "record": "P-4QX7", "address": "title", "value": "Christmas Vacation (DVD)", "as": "alternative",
      "source": { "origin": "reported" } },
    { "record": "U-9KD2", "envelope": "applied", "value": 3 }
  ],
  "sig": "…"
}
```

`as` is omitted when it is `current`, and a write carries its own `source` only when it differs from the
entry's (chapter 8.5).

`by` names exactly one of `person`, `contract` (with `run`), `rule`, `migration`, `instruction` or `take` (with `from`,
chapter 8.5). A write that removes a value has
`"removed": true` in place of `value`.

**Observation.** An evidence-backed claim made on one instance (chapter 9).

```json
{
  "obs": "O-2KQ0",
  "on": "U-9KD2",
  "address": "runtime",
  "value": { "$qty": "97", "unit": "min" },
  "evidence": { "$image": "https://…/back-cover.jpg", "sha256": "77a0…" },
  "evidence-type": "photo",
  "reading": "I-56AA",
  "supports": "P-4QX7"
}
```

**Border wrapper.** Data crossing a border travels in a wrapper, the only place a version appears:

```json
{
  "crubal": "2",
  "package": "mediaencyclopedia.com/me /2026-10-13",
  "prefixes": { "me": "mediaencyclopedia.com/me", "wd": "https://www.wikidata.org/entity/" },
  "records": [ … ]
}
```

`prefixes` maps every prefix the data uses to its full identity (chapter 11.1), so a receiver resolves
`me:videoCodec` without knowing the sender's nicknames. The wrapper MAY also carry `intake`, `log` and
`observations` arrays.

## 3.9 Canonical form

For hashing and signing, a document is put in canonical form and then serialized by RFC 8785 (the JSON
Canonicalization Scheme):

1. every set is sorted by the RFC 8785 serialization of its items, in code-unit order;
2. ordered lists keep their order, and rows of a set are sorted like any item;
3. `wears` keeps its order;
4. numbers are strings already, so RFC 8785's number rules never apply;
5. no defaults are filled in and no empties are added: what is absent stays absent.

Two documents with the same canonical bytes hold the same data.

## 3.10 Text ↔ JSON

| Text (chapter 2) | JSON |
|---|---|
| file header `crubal`, `package` | the border wrapper |
| file header `owner` | each record's `owner`, unless the record says otherwise |
| header `level: id of parent` | `level`, `id`, `of`; `kind` from the package |
| header detail | `sources["*"]` |
| `crubal:wears`, `crubal:parts`, `crubal:created`, `crubal:updated`, `crubal:owner` | the envelope members |
| `key: value` | `values[key]` |
| a value's source detail | `sources[address]` |
| a value's qualifier detail | a `$value` object |
| `[row: key]` | `$row` |
| image fields in a detail | members of the `$image` object |

A Reader MUST produce the same canonical JSON (3.9) from a text and from its full-mode print, and MUST print
the same pairs back from any JSON it read.
