# 12. Views

A **view** is a curated display that data is mapped into: a selection of records, given a shape. Catalogs,
carousels, search results, landing pages and a product's own page are all views. Views read; they never
write. Like contracts, they refer only to rules, classes and facets.

A view has two halves. **The store decides**: which records, which values, for which audience, because that
needs the rules and the audience. **An index serves**: pages, counts, search and caching, because that is
performance and presentation (12.6).

## 12.1 Shapes

A **shape** is the display side of a view: named slots, filled by map lines exactly like a send contract's
`writes` (chapter 7.3), in the direction values flow.

```crubal
shape: card
  slots:
    cover -> image
    listingTitle -> heading
    "{format} · {releaseDate}" -> line
    least of unit::price -> price
    count of unit::status -> available
```

- The left side of a slot line is an address, an aggregate (chapter 6.3), a template (chapter 6.4.1) or a
  literal. Nothing else: a shape never computes.
- A slot whose value is empty is left out of the projection. A shape MAY mark a slot `!` to drop the record
  from the view when that slot is empty (`!cover -> image`).
- One shape serves many views: the same `card` in a catalog, a carousel and search.
- **Machine shapes** (`format: json`, `json-ld` or a package-defined feed such as a UCP catalog) give the
  same projection to software instead of people: agents and feeds get complete, structured facets without
  reading pages. A view MAY name several shapes (`shape: card, feed`); they share one selection, one
  projection's freshness and one read set.
- **The portable shape.** The core package defines `crubal:portable`, the default machine shape: every
  value as `{"key", "label", "type", "value"}`, where `value` may be empty but the other three are always
  present, and every further member is advisory. A consumer that knows nothing of CRUBAL reads the four and
  ignores the rest.
- **Page shapes** describe a whole page over one record. Their slots MAY hold other views, which then run with
  the page's record as their context (12.2, `of`).

## 12.2 Views

```crubal
view: dvds
  label: DVDs
  select:
    level: product
    wears: OpticalDisc
    when: format is DVD and count of unit::status over 0
  pin: P-4QX7, P-9KD2
  hide: P-1AAA
  order: releaseDate after, title
  page: 48
  shape: card
  filters: condition, genres, decade
  index: genres, decade
  show: public
  fresh: write
```

| Part | Holds | Default |
|---|---|---|
| `select` | which records: a `level`, the classes they `wear` (all of them must be worn), and a `when` condition (chapter 6.3); or `list: L-…`, a hand-made list | required |
| `of` | for a view inside a page: how the page's record narrows the selection, as a condition over `context` (`work is context.work and not id is context.id`) | none |
| `pin` · `hide` | curation: records shown first, in this order · records never shown | none |
| `order` | keys to sort by, in priority order; `after` means newest or largest first, `before` the reverse | ID |
| `page` | records per page | 24 |
| `shape` | the shape every record takes; several for several outputs (`card, feed`) | required |
| `filters` | the filters shoppers can pick from (12.3) | none |
| `index` | the filters whose buckets get their own indexable pages (12.5) | none |
| `show` | the audience the view is for (12.4) | `public` |
| `fresh` | `write`, or a delay such as `5m` (12.6) | `write` |
| `terms` | how each audience may use what it's shown (12.5.1) | the package's `terms` |

**Catalogs** are views whose selection is by worn classes, so "which catalog is this in" is a global rule
(chapter 6.6) the engine answers from the views' selections. **"Also on other formats"** is a view inside a
product page: `select: level: product`, `of: work is context.work and not id is context.id`. **Related-by-facet
carousels** are views selected by a shared facet value. **Hand-made lists** are records (an ordered set of
links with a name and an owner), and a view shows one with `select: list: L-…`.

**How a group is shown** (its products as separate pages, or as options on one page) is a page shape's choice:
a group page whose slots hold a view of its products, or product pages that each link their siblings.

## 12.3 Filters

A **filter** is a sub-index inside its view: for each **bucket**, the records of the view's selection that
fall into it.

```crubal
filter: condition
  facet: unit::condition
  buckets:
    "Like new": NM, VG
    Good: G
    Fair: F, P

filter: decade
  facet: releaseDate
  buckets:
    1980s: 1980..1989
    1990s: 1990..1999

filter: edition
  facet: edition
  dependent: label
```

