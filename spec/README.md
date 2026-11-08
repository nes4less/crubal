# CRUBAL 2: the specification

**Status:** CRUBAL 2 · 2026-11-13 (revision 32 after the gate: groupings: a lane's `group:` names one of its view's filters, whose buckets group the row's cards, 12.10, and a utility's `group:` names the group it stands in where a room segments its rows, 11.1; revision 31 on 2026-11-12: following by aspect: a kind's `follow:` names per level what a follower may choose to hear, 11.2, an act's `tells:` the post it lands when the record or an ancestor is followed, with `owner`, `run` and `link record` among a set's sources, 15.1, the plain `follower` edge at the owner and the aspects kept by the follower, 14.10; revision 30 on 2026-11-11: a package leaves a place by an install write with `left`, refused while anything in force stands on it or a record holds a value under its own key, 11.4; revision 29 on 2026-11-10: an act's set may link the caller, the person running it, or clear a facet with `none`, 15.1; revision 28 the same day: a print's `image` element, a picture from the place's mark or an image facet, 12.12; revision 27 the same day: a print's text wraps into `lines n`, 12.12; revision 26 on 2026-11-09: an act routes through a rack of rules on a record, mints a record when a `first` find answers nothing, numbers it from a series, counts records for a then to read, sets several at once with the moment and sends when a then holds, reads a context record's facet and a linked record's, and `replaces` another act of its utility, chapter 15; revision 25 on 2026-11-08: acts as declarations, chapter 15: an `act:` member with its level, context, finds, sets, thens, send and landing, the engine answering the writes a landing makes, the app keeping the transports; revision 24 on 2026-11-07: a member that holds no value, a view, shape, filter, display, print, lane or flow, retires without a recipe step, 10.5; revision 23 on 2026-11-06: a flow's `context`, the kinds it holds through its run, and `replaces`, the flow it stands in for, 12.11, and `edit flows` among a menu item's targets, 14.6; revision 22 the same day: a flow's stamps and its chain: a lane stop's done is the stamp its act leaves, a block stop stamps the next lane's pick, consecutive lane stops chain done to pick and the flow's done is its last lane's, a gap refused at publish, 12.11; revision 21 the same day: a print, a label design carried by a package, `print:`, what it prints, its inches, its fields from facets or the brand's slots, its elements on the art's normalized boxes, 12.12, and `def:print` among a link's definition sorts, 4.2.2; revision 20 on 2026-11-04: a link may name a definition, `to: def:facet` and the other sorts, its value `def:<sort>:<name>`, resolved through the dictionary and a facet's aliases, a name nobody holds kept and flagged, 4.2.2, 3.3; and a color type, `%`, a hex code `#RRGGBB`, a name, or a name with its hex code, 1.4.9a, 2.4, 3.3, 4.5; revision 19: an image line names several photo slots, and an image value the slot it fills, 5.3.3; revision 18: a record says what brought each worn class, `carriers`, and a carrier leaving takes off only what it alone brought, 1.1, 5.5, 8; revision 17: a lane without a pick is a list, every record its view serves, no done and no history, never counted as waiting, 12.10; revision 16: a form names its utility and the act it asks for, `utility` and `act`, one form per act, 7.7, 11.1; revision 15 on 2026-11-02: the flow, an objective's line of stops over a package's lanes and forms, 12.11; revision 14: a form's role, `make`, `keep` or `act`, absent read as keep, any other word refused, 7.7; revision 13: a utility has a mark, a glyph and a hue from eight words, worn wherever the utility shows, 11.1; revision 12: a pin names the least version, a later one held satisfies it, and a dependency is never installed older than the version in force, 11.4; revision 11: a view partitioned by a link facet, `linked <facet>`, serving each person what is addressed to them, 12.2, 12.6, 14.10; revision 10 the same day: lanes, the rows of the grid (first called subjects in revision 9, renamed for the Market's older subject), 12.10, and a utility's acts, 11.1; revision 8: the `hand` verb, a key passing from one package to another with its values in place, 10.3, 10.5, 11.4; revision 7 on 2026-10-27, the same day: ending an edge within authority, 14.5; a parts step is a backfill that rides a version where nothing broke and makes nothing twice, 10.3; revision 6: parts, 1.6, 1.7, 3.6, 5.6, 8, 9.2, 10.3, 11.5: a unit mirrors the parts above and owns on each only its level's lines; an incoming part binds by its row, the match child, review or a new row; the `parts` verb turns a compound's rows into parts where a class declares the slot, its compound left to the install when the baseline holds it; parts in the log as envelope and value writes at `parts[row]`; a stream run a page at a time, 12.6.2; revision 5 on 2026-10-24: the root is the last ancestor, 14.2, 14.3; revision 4 on 2026-10-23: a record may follow another owner's public record by its number, or adopt a fold, its public projection reading theirs beneath its own at serve, 12.6; revision 3 on 2026-10-22: a `display:` definition, a template for a screen over a view, carried like a shape, 12.9; revision 2 on 2026-10-21: a filter over a facet with no value list buckets by the values records carry, by period from a date, and sums facets per bucket, 12.3; a class's prefixed settings carried, 5.2; revision 1 on 2026-10-20: link steps read shared parts, row aggregates with a filter, rows by child). Published at the gate on 2026-10-19 (docs/design/release.md); a dated revision only adds (chapter 11.8). This spec is the source of truth for the language;
the design review that produced it is recorded in Media Encyclopedia's blueprint, which it supersedes.

