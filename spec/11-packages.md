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
    commerce: crubal.example/commerce
    media: crubal.example/media
    wd: https://www.wikidata.org/entity/
    schema: https://schema.org/
    ebay: ebay.com
  units: crubal:units /2026-10-14
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
| `units` | the units table it uses, pinned |
| `confirm` · `split` · `recur` | thresholds: independent observations to confirm a value (default 2), instances to propose a version split (default 3), distinct records before a recurring notable or unknown key is proposed as a facet (default 5) (chapter 9) |
| `trust` · `facet-trust` | the trust order (11.3) |
| `terms` | how each audience may use what it's shown: `public: search yes, answer yes, train no` (chapter 12.5.1) |

The rest of the package is its member files: `facet:`, `class:`, `rule:`, `contract:`, `kind:`, `view:` and
`migration:` blocks, in any number of files.

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
```

| Setting | Holds |
|---|---|
| `levels` | the levels, top to bottom |
| `base` | the class every record of the kind wears |
| `schema` | the schema.org type, one for the kind or one per level |
| `vary` | for each level below the top, the facets that vary at the step into it (chapter 1.7). At the step into `product`, these are the group's **forks** (edition, size × colour), which shoppers pick along |
| `follows` | facets that follow a fork (Label follows Edition): they are dependent, so filters count them together |

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
  every facet, class, rule, contract, kind, view and recipe with its version, and the package's version
  names that list.
- **Inside a package, everything follows current.** Its own members always refer to each other's current
  versions.
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
  "extends": [ { "package": "crubal.example/commerce", "version": "2026-10-01" } ],
  "prefixes": { "commerce": "crubal.example/commerce", "wd": "https://www.wikidata.org/entity/" },
  "units": { "package": "crubal:units", "version": "2026-10-14" },
  "trust": ["person", "me:unitizer", "observed", "declared", "reported"],
  "facet-trust": { "runtime": ["observed", "person"] },
  "members": { "facet:videoCodec": "2026-10-13", "class:OpticalDisc": "2026-10-13" }
}
```

## 11.7 Open

- The registry where packages are found, and the spec's home domain.
- Language versions: what a `crubal: 3` would break, and how a package moves.
- The standard units table itself.