- **Buckets are the map.** Each bucket is a name and the values (or a range, `a..b`) it holds. A filter with
  no `buckets` has one bucket per value of the facet, named by its label.
- **Only real values are bucketed.** New and unknown values (chapter 9) never reach a bucket, and neither do
  held values.
- **A record is in a bucket** when any of its values for the facet is (for a level-prefixed facet, when any of
  its lower records' values is). The store decides this and puts it on the record's projection row (12.6).
- **Counts.** For each bucket, the count is the number of records in the view's selection, narrowed by every
  *other* filter the shopper has picked, that fall into the bucket. Picking two buckets of one filter means
  either. The index serving the view computes counts from the rows it holds (12.6.1).
- **Dependent facets.** `dependent:` names facets that follow the filter's facet (chapter 11.2 `follows`);
  their buckets are counted inside each of its buckets.

## 12.4 Audiences and roles

**Audiences** are few and fixed, so the number of stored variants stays small:

| Audience | Who |
|---|---|
| `public` | anyone, including crawlers |
| `member` | signed-in people |
| `staff` | the owner's people |
| `owner` | the owner itself |
| named parties | other owners, by domain (chapter 7.8) |

`show` rules (chapter 6, `then: key shown to member`) decide what each audience sees: per record, per facet,
per value. A view's `show` says which audience its stored projection is built for.

**Roles** are itemized permissions that sit on top of an audience as a filter. They never change projections,
caches or indexes.

```crubal
role: buyer
  audience: staff
  may:
    see: unit::cost, unit::location
    edit: condition, unit::price
    run: ebayListing, printLabel
    review: me:videoCodec
```

- The verbs are `see` (a value is shown), `edit` (a form may write it), `run` (a contract may be started) and
  `review` (vocabulary and migration queue items may be decided). Targets are facets, classes, views and
  contracts; `*` means all.
- **A role narrows its audience; it never exceeds it.** A grant naming anything its audience can't see MUST
  be refused at publish.
- A person MAY hold several roles; their grants add up, each capped by its own audience.
- **Default deny above `member`.** A person in the `staff` audience with no role sees and does only what
  `member` can.
- Contracts use the same grants: `who: caller may run ebayListing` (chapter 7.6). A form shows or locks each
  field by `see` and `edit`.
- Roles are definitions in a package, versioned like classes. Which person holds which role is data: a link
  facet on the person's record, with a source like any other value, so every grant has a history.

## 12.5 Pages, search engines and structured data

- **One view, one audience.** Every view is built for exactly one audience (its `show`), and its projection
  and index hold only what that audience sees. A page for another audience (a staff catalog, a member's
  shelf) is a view of its own with that `show`, with its own projection and index. The audiences are few
  (12.4), so the projections stay few.
- **The public projection is canonical.** It is the one cached, indexed and served to crawlers.
- **Indexable filters are declared.** Each bucket of a filter listed in `index` gets its own page with a
  canonical URL (`/dvds/comedy`, `/dvds/1980s`). Every other filter combination, and every page after the
  first, is served as not-to-be-indexed. Crawlers never enter the combinations.
- **Titles point to facets.** A page shape's title slot is an address, usually a derivation or rollup
  (`listingTitle -> title`); there are no hardwired title recipes.
- **Structured data** comes from the record's kind (its schema.org type per level, chapter 11.2) and each
  facet's `same-as`, emitted for the public audience only.
- New, unknown and held values never appear in a public projection.

### 12.5.1 AI is not an audience

An unauthenticated bot is `public`, whatever it says it is; an AI that signs in is a caller like any other,
with roles. So AI gets no audience of its own. What differs for AI is how the public projection may be
**used**, which a package or view declares as **terms** per audience:

```crubal
terms:
  public: search yes, answer yes, train no
```

| Use | Means |
|---|---|
| `search` | index the pages and link to them |
| `answer` | quote or summarise them in answers, with a link |
| `train` | use them to train models |

A package MAY name other uses. CRUBAL only states the terms; the host turns them into what crawlers and
agents read (robots rules for named bots, response headers, a machine-readable terms file), the same split as
authentication (chapter 7.6). Agents that shop or act for someone read a view's machine shape and act
through contracts as callers (chapter 7).

## 12.6 Projections

A view is **stored and indexed**, never derived on every read. The store computes it; an index serves it.

The store keeps the view's **projection**: one row per selected record, for the view's audience, holding the
shape's slots and, for each filter, the buckets the record falls into. Everything that needs the rules or an
audience decision happens here: selection, values read through from upper levels and rolled up from lower
ones, held, new and unknown values left out, and `show` rules applied.

- **The read set.** Every view has the set of keys its `select`, `of`, `order`, slots, filters and `show`
  rules read, worked out at publish. Rules are pure and addresses explicit, so the set is exact.
- **Staleness.** A write to a key in a view's read set, on a record or on anything it reads through (upper
  levels, shared parts, rollups from lower levels), marks that record's projection stale. Only stale rows are
  rebuilt.
