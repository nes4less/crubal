# 11. Packages

A **package** is what gets published: a named, versioned set of facets, classes, rules, contracts, views and
recipes, with the kinds they work on, the packages they build on, and the trust order that settles
disagreements. Our catalog is a package; so is commerce; so will be anyone else's.

## 11.1 The package file

```crubal
package: me /2026-10-13
  owner: mediaencyclopedia.com
  label: Media Encyclopedia
  crubal: 2
  licence: CC-BY-4.0
  extends: commerce /2026-10-01, media /2026-10-01
  prefixes:
    commerce: crubal.com/commerce
    media: crubal.com/media
    wd: https://www.wikidata.org/entity/
    schema: https://schema.org/
    ebay: ebay.com
  units: crubal.com/units /2026-10-15
  confirm: 2
  split: 3
```

| Setting | Holds |
|---|---|
| `package` | the package's **name** and **version** |
| `owner` | the domain that owns the names and signs the package. The package's full **identity** is `owner/name`: `mediaencyclopedia.com/me`, globally unique because only the domain's owner can publish under it |
| `label` · `describe` | what people see |
| `crubal` | the language version it is written in |
| `licence` | an SPDX licence identifier |
| `extends` | the packages it builds on, each pinned to a version (11.4) |
| `prefixes` | nicknames its files use, each mapped to a full identity: a package (`domain/name`), a vocabulary's base URL, or a party's domain. The package's own name is its default nickname for itself |
| `units` | the units table it uses, pinned by identity and version (11.9) |
| `confirm` · `split` · `recur` | thresholds: independent observations to confirm a value (default 2), instances to propose a version split (default 3), distinct records before a recurring notable or unknown key is proposed as a facet (default 5) (chapter 9) |
| `trust` · `facet-trust` | the trust order (11.3) |
| `terms` | how each audience may use what it's shown: `public: search yes, answer yes, train no` (chapter 12.5.1) |

The rest of the package is its member files: `facet:`, `class:`, `rule:`, `contract:`, `kind:`, `view:`,
`shape:`, `filter:`, `role:` (chapter 12), `migration:`, `permissions:` and `ownership:` (chapter 14)
blocks, in any number of files. A package MAY also publish **reference records** (data files in
the text form, chapter 2) that others read but don't own copies of: the units table is one.

**Prefixes are nicknames.** Identity is always the full `domain/name`; a prefix only abbreviates it inside a
package or a wrapper, and readers compare after resolving (chapter 1.3). Two packages may use different
nicknames for one identity, or one nickname for different identities, without clashing.

**Reserved prefixes.** `crubal` names the core, wherever its home turns out to be. A package MUST NOT map its
own name, or `crubal`, to anything else, and within one package two prefixes MUST NOT name the same identity.

## 11.2 Kinds

Kinds are declared in packages (chapter 1.2):

```crubal
kind: item
  levels: group, product, unit
  base: Item
  schema:
    group: schema:ProductGroup
    product: schema:Product
    unit: schema:Offer
  vary:
    product: edition, size, colour
    unit: condition, price, sealed
  follows:
    label: edition
    weight: size
  identify:
    product: asin
    unit: serial
  match:
    product: gtin; title + format + releaseDate
  archive: independent
```

| Setting | Holds |
|---|---|
| `levels` | the levels, top to bottom |
| `base` | the class every record of the kind wears |
| `schema` | the schema.org type, one for the kind or one per level |
| `vary` | for each level below the top, the facets that vary at the step into it (chapter 1.7). At the step into `product`, these are the group's **forks** (edition, size × colour), which shoppers pick along |
| `follows` | facets that follow a fork (Label follows Edition): they are dependent, so filters count them together |
| `identify` | per level, the **strong** keys: a value held by one record names that record, so an arrival carrying it is bound there (chapter 9.2a). Each MUST also be `unique` within the level |
| `match` | per level, the **weak** keys, separated by `;`: an arrival sharing one is probably the same record and goes to review, never bound by itself. `a + b` means all of them together. A key that real data reuses (a recycled barcode) belongs here, not in `identify` |
| `archive` | what archiving a record does to the records below it: `cascade of`, `cascade within` or `cascade both` (they are archived too, with reason `parent archived`, along that link) or `independent` (the default) (chapter 1.12) |

