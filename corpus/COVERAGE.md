# MUST coverage

Every MUST in chapters 1–14, and the case that tests it (spec 13.4). "unit" names a test in
`packages/crubal/test/` rather than a corpus case; "open" means no case yet, with the reason. Kept by hand;
a new MUST or a new case updates this file.

| Section | The MUST, in short | Cases |
|---|---|---|
| 1 | text and JSON express exactly one model, either converts to the other | reader/001–013 (each case reads text and checks the canonical JSON; 3.10) |
| 1.2 | level names unique across a package's kinds | package-errors/p07-level-twice |
| 1.2 | a record's level is one of its kind's | package-errors/p05-level-not-of-kind, reader/012-envelope |
| 1.2 | `of` names a record of the same kind at the level directly above | reader-errors/e11-of-wrong-level (within a file), store/021-attach, store/022-attach-without-edit |
| 1.3 | another package's key carries a prefix | reader/007-unknown-keys, package-errors/p03-reserved-prefix |
| 1.3 | compare after resolving, never by nickname | dictionary/002-alias-fold |
| 1.3 | keys case-sensitive, NFC; aliases folded | dictionary/002-alias-fold, dictionary-errors/d01-alias-collision |
| 1.4.2 | numbers kept as decimals, compared by value | reader/001-scalars, dictionary/003-check-outcomes |
| 1.4.4 | a three-letter uppercase spelling is a currency; the units table never names one | dictionary/009-units-convert, dictionary-errors/d10-unknown-unit |
| 1.4.5 | a moment carries its offset | reader/011-time, dictionary/008-time-checks |
| 1.4.10 | raw kept unchanged, never typed by guess | reader/007-unknown-keys |
| 1.5 | an empty is the whole value, never inside a list | reader/002-empties, reader-errors/e02-empty-list-item |
| 1.6 | an empty list is never written | reader/003-lists (print), reader-errors/e02-empty-list-item |
| 1.6 | an identity child is a link | dictionary-errors/d03-identity-not-link |
| 1.6 | a minted row key is never reused | store/008-row-matching, reader-errors/e06-duplicate-row |
| 1.8 | `row`, `origin`, `via`, `owner` never qualifier keys | reader-errors/e09-reserved-qualifier, dictionary-errors/d12-reserved-child |
| 2.1 | a tab in indentation is refused | reader-errors/e01-tab-indent |
| 2.2 | unknown top-level keys refused | reader-errors/e05-unknown-top-level |
| 2.3 | `crubal:kind` agrees with the level | reader-errors/e10-kind-disagrees, reader/012-envelope |
| 2.3 | a key never twice in a record, part or row | reader-errors/e03-duplicate-key |
| 2.4.1 | an unknown key's value kept raw | reader/007-unknown-keys |
| 2.5 | the printer quotes when it must; the reader accepts the unquoted forms | reader/008-quoting |
| 2.7 | `-`, `_`, `- -` never list items | reader-errors/e02-empty-list-item |
| 2.7 | a derived row key is never written; a row key never repeats; parts carry row keys | reader-errors/e07-row-on-identity, e06-duplicate-row, reader/009-parts |
| 2.8 | refusals name the line and say what is wrong | reader-errors/* (every error.txt) |
| 3 | lossless both ways; no duplicate members, no non-finite numbers | reader/001–013 (JSON side), unit: reader.test (null refused); open: duplicate members, which JSON.parse folds before a reader sees them |
| 3.2 | a member not in the table is refused | unit: reader.test (`checkWrapper`: an unknown member, a missing required one) |
| 3.3 | a number string matches the grammar; a qualifier's value never qualified or empty | reader/001-scalars, reader/006-qualifiers-sources |
| 3.4 | no empty array; no empty item; no two equal items | reader/003-lists, reader/002-empties |
| 3.5 | `$row` derived when there is an identity child, else present and unique | reader/005-rows, reader-errors/e06, e07 |
| 3.7 | every stored value covered by a source; an address naming nothing refused | reader/006-qualifiers-sources (coverage); open: the refusal |
| 3.8 | a payload is never parsed and re-serialized for storage | store/015-raw-bytes |
| 3.8 | a contradiction carries exactly one `cites`; a unit question cites the unit | dictionary/003-check-outcomes, store/027-unit-question |
| 3.10 | the same canonical JSON from a text and from its print | reader/001–013 |
| 4.1 | a published version never changes | unit: publish.test (a version is a new bundle; the registry keeps each) |
| 4.2 | the identity child is a link | dictionary-errors/d03-identity-not-link |
| 4.2 | a prefixed setting is carried unchanged and changes nothing | dictionary/001-shorthand-equals-long (`me:` settings carried), reader/010-unknown-block |
| 4.2.1 | `...` and `fixed: yes` never both | dictionary-errors/d04-open-and-fixed |
| 4.3 | aliases never fold onto another key or value | dictionary-errors/d01-alias-collision, dictionary/002-alias-fold |
| 4.4 | a shortcut and its full rule never both | rules-errors/r03-two-spellings |
| 4.5 | shorthand never drops a setting | dictionary/001-shorthand-equals-long |
| 4.7 | refused at publish | dictionary-errors/* |
| 4.8 | a breaking version ships a recipe | unit: publish.test (recipes required by the diff) |
| 5.3 | a type mark is the facet's own; settings narrow | dictionary-errors/d05-class-widens, dictionary/005-wear-narrowing |
| 5.3.1 | a line never sets meaning | dictionary-errors/d13-line-sets-meaning, d05-class-widens |
| 5.3.2 | asked-when never reads its own facet | dictionary/006-asked-when, rules-errors/r01-cycle (layering) |
| 5.4 | `uses` never cycles; a meet is never empty | dictionary-errors/d06-uses-cycle, d07-empty-meet |
| 5.5 | wearing a class not for the kind refused; an empty meet refused; a class worn above never shed | exchange-errors/e14-wears-not-for-kind, dictionary-errors/d07-empty-meet, dictionary/004-class-resolution, 005-wear-narrowing; pg test: the store refuses at the commit |
| 5.6 | a non-fungible slot never carries a count | dictionary/007-itemize (the contradiction "count on a non-fungible slot") |
| 5.10 | refused at publish | dictionary-errors/* |
| 6.6 | `must` global rules enforced at the Rules level | rules/005-rollup-and-unique, rules/010-unique-per-level |
| 6.8 | no cycle, no contradiction, one spelling, the order said | rules-errors/r01-cycle, r02-contradiction, r03-two-spellings, rules/003-undetermined |
| 6.11 | events and current values give the same results | rules/001-fill-and-derive, store/013-replay |
| 7.3 | our side of a value map is a real value | exchange-errors/x01-value-map-to-alias |
| 7.5 | never act twice for one key | exchange/006-idempotency, exchange/020-send-restart-once |
| 7.6 | no secret in CRUBAL text or JSON | exchange/005-who (credentials by name); by construction: contracts name credentials, the host holds them |
| 7.10 | refused at publish | exchange-errors/* |
| 8.5 | a record's writes all go to one chain | store/001-chain-valid; host test: a hosted person's chain holds only their records' writes |
| 8.5 | a witnessed entry is never redacted | store/034-erasure-chain |
| 8.5.3 | a rebuild gives exactly the state the store had | store/014-rebuild, 015-rebuild-redacted, 025-journal; pg test: every corpus log rebuilds the same |
| 9.2 | re-deriving never grows rows | store/008-row-matching |
| 9.4 | `keep-raw` declares `prefix` | exchange-errors/x03-keep-raw-without-prefix |
| 10.1 | a breaking change ships a recipe in the same version | unit: publish.test |
| 10.1 | a store restamps before it accepts data under the new version | store/007-restamp; pg test: install restamps |
| 10.1 | no mapping on read; a receiver on an older version holds the intake | by construction (one version in force); open: holding an intake written under a newer version |
| 10.4 | the restamp's result is as if every write came first | store/007-restamp, store/041-retype, store/042-dry-run |
| 10.5 | refused at publish | store-errors/s01-recipe-unknown-value |
| 10.7 | a change that stops projecting a key carries its instruction | store/024-instructions, 029-instruction-order; open: the publish refusal |
| 11.1 | `crubal` and the package's own name never remapped; no two prefixes for one identity | package-errors/p03-reserved-prefix |
| 11.2 | `identify` keys are unique; an extension never removes a vary step | store/016-arrival (bound by identify), rules/010-unique-per-level; package-errors/p01-extends-widens |
| 11.4 | extending never changes or widens | package-errors/p01-extends-widens |
| 11.5 | publishing runs every check; a version never changes | *-errors/* (every folder), unit: publish.test |
| 11.8 | a reader never reads above its version; a package never extends a higher one | reader-errors/e08-higher-language-version, package-errors/p04-extends-higher-language |
| 11.9 | an extension never changes a standard unit | unit: units.test (an extension naming `kg` only adds spellings; the factor stands), dictionary-errors/d10-unknown-unit |
| 12.4 | a role never exceeds its audience | views-errors/v01-role-exceeds-audience |
| 12.6.1 | an index reads only its streams; serves only matched rows; drops marked slots; pages and counts as 12.2–12.3; says its entry number | views/009-partition, 014-subscriber-partition, 007-roles, 002-filter-counts, 008-paging; host test: the reference index (x-crubal-seq) |
| 12.8 | refused at publish | views-errors/* |
| 13.5 | extensions carried, never required | reader/010-unknown-block, dictionary/001 (`me:` settings) |
| 13.6 | the same results whatever the store's choices | pg test: every corpus log rebuilds to the same state in Postgres as in memory |
| 14.2 | `within` never cycles, never crosses owners; ancestors kept | exchange-errors/e11-within-cycle, e13-within-another-owner, views/009-partition (ancestors) |
| 14.6 | an item naming nothing refused | exchange-errors/x02-undefined-facet |
| 14.12 | a store refuses the listed writes | exchange-errors/e07-grant-above-held, e08-cross-owner-by-admin, e12-person-owns-item, e13-within-another-owner, e14-wears-not-for-kind; pg test: refused at the commit, nothing left behind |
| 14.13 | emergency terms published in advance; an edge without the approvals refused | exchange-errors/e09-emergency-without-terms, e10-emergency-self-approved, exchange/018-emergency-edge |

## Open

The rows marked "open" are MUSTs without a case because the engine doesn't enforce them yet: duplicate
JSON members (3; `JSON.parse` folds them before a reader sees them, so refusing them needs a parser of
our own), a source address naming nothing (3.7; in the text form every source rides on its value, so only
the JSON form can name nothing), an intake written under a newer package version held until the receiver
upgrades (10.1; needs the version an intake was written under on the wire), and the publish check that a
change which stops projecting a key carries its instruction (10.7; instructions are issued at run time
today, not published in a bundle). The first two are small; the last two are design before code.