- **Role marks.** In a view above `member`, a slot whose value only some roles may `see` (12.4) carries the
  role it needs. The store decides the marks; the index only drops a marked slot for a caller without that
  role, using the roles of the verified caller the host hands it (chapter 7.6). Roles never add a slot a
  view doesn't hold.
- **The projection stream.** Every change to a projection is published, in order, as a projection entry
  (12.7): the view and its version, the audience, the record, and either its new row or `"removed": true`
  when the record leaves the selection or the audience. Entries are numbered per view and audience, so an
  index resumes where it stopped.
- **Freshness.** Projection rows are never rebuilt inside the write's transaction, so a write's cost doesn't
  grow with the number of views. **`fresh: write`** puts a write's effect on the stream as soon as the write
  commits, in log order. **`fresh: 5m`** lets rebuilds batch, and the stream is never further behind than
  that.
- A new version of a view, shape or filter rebuilds its projection in full, and its stream starts over.

### 12.6.1 Indexes

An **index** is a utility that serves a view: it reads the view's projection stream and answers from it,
with pages in the view's `order`, filter counts (12.3), search and caching. Which engine it uses is its own
choice.

- An index MUST read only the projection streams of the views it serves. It never reads records, the log or
  another view's rows, so it can't show anything a view leaves out.
- It MUST drop role-marked slots for callers without the role, and decides nothing else about visibility.
- Its pages and counts MUST follow 12.2 and 12.3, over the rows it holds.
- An index MAY be behind the store, and MUST say which entry number it reflects.
- **Actions check again.** Nothing that acts relies on an index. A contract checks its `needs` against the
  store when it runs (chapter 7.4), so a unit that sold a moment ago and still shows can't be bought twice.
- An index can be dropped and rebuilt from the projection at any time. It is never the truth.

## 12.7 The JSON form

```json
{
  "view": "dvds",
  "select": { "level": "product", "wears": ["OpticalDisc"], "when": "format is DVD" },
  "pin": ["P-4QX7"],
  "order": [ { "key": "releaseDate", "dir": "after" }, { "key": "title", "dir": "before" } ],
  "page": "48",
  "shape": "card",
  "filters": ["condition", "genres", "decade"],
  "index": ["genres", "decade"],
  "show": "public",
  "fresh": "write"
}
```

Shapes use chapter 7.9's map objects for their slots; filters hold `facet`, `buckets` (`[{"name", "values"} or
{"name", "range"}]`) and `dependent`; roles hold `audience` and `may` (verb → targets).

A projection entry, as the stream carries it:

```json
{
  "projection": "dvds /2026-10-13",
  "audience": "public",
  "seq": 1042,
  "record": "P-4QX7",
  "row": { "cover": { "$image": "https://…/front.jpg" }, "heading": "Christmas Vacation", "price": "4.99 USD" },
  "buckets": { "genres": ["Comedy", "Holiday"], "decade": ["1980s"], "condition": ["Like new"] }
}
```

A record leaving the view is `{"projection", "audience", "seq", "record", "removed": true}`. In a view above
`member`, `marks` maps a slot to the role it needs: `"marks": { "cost": "buyer" }`.

## 12.8 Well-formed views

A package MUST be refused at publish when:

1. a view names a shape, filter, class or list that doesn't exist, or selects a level its classes' kinds
   don't have;
2. a slot, order key or filter facet names a facet the package doesn't define;
3. a filter's bucket values aren't real values of its facet, or two buckets of one filter overlap;
4. an `index` filter isn't among the view's `filters`;
5. a role grants anything its audience can't see, or names a target that doesn't exist;
6. a public view's slots or filters read a facet that `show` rules hide from `public`.