Classes add vary steps for their wearers with level prefixes (chapter 5.3.3). A package that `extends`
another MAY add levels' vary steps to that package's kinds; it MUST NOT remove any.

## 11.3 The trust order

When two sources disagree (a conflict, chapter 9.3), the trust order picks the current value.

```crubal
trust:
  person
  me:unitizer
  observed
  declared
  distributor.example
  reported
facet-trust:
  runtime: observed, person
  weight: observed, person
```

- Each entry is `person` (a person's write through any form), a contract name, a party's domain, or an origin
  (`observed`, `declared`, `derived`, `reported`).
- A source's rank is its first matching entry: a person's write matches `person`; a value from a contract
  matches the contract, then its origin; a value from another owner matches the domain, then its origin.
- Of two sources, the one ranked earlier wins. Equal ranks keep the current value.
- A source matching no entry ranks last.
- `facet-trust` gives a facet its own order, tried before the package's: a source matching an entry of the
  facet's order ranks by that entry; a source matching none of them ranks after all of them, by its place in
  the package's order.
- The default order, when a package has none, is `person`, `observed`, `declared`, `reported`, `derived`.

Adopted values (chapter 8.2) are outside the trust order: they don't change until they are given back.

## 11.4 Versions and extending

- **A package version is a frozen set** of its members' versions. Publishing produces a members list naming
  every facet, class, rule, contract, kind, view, shape, filter, recipe and permission declaration with its
  version, and the package's version names that list.
- **Inside a package, everything follows current.** Its own members always refer to each other's current
  versions. The owner's **working package** is the set of its members as they now stand: every change to a
  member is a `define` write in the owner's log (chapter 8.5), made by a person or by a review decision
  (chapter 9.5), so the working package is rebuilt from the log like the data is. Publishing cuts a version
  from it (11.5); nothing else does.
- **Outside, adopters pin.** `extends: commerce /2026-10-01` uses exactly that version until the package
  moves its pin, which is itself a new version of the package.
- **Extending** (UCP's word, kept for packages and contracts) lets a package add facets, classes, rules,
  contracts and views, add aliases and values to the extended package's facets, add vary steps, and narrow
  its classes in classes of its own. It MUST NOT change the extended package's definitions or widen them.
- A new package version that breaks its members (chapter 4.8) ships the recipes (chapter 10).

## 11.5 Publishing

A package is published as a **bundle**: its files, in the text form or JSON, the members list, the recipes
since the previous version, and the owner's signature over the bundle's hash.

Publishing MUST run, and the bundle MUST pass, every well-formedness check:

| Chapter | Checks |
|---|---|
| 4.7 | definitions |
| 5.10 | classes |
| 6.8 | rule sets: layering, contradictions, one spelling |
| 7.10 | contracts, including that no secret appears |
| 10.5 | recipes |
| 11.1–11.4 | prefixes, kinds, trust order entries name real contracts and origins, `extends` doesn't widen |
| 12.8 | views, shapes, filters and roles |
| 14.6 | permission menus, presets, relations and ownership |

A published version MUST NOT change. A mistake is fixed by a new version.

## 11.6 The JSON form

```json
{
  "package": "me",
  "version": "2026-10-13",
  "owner": "mediaencyclopedia.com",
  "id": "mediaencyclopedia.com/me",
  "crubal": "2",
  "licence": "CC-BY-4.0",
  "extends": [ { "package": "crubal.com/commerce", "version": "2026-10-01" } ],
  "prefixes": { "commerce": "crubal.com/commerce", "wd": "https://www.wikidata.org/entity/" },
  "units": { "package": "crubal.com/units", "version": "2026-10-15" },
  "trust": ["person", "me:unitizer", "observed", "declared", "reported"],
  "facet-trust": { "runtime": ["observed", "person"] },
  "members": { "facet:videoCodec": "2026-10-13", "class:OpticalDisc": "2026-10-13" }
}
```

## 11.7 The home: crubal.com

**The core** is the package `crubal.com/core`, and the prefix `crubal` always names it. Its names (envelope
lines, origins, audiences, the core facets `crubal:notables`, `crubal:count` and `crubal:clonedFrom`, the
shape `crubal:portable`) are fixed by this specification.

**The standard packages** are published by crubal.com for anyone to extend:

| Identity | Holds |
|---|---|
| `crubal.com/core` | the core's names |
| `crubal.com/units` | the units table (11.9): units by dimension, with factors, offsets and accepted spellings, and ISO 4217 currencies |
| `crubal.com/party` | the `person`, `organization` and `system` kinds, their base classes, and the caller facets that edges, contracts and the trust order read (chapter 14) |
| `crubal.com/product` | the `item` kind (group > product > unit) and the base product facets |
| `crubal.com/service` | the `service` kind (service > booking) and the base service facets |
| `crubal.com/commerce` | stock, offers, prices and shipping, attached to products and services |
| `crubal.com/media` | films, shows, music and games: formats, codecs, regions, contained works, cast |

**Where a package is.** A package's identity `domain/name` resolves through the domain's **well-known file**:

```
https://<domain>/.well-known/crubal.json
```

```json
{
  "crubal": "2",
  "owner": "crubal.com",
  "keys": { "crubal.com": { "alg": "Ed25519", "public": "…" } },
  "packages": [
    { "package": "crubal.com/product", "latest": "2026-10-14",
      "versions": { "2026-10-14": "https://crubal.com/product/2026-10-14/package.json" } }
  ]
}
```

- `keys` holds the owner's published signing keys (chapter 8.5), and MAY list keys of the people it hosts
  by their IDs (chapter 14.1); a party with no published key has unsigned data, which readers MAY refuse.
- `emergency`, for a platform that hosts owners: its emergency-access terms (chapter 14.13), as
  `{"approvers": 2, "longest": "PT24H", "notify": "…", "keys": {…}}`, with the separate keys its approvers
  sign with. A platform without it can make no emergency edge.
- Each package lists its versions and where each version's bundle is: the package's definitions in the JSON
  form, the same as its text files read through a Reader (chapters 4.6, 5.9, 6.10, 7.9, 10.6, 11.6).
- A domain MAY also serve its packages as text, beside the JSON (`…/package.crubal`).

crubal.com serves the standard packages at `https://crubal.com/<name>/`, a page for people, with each version
at `https://crubal.com/<name>/<version>/package.crubal` and `…/package.json`.

**The registry.** `https://crubal.com/registry/` lists known packages from any domain, and
`https://crubal.com/registry/index.json` lists the same as data. Listing is optional and never changes where a
package is or who owns it: the owner's well-known file is the truth. A package is listed by adding its
identity to the registry file in the CRUBAL repository.

## 11.8 Language versions

`crubal: 2` names the **language version**: a whole number. The specification and its corpus are dated
within it (chapter 13.3), and a dated revision only **adds**: a setting, a part, a write kind, a verb, a
shape. A reader at a later date reads everything written at an earlier date of the same version, and
carries what it doesn't know unchanged (chapter 13.5).

**What a new version is for.** The next whole number is for a change that breaks what readers already
hold: the text form (chapter 2), the JSON form or its tags (chapter 3), the envelope (chapter 1.1), the
canonical form and so every hash (chapter 3.9), or the meaning of a setting, part, verb or write that
exists. Nothing else moves the number.

**Reading across versions.**

- A reader at version N reads N and every version below it.
- A reader MUST NOT read above its version: it refuses a file, naming the line that says so, and holds an
  intake until it upgrades (chapter 10.1), never guessing.
- A border wrapper names the version of what it carries (chapter 3.8), so two owners at different versions
  exchange data only in the lower one, which the higher reads.

**Packages move by publishing.** A package names the version it is written in, and MUST NOT extend a
package at a higher one: it could not read it. A package moves to N+1 by publishing a new package version
written in it; adopters pin (11.4), so each moves when it is ready and nothing moves under it.

**Data moves by a form recipe.** With the specification of N+1, crubal.com publishes a **form recipe**: a
deterministic transformation of canonical JSON from N to N+1, proven by corpus cases of its own. A store
that upgrades applies it to its records, its working package and its projections, as it applies a package
recipe (chapter 10.4): intake records keep their bytes, and replay folds them under the new form.

**The log keeps its past.** Entries written under N stay as written: an entry carries `crubal` when its
version differs from the entry before it, and each entry's hash and signature verify under the canonical
form of its own version (chapter 8.5). A chain therefore reads as segments, one per version, and a rebuild
(chapter 8.5.3) applies each entry under its own form and the form recipes between.

## 11.9 The units table

The units table is the package `crubal.com/units` (11.7): **reference records**, one per unit and one per
currency, that every package pins (`units:`) and every store reads the same way. Quantities (chapter 1.4.3)
name its spellings, intake folds through it (chapter 9.2), facets convert by it (chapter 4.2) and recipes
convert by it (chapter 10.3). The table is data, not core: a store with a different pin converts
differently, and that is the pin's job.

**A unit** is a record of the kind `measure`: its ID is the canonical spelling (`min`, `floz`, `°C`), and it
holds its `dimension`, its `factor` to the dimension's base unit, an `offset` when its zero isn't the base's
(`°C`: an amount in base units is amount × factor + offset), its accepted `spellings`, and its UN/CEFACT
code as `uncefact`, never as a spelling. A dimension's base unit has factor 1 and states the `rounding` a
conversion keeps. **A currency** is a record of the kind `currency`: its ISO 4217 code, its name and its
minor-unit `places`, for a border that asks for cents (chapter 1.4.4). A three-letter uppercase spelling is
always a currency and never a unit.

- **Conversion** goes through the base: an accepted unit's amount becomes the facet's unit by the two
  factors and offsets, kept to the facet's `places` when it has them, else to the dimension's rounding at
  most. Units convert only within one dimension.
- **Compound units** (`km/h`, `kWh`) are listed as units of their own, with their dimension and factor.
  There is no grammar of products and quotients.
- **Spellings are folding aliases** (chapter 4.3): case, spaces and punctuation runs fold before matching,
  so `MIN`, `min.` and `Min` need no entry, and a spelling in another language is one more alias. There is
  no localization machinery.
- **The first table** holds time, length, mass, volume, area, temperature, data and count, and the
  currencies the standard packages use. It grows by dated versions of the package, additions only.

**Extending the table.** A package MAY publish units of its own, prefixed like everything else of its own
(`me:slab`), as `measure:` records with a dimension, a factor to the base where one exists, and spellings;
and it MAY add `spellings` to a standard unit by a record of that unit's name holding only `spellings`. It
MUST NOT change a standard unit's factor, offset, dimension or canonical spelling. A store's table in force
is the standard table at its pin plus the owner's extension. When a store moves its pin to a newer standard
table, a unit of its extension that now matches a standard unit by UN/CEFACT code folds into it, the
extension keeping its spellings as aliases: an install and restamp (chapter 10), never a lookup.

**A unit question.** A quantity whose spelling folds to no unit of the table in force is not a
contradiction and not a unit: it is a **unit question** for review (chapter 9.5), the field landing as `new`
with `cites: {"unit": <spelling>}` and the raw text kept on the intake record. Review decides once, by
spelling across every record it reached: an alias (the spelling joins a unit's `spellings`), a new unit
(dimension, factor or offset, code; it joins the extension), or not a unit (the field stays raw). Each
decision is a `review` write and a `define` write (chapter 8.5), and the held intakes replay. A store MAY
look the spelling up (UN/CEFACT, UCUM, an AI) to **propose** an answer, shown beside the evidence; it never
applies one. Nothing in the table is created because it was seen.
