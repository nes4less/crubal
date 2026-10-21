# MUST coverage

Every MUST in chapters 1–14, and the case that tests it (spec 13.4). "unit" names a test in
`packages/crubal/test/` rather than a corpus case; "open" means no case yet, with the reason. Kept by hand;
a new MUST or a new case updates this file.

| Section | The MUST, in short | Cases |
|---|---|---|
| 1 | text and JSON express exactly one model, either converts to the other | reader/001–013 (each case reads text and checks the canonical JSON; 3.10) |
| 1.2 | level names unique across a package's kinds | package-errors/p07-level-twice |
| 1.2 | a record's level is one of its kind's | package-errors/p05-level-not-of-kind, reader/012-envelope |
| 1.2 | `of` names a record of the same kind at the level directly above | reader-errors/e11-of-wrong-level (within a file), reader/014-offer-level (four levels: an offer of a unit of a product), store/021-attach, store/022-attach-without-edit |
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
| 1.6, 1.10 | a shared part is read through its link: `works[*].genres` in a slot, a filter, a condition | views/021-shared-part-read-through, views/022-rows-by-child |
| 1.10 | a compound's rows are read by child with the wildcard, alone and through a link | views/022-rows-by-child |
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
| 3 | lossless both ways; no duplicate members, no non-finite numbers | reader/001–013 (JSON side), unit: reader.test (null refused; `parseJson` refuses a member named twice in one object, wherever it sits) |
| 3.2 | a member not in the table is refused | unit: reader.test (`checkWrapper`: an unknown member, a missing required one) |
| 3.3 | a number string matches the grammar; a qualifier's value never qualified or empty | reader/001-scalars, reader/006-qualifiers-sources |
| 3.4 | no empty array; no empty item; no two equal items | reader/003-lists, reader/002-empties |
| 3.5 | `$row` derived when there is an identity child, else present and unique | reader/005-rows, reader-errors/e06, e07 |
| 3.7 | every stored value covered by a source; an address naming nothing refused | reader/006-qualifiers-sources (coverage); unit: reader.test (`checkWrapper` refuses a source address that names nothing: a missing key, a list item, a row, a part, or a step below one) |
| 3.8 | a payload is never parsed and re-serialized for storage | store/015-raw-bytes |
| 3.8 | a contradiction carries exactly one `cites`; a unit question cites the unit | dictionary/003-check-outcomes, store/027-unit-question |
| 3.1 | chapter 3's forms arrive as values through a form body: a boolean, `$link`, `$image`, a list item by item | unit: intake-json-forms.test |
| 3.1 | a compound answer as an object is one answer, folded child by child; an empty-string answer is no answer; a bare decimal under a unit facet is that number in the unit | unit: audit-forms-access.test |
| 9.2 | a compound answer whose child contradicts its facet is a contradiction naming the child | unit: audit-forms-access.test |
| 4.8 | a new `must … shown to` rule is visibility, never breaking; a new must rule over data still needs `review` | unit: publish-show-rule.test |
| 3.10 | the same canonical JSON from a text and from its print | reader/001–013 |
| 4.1 | a published version never changes | unit: publish.test (a version is a new bundle; the registry keeps each) |
| 4.2 | the identity child is a link | dictionary-errors/d03-identity-not-link |
| 4.2 | a prefixed setting is carried unchanged and changes nothing | dictionary/001-shorthand-equals-long (`me:` settings carried), reader/010-unknown-block |
| 4.2 | `transitions: yes`: a later value of equal or higher trust replaces the current one as a move, not a conflict | exchange/032-transitions (a form of the same origin moves the state and disputes the plain facet); unit: store.test (land) |
| 4.2.1 | `...` and `fixed: yes` never both | dictionary-errors/d04-open-and-fixed |
| 4.3 | aliases never fold onto another key or value | dictionary-errors/d01-alias-collision, dictionary/002-alias-fold |
| 4.4 | a shortcut and its full rule never both | rules-errors/r03-two-spellings |
| 4.5 | shorthand never drops a setting | dictionary/001-shorthand-equals-long |
| 4.7 | refused at publish | dictionary-errors/* |
| 4.8 | a breaking version ships a recipe | unit: publish.test (recipes required by the diff) |
| 5.3 | a type mark is the facet's own; settings narrow | dictionary-errors/d05-class-widens, dictionary/005-wear-narrowing |
| 5.3.3 | a class is a definition and needs no wearer; wearing is data | dictionary/010-class-without-wearer |
| 5.3.1 | a line never sets meaning | dictionary-errors/d13-line-sets-meaning, d05-class-widens |
| 5.3.2 | asked-when never reads its own facet | dictionary/006-asked-when, rules-errors/r01-cycle (layering) |
| 5.4 | `uses` never cycles; a meet is never empty | dictionary-errors/d06-uses-cycle, d07-empty-meet |
| 5.5 | wearing a class not for the kind refused; an empty meet refused; a class worn above never shed | exchange-errors/e14-wears-not-for-kind, dictionary-errors/d07-empty-meet, dictionary/004-class-resolution, 005-wear-narrowing; pg test: the store refuses at the commit |
| 5.6 | a non-fungible slot never carries a count | dictionary/007-itemize (the contradiction "count on a non-fungible slot") |
| 5.10 | refused at publish | dictionary-errors/* |
| 6.6 | `must` global rules enforced at the Rules level | rules/005-rollup-and-unique, rules/010-unique-per-level |
| 6.8 | no cycle, no contradiction, one spelling, the order said | rules-errors/r01-cycle, r02-contradiction, r03-two-spellings, rules/003-undetermined |
| 6.11 | events and current values give the same results | rules/001-fill-and-derive, store/013-replay |
| 6.11 | an aggregate over a compound's rows, with a row filter | rules/011-rows-and-archived |
| 6.4 | a rollup over a lower level reads the active records; a filter naming `status` reads the archived too | rules/011-rows-and-archived |
| 12.6 | a write to a shared part stales the rows that read it through the link | views/023-shared-part-stale |
| 7.3 | our side of a value map is a real value | exchange-errors/x01-value-map-to-alias |
| 7.5 | never act twice for one key | exchange/006-idempotency, exchange/020-send-restart-once |
| 7.6 | no secret in CRUBAL text or JSON | exchange/005-who (credentials by name); by construction: contracts name credentials, the host holds them |
| 7.6 | `who: caller may edit X` is held by the caller's edges and the menu (14.6), beside roles on the caller's record; a hosted caller with no record is what its edges make it | unit: who-may.test |
| 7.2 | `audience`: the lowest audience that may run a contract, member for a form and public otherwise; refused at publish when it isn't one | unit: contract-audience.test |
| 7.2 | a form a consumer runs on a record they do not own needs no ownership: `audience: member` admits a caller whose edge covers the record; a member with no edge on it is stopped | exchange/033-member-form-on-anothers-record |
| 7.4 | an arrival by a caller is permitted like a run: anywhere by an admin or control edge, or as an admitted member; a stranger starts only a contract that grants the consumer's edge | unit: shown-for-arrivals.test |
| 7.10 | refused at publish | exchange-errors/* |
| 8.5 | a record's writes all go to one chain | store/001-chain-valid; host test: a hosted person's chain holds only their records' writes |
| 8.5 | a witnessed entry is never redacted | store/034-erasure-chain |
| 8.5.3 | a rebuild gives exactly the state the store had | store/014-rebuild, 015-rebuild-redacted, 025-journal; pg test: every corpus log rebuilds the same |
| 9.2 | re-deriving never grows rows | store/008-row-matching |
| 9.4 | `keep-raw` declares `prefix` | exchange-errors/x03-keep-raw-without-prefix |
| 10.1 | a breaking change ships a recipe in the same version | unit: publish.test |
| 10.1 | a store restamps before it accepts data under the new version | store/007-restamp; pg test: install restamps |
| 10.1 | no mapping on read; a receiver on an older version holds the intake | by construction (one version in force); unit: exchange `versionGate` and host.test (a take held under a newer version, restamped under an older) |
| 10.4 | the restamp's result is as if every write came first | store/007-restamp, store/041-retype, store/042-dry-run |
| 10.5 | refused at publish | store-errors/s01-recipe-unknown-value |
| 10.7 | a change that stops projecting a key carries its instruction | store/024-instructions, 029-instruction-order; unit: publish.test (a level line removed without its instruction block is refused; with it the bundle carries the block and the install issues it) |
| 11.1 | `crubal` and the package's own name never remapped; no two prefixes for one identity | package-errors/p03-reserved-prefix |
| 11.1 | a utility serves only presets, relations and audiences the package declares; narrows only to presets, items and relations; a setting is a facet | package-errors/p08-utility-unknown-preset; unit: utility.test (the narrowing and the setting refusals; the block round-trips through its bundle and is listed in `members`) |
| 11.2 | `identify` keys are unique; an extension never removes a vary step | store/016-arrival (bound by identify), rules/010-unique-per-level; package-errors/p01-extends-widens |
| 11.4 | extending never changes or widens | package-errors/p01-extends-widens |
| 11.5 | publishing runs every check; a version never changes | *-errors/* (every folder), unit: publish.test |
| 11.8 | a reader never reads above its version; a package never extends a higher one | reader-errors/e08-higher-language-version, package-errors/p04-extends-higher-language |
| 11.9 | an extension never changes a standard unit | unit: units.test (an extension naming `kg` only adds spellings; the factor stands), dictionary-errors/d10-unknown-unit |
| 12.4 | a role never exceeds its audience | views-errors/v01-role-exceeds-audience |
| 12.3 | a filter over a facet with no value list (a link into a vocabulary) buckets by the values the records carry; a pick selects on one; the counts tally them | views/024-vocabulary-link-buckets; host test: the reference index (counts asked for with `only`) |
| 12.3 | a filter's buckets by period (day, ISO week, month, quarter, year) from a date facet; a facet summed per bucket beside the count; a pick on a period selects | views/025-periods-and-sums; host test: the reference index (`count=` with sums) |
| 5.2 | a class's prefixed settings are carried unchanged, through the bundle | crubal: dictionary.test (`cfu:gpc` on a class) |
| 12.6.1 | an index reads only its streams; serves only matched rows; drops marked slots; pages and counts as 12.2–12.3; says its entry number | views/009-partition, 014-subscriber-partition, 007-roles, 002-filter-counts, 008-paging; host test: the reference index (x-crubal-seq) |
| 12.8 | refused at publish | views-errors/* |
| 13.5 | extensions carried, never required | reader/010-unknown-block, dictionary/001 (`me:` settings) |
| 13.6 | the same results whatever the store's choices | pg test: every corpus log rebuilds to the same state in Postgres as in memory |
| 14.2 | `within` never cycles, never crosses owners; ancestors kept | exchange-errors/e11-within-cycle, e13-within-another-owner, views/009-partition (ancestors) |
| 14.6 | an item naming nothing refused | exchange-errors/x02-undefined-facet |
| 14.6 | a preset may name items of the packages its package extends; a menu item of one name in several packages is one item with every package's verbs; checked when the packages are in force together | unit: bundle.test (a menu item two packages name is one item; a preset of the same name is the later one); the install check is `definitionsOf` + `checkAll` in crubal-postgres, exercised by every install in install.test |
| 14.4 | each mode includes the ones below it; a `see` below admin is the audience's by the show rules (capped at member) or an item's | unit: audit-forms-access.test; host.test 14.8 |
| 12.4 | a show rule's `for` scopes it: a class or kind rule decides for the records it covers, in access and in projections | unit: shown-for-arrivals.test; views/007-shown-for |
| 10.4 | an install two versions ahead restamps through every recipe between, in order; the dry run reports them all | crubal-postgres: install.test |
| 10.4 | a recipe restamps the package's own records (its kinds, its classes) and no other package's holding the same key; a moved value keeps its source | crubal-postgres: install.test |
| 11.4 | one key, one definition: a facet another installed package defines with a different type is refused at install | crubal-postgres: install.test |
| 14.12 | a version dropping a preset or item live edges grant is refused until they lapse | crubal-postgres: install.test |
| 14.12 | a store refuses the listed writes | exchange-errors/e07-grant-above-held, e08-cross-owner-by-admin, e12-person-owns-item, e13-within-another-owner, e14-wears-not-for-kind; pg test: refused at the commit, nothing left behind |
| 14.9 | a system acting for a person never exceeds the person's effective access, never grants onward, never acts under an emergency edge; every such write carries `for` | host test: "acting for a person (14.9)" (runs as the person, capped to the items chosen, suggestions while gated, the entry's `by` carries `caller` and `for`, refused without the person's permission or beyond it); the onward-grant and emergency refusals are in `PgBorder.refuseActing`, exercised by the Agents object's suite later |
| 14.8, 14.12 | a platform-hosted caller is the owner's caller without signature; a grant to one never exceeds what the grantor could grant to anyone | host test: "platform-hosted callers (14.8)" (a person proven by identity served unsigned at another owner; an admin grants them within the chain; a grant above the grantor's mode refused; a person hosted elsewhere is nobody) |
| 14.13 | emergency terms published in advance; an edge without the approvals refused | exchange-errors/e09-emergency-without-terms, e10-emergency-self-approved, exchange/018-emergency-edge |

## Open

None. The two rows that were open (10.1's hold under a newer version, 10.7's publish refusal) closed with
the 2026-10-19 revisions; their unit cases are named above and corpus cases follow at the gate's tag.
