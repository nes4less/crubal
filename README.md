# CRUBAL 2: the specification

**Status:** working draft, 2026-10-14. Not yet published. The design it writes down is
`docs/crubal/blueprint.html` (https://claude.ai/artifact/BLJ9DdEZSyqKrW84pLjHQh); where they differ, this spec
is being wrong and gets fixed.

CRUBAL is a language and engine for data about any kind of thing. Everything is a key and a value. Records
are pairs; a facet's definition is pairs about a key; rules, contracts, views and packages are pairs too.
The engine is universal at the kind level: commerce, media and the rest are packages that attach to kinds.

## Chapters

The chapters follow the stack from the bottom. Each refers only to the chapters before it.

| # | Chapter | State |
|---|---|---|
| 1 | [Data and the value model](01-data.md) | draft |
| 2 | [The text form](02-text.md) | draft |
| 3 | [The JSON form](03-json.md) | draft |
| 4 | [Facets](04-facets.md) | draft |
| 5 | [Classes](05-classes.md) | draft |
| 6 | [Rules](06-rules.md) | draft |
| 7 | [Contracts](07-contracts.md) | draft |
| 8 | [Provenance and logs](08-provenance.md) | draft |
| 9 | [Intake and evidence](09-intake.md) | draft |
| 10 | [Migrations](10-migrations.md) | draft |
| 11 | [Packages](11-packages.md) | draft |
| 12 | [Views](12-views.md) | draft |
| 13 | [Conformance](13-conformance.md) | draft |

## Conventions

- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used as in RFC 2119 and RFC 8174, only
  when written in capitals. They are requirements on implementations. The lowercase words `must`, `should`
  and `suggest` in code are CRUBAL rule strengths, a different thing (chapter 6).
- Examples are informative unless marked normative. Text-form examples are in `crubal` blocks, JSON in
  `json` blocks. A `//` note inside a JSON example is for the reader of this spec only; real JSON carries no
  comments.
- `me:` in examples is the Media Encyclopedia package, CRUBAL's first adopter. `wd:` is Wikidata. `crubal:`
  is a placeholder prefix for the core's own names until the spec's home domain is chosen.

## Conformance levels

An implementation claims one level, and every level includes the ones above it in this list.

| Level | An implementation at this level |
|---|---|
| **Reader** | reads and prints the text and JSON forms without loss of pairs (chapters 1–3), applying the types a set of facet definitions gives, and keeps every key it doesn't know |
| **Dictionary** | also reads facets and classes, folds aliases, and checks values against their facets (chapters 4–5) |
| **Rules** | also evaluates rules, and refuses a write that breaks a `must` rule (chapter 6) |
| **Store** | also keeps sources and signed logs, runs intake with raw bytes kept, and applies migration recipes (chapters 8–10) |
| **Exchange** | also runs contracts, offer and take, and verifies signatures across owners (chapters 7, 9, 11) |
| **Views** | also builds stored projections, filter sub-indexes, audiences and roles (chapter 12) |

A claim is proven by passing that level's folder of the [test corpus](corpus/README.md).

## Open in the spec (not in the design)

- The spec's home domain, which replaces the `crubal:` placeholder.
- Long text in the text form: quoted strings with `\n` work, but a readable block form is not designed.
- The units table (UN/CEFACT based) that names which unit spellings are valid.
- Losing values kept as alternatives (an `alternatives` map shaped like `sources`): recommended, awaiting a
  call.
