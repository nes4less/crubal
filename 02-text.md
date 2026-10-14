# 2. The text form

The text form is how people read and write CRUBAL data. It expresses chapter 1's model exactly: every pair
it can say, the JSON form (chapter 3) can say, and the reverse.

## 2.1 Files and lines

- A file is UTF-8, without a byte-order mark. Lines end in LF or CRLF.
- **Indentation** is spaces. A tab in a line's indentation MUST be refused. A line belongs inside the
  nearest earlier line that is indented less. Printers indent two spaces per level.
- A **comment** starts with `//` at the start of a line or after a space, and runs to the end of the line.
  `//` inside quotes or inside a URL (`https://`) is not a comment. Comments are not data and are not
  carried into JSON.
- Blank lines and comment-only lines mean nothing.

Every other line is one of three things:

| Line | Shape | Example |
|---|---|---|
| a pair | `key: value`, or `key:` at the end of the line to open a block | `runtime: 97min` |
| a list item | `- ` then a value, or `- ` then a pair that starts a row | `- Comedy` |
| a header | a level name, `: `, an ID (2.3) | `product: P-4QX7 of G-2HM8` |

**The separator.** Only `: ` (a colon then a space) or a colon at the end of the line separates a key from
its value, and only the first one on the line does. So `schema:name: Title` is the key `schema:name`, and
`https://…` in a value never splits it.

## 2.2 The file header

A file MAY start with up to three pairs, in any order, before its first record:

```crubal
crubal: 2
package: me /2026-10-13
owner: mediaencyclopedia.com
```

- `crubal` is the language version.
- `package` names the package and the frozen version the data was written under. It is required at a border
  (chapter 7) and MAY be left out inside a store.
- `owner` is the default owner of every record in the file.

At the top level of a file, any key other than these three and the package's level names MUST be refused.

## 2.3 Records

A record starts with a **header line** at the top level, and its values are the lines inside it.

```
header  = level ": " id [ " of " id ] [ " " detail ]
```

```crubal
product: P-4QX7 of G-2HM8 [origin: reported, via: L-3A0K]
  crubal:wears: OpticalDisc, Movie
  title: National Lampoon's Christmas Vacation
  format: DVD
  releaseDate: 1997-10
  runtime: 97min [origin: observed, via: L-7Q1F]
  videoCodec: _
  hdrFormats: -
  genres: Comedy, Holiday
  rating: PG-13 [region: US]
  work: &W-81CC
  director: &wd:Q311319
  cast:
    - person: &wd:Q310394
      character: Clark Griswold
    - person: &wd:Q229048
      character: Ellen Griswold [origin: declared, via: L-3A0K]
  ebay:Studio: Warner Home Video
  crubal:parts:
    - [row: disc1]
      crubal:wears: Disc
      discFormat: DVD-9

unit: U-9KD2 of P-4QX7 [origin: observed, via: L-9D4E]
  condition: VG
  price: 12.50USD
  crubal:parts:
    - [row: disc1]
      condition: NM
```

- The level names the kind (chapter 1.2). `crubal:kind:` MAY be written and MUST then agree.
- **Envelope lines** are written with the core prefix: `crubal:wears`, `crubal:parts`, `crubal:owner`,
  `crubal:created`, `crubal:updated`. Bare keys are always values, so a package may have a facet named
  `owner` without colliding.
- **The default source** is the header's detail. A source on a value's own detail wins over it.
- A key MUST NOT appear twice in one record, part or compound row.

## 2.4 Values

Without quotes, a value's spelling suggests its shape. The facet decides (chapter 1.4): under a text facet,
`1997` is the text `1997`.

| Spelling | Shape | Notes |
|---|---|---|
| `_` | unknown | the whole value only |
| `-` · `n/a` · `N/A` | does not apply | the whole value only; printers write `-` |
| `&` then a target | link | `&P-4QX7` · `&wd:Q311319` · `&https://…` |
| `97` · `-3` · `2.50` | number | chapter 1.4.2's grammar |
| `97min` · `2.4lb` | quantity | the number, then the unit spelling with no space; readers MAY accept one space |
| `12.50USD` | money | the number, then an ISO 4217 code with no space |
| `1997` · `1997-10` · `1997-10-03` | date | |
| `yes` · `no`, or the facet's words | yes-no | |
| a URL | image, under an image facet | image fields go in the detail (2.6) |
| anything else | text, choice, or raw for an unknown key | |