CRUBAL is a language and engine for data about any kind of thing. Everything is a key and a value. Records
are pairs; a facet's definition is pairs about a key; rules, contracts, views and packages are pairs too.
The engine is universal at the kind level: commerce, media and the rest are packages that attach to kinds, each
published by its own owner; crubal.com itself publishes only the core, the units and the parties (chapter 11.7).

## Chapters

The chapters follow the stack from the bottom. Each refers only to the chapters before it, except chapter 14
(Access), which chapters 1, 7 and 12 point to.

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
| 14 | [Access](14-access.md) | draft |
| 15 | [Acts](15-acts.md) | draft |

## Conventions

- **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** are used as in RFC 2119 and RFC 8174, only
  when written in capitals. They are requirements on implementations. The lowercase words `must`, `should`
  and `suggest` in code are CRUBAL rule strengths, a different thing (chapter 6).
- Examples are informative unless marked normative. Text-form examples are in `crubal` blocks, JSON in
  `json` blocks. A `//` note inside a JSON example is for the reader of this spec only; real JSON carries no
  comments.
- `me:` in examples is the Media Encyclopedia package, CRUBAL's first adopter. `wd:` is Wikidata. `crubal:`
  is the core, `crubal.com/core` (chapter 11.7).
- **Product, unit, catalog, disc and the like are adopters' words** (a platform's commerce package, a tenant's media package). They appear in
  this spec only as examples. The core knows kinds, levels, records, classes and views; nothing in it is
  defined in terms of a product or a unit.
- **Named parties and tools are examples too.** eBay, Wikidata, a distributor, a platform such as
  Cashierfu, a bench tool such as `me:unitizer`: each stands in for any system, party or contract of its
  kind. CRUBAL defines none of them, depends on none of them, and reads the same with other names.

## Conformance levels

An implementation claims one level, and every level includes the ones above it in this list.

| Level | An implementation at this level |
|---|---|
| **Reader** | reads and prints the text and JSON forms without loss of pairs (chapters 1–3), applying the types a set of facet definitions gives, and keeps every key it doesn't know |
| **Dictionary** | also reads facets and classes, folds aliases, and checks values against their facets (chapters 4–5) |
| **Rules** | also evaluates rules, and refuses a write that breaks a `must` rule (chapter 6) |
| **Store** | also keeps sources and signed logs, runs intake with raw bytes kept, and applies migration recipes (chapters 8–10) |
| **Exchange** | also runs contracts, offer and take, and verifies signatures across owners, and decides access (chapters 7, 9, 11, 14) |
| **Views** | also computes stored projections with their filter buckets, audiences and roles, publishes the projection stream, and serves it through an index, its own or any that conforms (chapter 12) |

A claim is proven by passing that level's folder of the [test corpus](../corpus/README.md).

## Open in the spec (not in the design)

Nothing at present. What a chapter leaves open, it says in its last section.