**Unknown keys.** A Reader MUST keep an unknown key's value as raw: the exact characters after the separator,
with the trailing comment and spaces removed and nothing else changed. A short list under an unknown key stays
one raw value (`a, b` is the raw text `a, b`).

## 2.5 Quoting

A quoted value uses exactly the JSON string syntax (RFC 8259, section 7): `"`, with `\"`, `\\`, `\/`,
`\b`, `\f`, `\n`, `\r`, `\t` and `\uXXXX` escapes. One escape rule serves both forms.

Quotes take the marks' meaning away. A quoted value is never an empty and never a link: `"_"` is the text
`_`, and `"&x"` is the text `&x`. Its inner text is otherwise read by the facet as usual, so `"Blu-ray, 3D"`
is one choice value.

A printer MUST quote a value when any of these is true, and SHOULD NOT quote it otherwise:

1. it starts with a mark: `&`, `_`, `-` (unless the value is a number), `[`, `"`, `{`, or `...`;
2. it contains `: `, ` //` or a comma, or, inside a detail, `]`;
3. it starts or ends with a space, or contains a line break or a control character;
4. it is empty text;
5. it would otherwise read as another shape the facet allows (a text value `yes` under a yes-no-or-text
   facet; a choice value `-`).

A reader MUST accept an unquoted value that rule 2 would quote when no comma split applies: under a
single-valued facet or an unknown key, `title: Star Wars: A New Hope` is the text `Star Wars: A New Hope`.

## 2.6 Detail: qualifiers, sources and rows

A **detail** is `[` pairs separated by `, ` `]`, written after a value with one space between them. Each
pair is `name: value`, and the values follow 2.4 and 2.5.

- `row`, `origin`, `via` and `owner` are reserved (chapter 1.8). `row` is allowed only on a row's own line
  (2.7). The other three are the value's source.
- Under an image facet, `sha256`, `w`, `h` and `type` are the image's fields.
- Every other name is a qualifier: a facet, with its own type.

```crubal
rating: PG-13 [region: US], 15 [region: UK]
cover: https://img.example/p-4qx7.jpg [sha256: 9f2c…, w: 1600, h: 2400, origin: observed]
```

Sources are printed only when asked. A printer has two modes: **full** (envelope lines and sources) and
**plain** (values only). The no-loss guarantee holds in full mode.

## 2.7 Lists, compounds and rows

**Short lists** go on one line, separated by `, `:

```crubal
genres: Comedy, Holiday
```

**Long lists** put each item on its own line under the key:

```crubal
genres:
  - Comedy
  - Holiday
```

- Under a many-valued facet both forms mean the same list. Under a single-valued facet, a comma doesn't
  split.
- `-` alone, `_` alone and `- -` MUST NOT be list items: an empty is the whole value (chapter 1.5).
- An empty list is never written (chapter 1.6).

**A single compound** puts its children on the lines inside it:

```crubal
dimensions:
  height: 7.5in
  width: 5.3in
```

**Compound rows** are list items whose lines are the row's children. The row key goes on the item's own line
as `- [row: key]`, with the children on the lines inside it. When the compound has an identity child, the row
key is derived and MUST NOT be written, and the row starts with its first child on the item line
(`- person: &wd:Q310394`). A row key MUST NOT repeat within its list.

**Parts** are rows of `crubal:parts`, written the same way. Every part MUST carry its row key.

## 2.8 Errors

A reader MUST refuse the input, naming the line and saying what is wrong in plain words, for at least:

- a tab in indentation;
- a quote that is not closed, or a detail whose `[` is not closed;
- an empty as a list item, or inside a detail;
- a key twice in one record, part or row, or a row key twice in one list;
- an unknown top-level key;
- a header whose `of` names a record at the wrong level or of another kind (when the reader can see both);
- a `row` in a detail that isn't on a row's own line, or a row key on a compound whose row keys are derived.

A value that doesn't fit its facet is not a reader error. It is read, kept, and reported as a contradiction
at the Dictionary level (chapter 9).

## 2.9 Printing

The printer writes canonical text:

- the file header, then records in the order received;
- inside a record: envelope lines first (full mode), then values in the order of the record's class
  placement when the printer knows it, otherwise in the order received;
- two spaces per level, `: ` after each key, short lists when every item fits on one line within 100
  characters and no item has a detail with more than one pair, long lists otherwise;
- quotes only by 2.5, and `-` for does not apply.

Layout is not data. Two texts that read to the same pairs are the same data, whatever their order, quoting,
list form or comments.
