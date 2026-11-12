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
| `select` | which records: the classes they `wear` (all of them must be worn), a `level`, and a `when` condition (chapter 6.3); or `list: L-…`, a hand-made list. `level` is optional when `wears` is given: the view then selects wearers at every level, standing-alone ones included (chapter 1.7) | required |
| `partition` | what a caller must stand in to a record to be served its row: `administered`, `controlled`, `owned`, `relation <name>` (chapter 14.10), `linked <facet>` (the caller is whom the record's link facet names: a notice addressed to them, an invitation naming them), or `none` for every row | `controlled` above `member`; `none` otherwise |
| `of` | for a view inside a page: how the page's record narrows the selection, as a condition over `context` (`work is context.work and not id is context.id`) | none |
| `pin` · `hide` | curation: records shown first, in this order · records never shown | none |
| `order` | keys to sort by, in priority order; `after` means newest or largest first, `before` the reverse | ID An order key MAY be an address that reads through a link (revision 34, erratum: `order: pickUnit.filedSlot`); the first value it reads is the key, and a record it reads nothing for sorts as empty |
| `page` | records per page | 24 |
| `shape` | the shape every record takes; several for several outputs (`card, feed`) | required |
| `filters` | the filters shoppers can pick from (12.3) | none |
| `index` | the filters whose buckets get their own indexable pages (12.5) | none |
| `show` | the audience the view is for (12.4) | `public` |
| `fresh` | `write`, or a delay such as `5m` (12.6) | `write` |
| `terms` | how each audience may use what it's shown (12.5.1) | the package's `terms` |

A **catalog** (the media package's word for a view selected by worn classes) makes "which catalog is this
in" a global rule (chapter 6.6) the engine answers from the views' selections. **"Also on other formats"** is a view inside a
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
  no `buckets` has one bucket per value of the facet, named by its label. A facet with no value list (a link
  into a vocabulary, a number, a text) buckets by the values the records carry, each its own bucket named by
  the value; nothing is known in advance, so an index counts the buckets a page asks for (12.6.1).
- **Buckets by period.** `buckets: by day`, `by week`, `by month`, `by quarter` or `by year` on a date or
  moment facet makes one bucket per period the records' values fall in, named by the period: `2026-10-21`,
  `2026-W43` (ISO weeks, Monday first), `2026-10`, `2026-Q4`, `2026`. Nothing is listed by hand; like a
  facet with no list, an index counts the periods a page asks for.
- **Sums.** `sum: amount, qty` names facets totalled per bucket beside the count: money by its amount, a
  quantity by its count, a number as it is; a value that is none of these adds nothing. A projection
  answers `sums[filter][bucket][facet]` beside `counts`.
- **Only real values are bucketed.** New and unknown values (chapter 9) never reach a bucket, and neither do
  held values.
- **A filter over a mark (revision 34).** `buckets: marked` makes exactly two buckets: `open`, the records of
  the view's selection with no real value for the facet, and `done`, those with one. It is the one place an
  empty value is bucketed; a held, new or unknown value counts as none. The facet is then a **mark**: what a
  step leaves on the record it worked (a date for when, a yes-no, or a link to what the record was put in),
  with who and when in the write's own source (chapter 8). A lane names it as its `step` (12.10).
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
per value. A show rule's `for` scopes it: a rule for a class, kind or level decides for the records it
covers, a class over a kind or level, and a rule for `everywhere` decides for the rest; so a package may
show a location's phone to the public while a person's stays staff's. A view's `show` says which audience
its stored projection is built for.

Which callers belong to an audience is decided by edges (chapter 14.4).

**Roles** are itemized permissions that sit on top of an audience as a filter. They never change projections,
caches or indexes. A role is a **preset** of the permission menu (chapter 14.6), which is where the full set
of verbs, scopes and narrowing is defined. The `role:` block below is the short form: it reads as one preset
of that name holding one menu item per verb line, and a package MAY write either; a reader treats them as
the same declaration.

```crubal
role: buyer
  audience: staff
  may:
    see: unit::cost, unit::location
    edit: condition, unit::price
    run: ebayListing, printLabel
    review: me:videoCodec
```

- The verbs are the menu's (chapter 14.6): `see` (a value is shown), `edit` (a form may write it), `run` (a
  contract may be started), `review` (queue items may be decided) and the rest. Targets are facets, classes,
  views, contracts and queues; `*` means all.
- **A role narrows its audience; it never exceeds it.** A grant naming anything its audience can't see MUST
  be refused at publish.
- A person MAY hold several roles; their grants add up, each capped by its own audience.
- **Default deny above `member`.** A person in the `staff` audience with no role sees and does only what
  `member` can.
- Contracts use the same grants: running one needs its `run` item (chapter 14.6). A form shows or locks each
  field by `see` and `edit`.
- Roles are definitions in a package, versioned like classes. Which person holds which role is data: an edge
  (chapter 14.3) whose `grants` name it, logged like any other write, so every grant has a history.

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
audience decision happens here: selection, values read through from upper levels, from shared parts through
their links (`works[*].genres` in a slot, a filter or a condition, 1.10), from a compound's rows by child
(`ratings[*].value`, the wildcard of chapter 6 over the record's own rows) and rolled up from lower ones,
held, new and unknown values left out, and `show` rules applied. A `show` rule on the facet a link step
finally reads decides its visibility, wherever it is read from.

- **The read set.** Every view has the set of keys its `select`, `of`, `order`, slots, filters and `show`
  rules read, worked out at publish. Rules are pure and addresses explicit, so the set is exact.
- **Staleness.** A write to a key in a view's read set, on a record or on anything it reads through (upper
  levels, shared parts, rollups from lower levels), marks that record's projection stale. Only stale rows are
  rebuilt. **The envelope is in every read set:** a change of `status`, `wears`, `within` or `of` (chapter
  1.12) changes what a view holds, what a row reads through and what its ancestors are, so it marks the
  record's row stale like a key would. Erasure (chapter 8.5.2) is such a change: the row leaves the
  projection, and the stream (below) carries its removal to every index.
- **Partitions.** In a partitioned view (12.2), every projection row carries its record's ID and ancestors
  (chapter 14.2). The host hands the index the verified caller's live edges, and the index serves a row only
  when one of those edges stands in the partition's relation to the record or an ancestor: an edge on the
  owner's root matches every row, an edge on one league matches that league's rows. Views above `member`
  are partitioned by default, so a caller with `control` over one corner of the owner's data never sees the
  rest of a staff projection. The store decides the rows and their ancestors; the index only matches.
  In a `linked <facet>` partition the row carries instead whom the record's link facet names, and the index
  serves a caller only the rows that name them: a person's own notices out of a place's thousands, bounded
  by the link, never by the view; no edge per record is needed.
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
- **Follow and adopt (revision 4).** A record MAY name another owner's public record by that record's
  platform-wide number in a facet the host recognises as a follow (`follows`), and carry no facts of its own.
  Its public projection is then the followed record's public values beneath whatever it produces: the host
  reads them through from the followed owner's store at serve, under that owner's `show` rules, and copies
  nothing into the follower's log; a fact the follower produces stands first and is never covered. Lifting
  the follow (clearing the facet) leaves the record with what it produced. A record MAY likewise name a fold
  by its number in a facet the host recognises as an adoption (`adopts`) and read the fold's merged reading
  beneath its own; what the fold merges is the maps' business, so a fold with no maps reads nothing through.
  Neither facet moves a fact between logs; both are reads the host performs.

### 12.6.1 Indexes

An **index** is a utility that serves a view: it reads the view's projection stream and answers from it,
with pages in the view's `order`, filter counts (12.3), search and caching. Which engine it uses is its own
choice.

- An index MUST read only the projection streams of the views it serves. It never reads records, the log or
  another view's rows, so it can't show anything a view leaves out.
- It MUST serve only the rows the caller's edges match in a partitioned view (the rows that name the caller
  in a `linked` partition), MUST drop role-marked slots for callers without the role, and decides nothing
  else about visibility.
- Its pages, counts and sums MUST follow 12.2 and 12.3, over the rows it holds. For a filter whose facet
  has no value list, or whose buckets are periods (12.3), it MAY count only the buckets the request names,
  since a vocabulary's tree has thousands and time has no end; it MUST pick on any of them. A sum is read
  from the slot of the view's first shape that carries the facet, so a summed facet is one the shape shows.
- An index MAY be behind the store, and MUST say which entry number it reflects.
### 12.6.2 Subscriptions

An index subscribes through a **send contract that carries projection streams** (chapter 7): sending data to
a system is a contract, an index is a system, and nothing new is needed.

```crubal
contract: searchIndex
  kind: send
  stream: dvds, allDiscs
  to: index.example
  credential: search-index
  when: entry
```

- `stream` names the views whose streams the contract carries, and takes the place of `writes` and `needs`:
  the payload is the entries (12.7), in `seq` order, batched; nothing is mapped, because the store already
  decided every row. `to` names the party that receives them.
- **Push and pull are one contract.** `when: entry` runs it whenever one of its views publishes entries;
  with `when: asked` the index runs it as a caller and names its own cursor, and gets the entries since.
- **The owner connects an index** by writing the contract into its package, as it connects any system. An
  index never subscribes itself; a platform's shared index is each owner's contract pointed at the same `to`.
- **A cursor per contract and view.** The index acknowledges the last `seq` it holds; the store keeps it as
  the run's state and resumes from the next one. Until an acknowledgment, entries are delivered again, so an
  index applies them idempotently by (view, audience, `seq`). Each batch is one run, its idempotency key the
  contract, the view, its version and the range of `seq` it carries (chapter 7.5).
- **A new version is a new stream.** Entries name the view with its version (`dvds /2026-11-01`); the first
  entry of a new version carries `reset: true`, and the index drops the old version's rows when it arrives.
  The cursor an index acknowledged for an older version doesn't apply to the new one.
- **Order within a stream, none across streams.** Two views' entries may interleave; one view's never
  reorder.
- **Lag is visible.** The index reports the `seq` it reflects (12.6.1), and the store exposes each contract's
  cursor, so an operator sees how far behind an index is.
- **A page at a time.** A caller asking (`when: asked`) MAY name a limit per view; the answer carries at most
  that many entries of each view and says `more` when a view had that many, and the caller acknowledges the
  page and asks again from its cursor. A push goes the same way: each page is its own run, acknowledged
  before the next is read, so a stream of any size is never one payload and a run cut short resumes from the
  last page acknowledged.
- **Trust by edge.** A stream carries every row of its audience's projection, ancestors included, because
  the index does the partition matching, so the index is trusted at the level of the views it carries. A
  view at `public` goes to any party the contract names. A view above `public` goes only to a party holding
  a live `control` edge that carries `run` for the contract (chapter 14.6), granted by the owner; without
  it the run stops at `permission`.

- **Actions check again.** Nothing that acts relies on an index. A contract checks its `needs` against the
  store when it runs (chapter 7.4), so a unit that sold a moment ago and still shows can't be bought twice.
- **A stream is compacted.** An entry a later entry for the same record supersedes MAY be dropped once the
  store's row carries the later one, or once a removal stands for the record. Each record's latest entry, a
  removal that stands and every `reset` marker remain, the head keeps its number, and no entry is ever
  renumbered, so an index resuming from any cursor lands the same rows as before the compaction. A stream
  is a change log, not a history: nothing may depend on an entry a later one superseded.
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
{"name", "range"}]`) or `by` (a period) or `"marked": true` (revision 34), `sum` (the facets totalled per bucket) and `dependent`; roles hold
`audience` and `may` (verb → targets).

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

A record leaving the view is `{"projection", "audience", "seq", "record", "removed": true}`. An entry with a
row MAY carry `sort`, the values of the view's `order` keys as text in order, and `pin`, the record's
position among the pinned, so an index orders rows without reading records. In a view above
`member`, `marks` maps a slot to the role it needs: `"marks": { "cost": "buyer" }`. `projection` names the
view with its version when it has one (`"dvds /2026-11-01"`), and the first entry of a new version carries
`"reset": true` (12.6.2).

A display (12.9) is `{"display", "label", "describe", "layout", "slots": [{"from", "to"}], "tokens":
{name: value}}` under `displays`, its slots in order and its tokens as the words they were written.

A lane (12.10) is `{"lane", "version", "label", "utility", "view" | "serve", "pick": {"filter",
"value"}, "done": {"filter", "value"} | "viewed", or in their place (revision 34) "step" and "until": [filter…], (revision 38) "after": [filter…], "group" (revision 32), "band", "house", "serves": [{"as", "items"}], "home":
{"figure", "word": {"one", "many"} | "…", "press": {"word", "to", "glyph"?}, "chips"}, "card": {"name", "sub",
"lines", "state", "moment", "figure", "primary", "quiet", "quick": [{"word", "to", "glyph"?}], "opens"}}` under
`lanes`, `house` as a string like every number.

## 12.8 Well-formed views

A package MUST be refused at publish when:

1. a view names a shape, filter, class or list that doesn't exist, or selects a level its classes' kinds
   don't have;
2. a slot, order key or filter facet names a facet the package doesn't define;
3. a filter's bucket values aren't real values of its facet, or two buckets of one filter overlap;
   (revision 34) a lane's `step` or `until`, or a flow's `done` written as a filter alone, names a filter
   that isn't `marked`; a lane names a `step` beside a `pick` or `done`, or an `until` without a `step`;
4. an `index` filter isn't among the view's `filters`;
5. a role grants anything its audience can't see, or names a target that doesn't exist;
6. a public view's slots or filters read a facet that `show` rules hide from `public`;
8. a lane names a view, filter, value, slot, utility or act the package doesn't declare, serves an
   audience wider than its view shows, opens anything but a page, names both a view and a serve, or
   (revision 32) groups by a filter that isn't its view's or groups a lane the app serves;
9. a flow names a utility it doesn't declare, a stop that is neither a lane nor a form of the package, an
   act its utility lacks, a level its kinds lack, or a done that is not a declared filter with a real value;
   or whose lane stops do not chain, done to pick, or whose done is not its last lane's (12.11, revision 22;
   a flow that arranges Elements, revision 40, chains with nothing and is refused only for a lane stop with no act),
   or whose context is not a kind or level of the package, or that replaces itself (revision 23);
7. a display names no layout, has a slot line that isn't `shapeSlot -> displaySlot`, or fills one of its
   slots twice.

## 12.9 Displays

A **display** is a template for a screen over a view: a menu board above a counter, a grid of covers in a
window, a scoreboard. It is designed once and carried by a package, so a tenant adopts it with the package
or the utility that brings it, and a deployment's screens list the displays its packages carry.

```crubal
display: menu
  label: Menu
  describe: Two columns of name and price, for a board above a counter.
  layout: menu
  slots:
    heading -> name
    price -> price
    line -> detail
  tokens:
    columns: 2
    every: 30s
    scale: large
```

- `layout:` names the **family** the display is built on. A family is a way of drawing that the app
  knows (the first three are `menu`, `grid` and `board`); the engine stores the word and checks nothing
  else about it, so a package may name a family a later app will draw.
- `slots:` lines read `shapeSlot -> displaySlot`: the left side is a slot of the view's shape (12.1), the
  right a slot the family draws (`name`, `price`, `detail`, `image`, `figure`). A display fills a slot once.
  A display with no slots takes the family's defaults.
- `tokens:` are `name: value` words for the app that draws it: columns, the interval between redraws or
  slides, a type scale, colours. The engine carries them as written and computes nothing from them.
- `label:` and `describe:` are its words on the screen that offers it.
- A display is a member like a shape: published in the bundle under `displays` (11.6, 12.7), installed
  with its package, replaced by a later package's member of the same name (11.4). The host serves nothing
  new for it: the app reads the definition and draws.
- A display never widens what a view shows. The screen it draws reads the view at the audience the display
  is for, which is never wider than the view's own (12.4).

## 12.10 Lanes

A **lane** is a row of the grid: one thing a place's people attend to (orders to pick, notices unread,
items to review), declared by the package that holds its vocabulary, so a place's home is the lanes its
packages declare and nothing an app wrote for one screen. A lane names what it lists, whom it serves,
how it sorts, what its home card shows and how its object cards are laid out, with the presses that act
on them. The app draws it; the engine reads, checks and carries it.

```crubal
lane: ordersToPick /2026-11-05
  label: Orders to pick
  utility: orders
  view: desk
  pick: orderState = paid
  done: orderState = picking
  band: daily
  house: 7
  serves: owner, fulfiller(pick)
  home:
    figure: count
    word: one "order is paid and waiting to be picked." many "orders are paid and waiting to be picked."
    press: Pick -> /orders?tab=pick
    chips: orderState
  card:
    name: id, buyer
    sub: state
    lines: total, placed
    state: state
    moment: placed
    figure: total
    primary: Pick -> pick
    quiet: Open -> page
    quick: "Confirm address" -> confirmAddress
    opens: page
```

| Setting | Holds |
|---|---|
| `lane` | its name (a lower-case word) and dated version; a member like a view, listed in `members` |
| `label` | its word on a screen |
| `utility` | the utility of this package whose acts its presses may name |
| `view` | the view of this package that serves its cards; the view's shapes give the slots a card may name |
| `serve` | instead of a view: the name of a function the utility provides, for a lane the app serves itself (a setup, a tally); such a lane has no pick, done or card |
| `pick` | `filter = value`: the view's filter pick for what is ahead (the to-dos); absent, with no `step`, the lane is a **list**: every record its view serves, in the view's order (revision 17) |
| `step` | revision 34, in place of `pick` and `done`: one of the view's `marked` filters (12.3). What is ahead is the filter's `open` bucket, the history its `done` bucket. A lane names a `step` or a `pick`, never both |
| `until` | revision 34, with a `step`: one or more of the view's `marked` filters; a record marked on any of them waits here no longer, whether or not this lane's step was ever done. Absent, a record waits until the step is done |
| `after` | revision 38, with a `step`: one or more of the view's `marked` filters; a record waits here only once it is marked on each of them. Absent, a record waits from the moment its view serves it |
| `done` | `filter = value` for what is done (the history), or `viewed`: a card is done once the person has viewed it; the mark is the person's own, never the place's |
| `band` | `daily`, `weekly` or `rarely`: how soon it wants attention; `rarely` unless said |
| `house` | a whole number, governance first (0) and the doing rows after; 8 unless said |
| `group` | revision 32: one of the view's filters (12.3), whose buckets group the row's cards: the row draws one heading card per bucket, the bucket's word and its count (the page's tally), the bucket's cards tucked beneath, one bucket open at a time; absent, the cards stand in one run. A lane the app serves has no view to group by |
| `serves` | whom the row is for, as a utility's `serves` (14.6): presets, relations or audiences, each optionally narrowed to items; never wider than the view's `show` |
| `home` | the home card: `figure` is `count` (the view's tally under the pick), `sum <slot>` or `state <slot>`; `word` is `one "…" many "…"` or one text; `press` is `Word -> target` or `Word as glyph -> target` (revision 33); `chips` are the view's filters the home carries |
| `card` | the object card on the compass: `name`, `sub` and `lines` name slots in order; `state`, `moment` and `figure` name one slot each; `primary`, `quiet` and `quick` are `Word -> target` or `Word as glyph -> target`; `opens` is `page` |

A press's target is a path (`/orders?tab=pick`), `page` (the object's own page) or an act the lane's
utility declares. A press MAY name its glyph (revision 33: `Walk as footprints -> /logistics`), a lower-case
name an app maps to its own drawing; an app that draws presses as glyphs with the word on hover uses it, and
falls back to its own table for a press that names none. The glyph is carried in the bundle as `glyph` and
checked nowhere: a name no app knows draws as the word. A package MUST be refused at publish when a lane names a view, filter, value, slot,
utility or act it doesn't declare, serves an audience wider than its view shows, opens anything but a page,
or names both a view and a serve (12.8). A lane reads only through its view's served pages (12.6): the
figure is the index's tally, the cards a page, the history the same view under the `done` pick; it never
widens what the view shows. A reader that doesn't know the block carries it unchanged (13.5). What a
lane's card looks like on a screen is the app's; the compass (the positions its parts take) is a
convention of the app that draws it, not of the language.

**A lane by its step (revision 34).** A lane said by `pick` and `done` holds the records in one state and
hands them on to the lane that picks that state next. A lane said by `step` knows no other lane: it holds
the records its view serves that lack the step's mark and are marked on none of its `until`s, read as any
lane is (the index's tally under `open` on the step's filter and on each `until`'s; a page of the view; the
history the same view under the step's `done`). So a record stands in every lane whose mark it lacks, at
once, and a step never done holds nothing up: `until` is how a lane says what it needs, that the thing
exists and is not finished. A package MUST be refused at publish when a `step` or an `until` is not a
`marked` filter of the lane's view, when a lane names a `step` beside a `pick` or a `done`, or an `until`
without a `step`.

**Entering a step (revision 38).** A step lane as revision 34 has it fits a record that is on its track from
birth: it waits from the moment it exists. Some records enter a track later (a thing counted only once its
group's count has begun). A step lane MAY say `after`: one or more of the view's `marked` filters, and a
record waits in the lane only once it is marked on each. The lane is read as before with one pick more per
`after`: the index's tally and the view's page under `open` on the step's filter and each `until`'s, and
under `done` on each `after`'s; its history is the step's `done` as it was. A package MUST be refused at
publish when an `after` is not a `marked` filter of the lane's view, stands without a `step`, names the
lane's own step, or names a filter the lane also names as an `until`. A reader that knew revision 37 refuses
the lane for a setting it does not know (12.8).

A lane without a `pick` or a `step` is a **list** (revision 17): it holds the records of a kind that wait in no state
(the place's locations, its organizations, its pages), every record its view serves in the view's order.
Its figure is the view's tally, it has no `done` and so no history, and nothing in it is work waiting: an
app draws a list where the place keeps the kind, never among the rows of what wants attention, and never
counts it toward what is waiting. A package MUST be refused at publish when a lane without a `pick`
names a `done`.

## 12.11 Flows

A **flow** is an objective's line of stops: the lanes and blocks a record walks, in order, from the thing's
making to its being done (a unit from its making to its label; an order from paid to shipped). A lane is
a stop that holds records in a state; a block is a form (a make form, or an act's) that moves them. A flow
is declared by the package whose lanes and forms it walks, belongs to a utility and is served like a lane.
The app draws it at a room's head, its stops as a strip, and lets a person follow the queue (empty one
stop for every record) or the card (walk one record down the line); the engine reads, checks and carries
it.

```crubal
flow: pickPackShip /2026-12-20
  label: Pick, pack, ship
  utility: orders
  follow: queue
  serves: owner, fulfiller(ship)
  stops:
    ordersToPick -> pick
    ordersToPack -> pack
    ordersToShip -> ship
  done: orderState = shipped

flow: unitizer /2026-12-20
  label: Unitizer
  utility: bench
  follow: card
  serves: owner, bencher
  stops:
    unitizer of product
    unitsToFile -> file
    unitsToLabel -> label
  done: filingState = labelled
```

| Setting | Holds |
|---|---|
| `flow` | its name (a lower-case word) and dated version; a member like a lane, listed in `members` |
| `label` | its word on a screen |
| `utility` | the utility of this package whose acts its stops may name |
| `follow` | `queue` or `card`: how a new person walks it; a person's own choice stands over it; `queue` unless said |
| `serves` | whom the line is for, as a lane's `serves` |
| `context` | kinds of this package the flow holds through its run, asked once when it is walked and kept per person (a station, a location); the app draws them at the head and hands them to every stop's act (revision 23) |
| `replaces` | a flow this one stands in for (revision 23): where the named flow would have been served, this one is; the named flow returns when this one goes; a flow a place draws from a preset names the preset |
| `arrange` | `line` (unless said) or `elements` (revision 40): a line's state stops chain; an arrangement of Elements chains with nothing (Elements, below) |
| `stops` | one line per stop, in walking order: `<lane> -> <act>` is a lane of this package with the act of the utility that moves a card on; `<lane>` alone is a lane whose cards move by their own presses; a list (a lane with no `pick` and no `step`, 12.10) is a stop only as `<lane> -> <act>` (revision 37); `<form> of <level>` is a block, a form of this package making or acting on a record of that level (the record of the stop before, when it has one); a block may end `with <facet> = <value>, …` (revision 36): the values its form opens with, set and locked |
| `done` | `filter = value`: the state a record leaves the line in: the last lane stop's done, or its pick when that lane holds what is finished (revision 22); or (revision 34) a `marked` filter alone: a record marked on it has left the line |

A package MUST be refused at publish when a flow names a utility it doesn't declare, a stop that is
neither a lane nor a form of the package, an act its utility lacks, a level its kinds lack, a `with` on a
stop that is not a block or naming a facet that is not declared or one facet twice (revision 36), a done that
is not a declared filter with a real value, a context that is not a kind or level of the package, or itself
as what it replaces (12.8); a `replaces` naming a flow not in force at a place is carried and stands in for
nothing there. A package that extends others may walk the lanes and forms of the packages it extends and name
their utility, presets and filters (revision 23: a place's own package carries the flow it drew from a
preset); what the file-local check cannot see, it leaves to the check of the packages in force together (11.4,
at install), which refuses as the publish would have. A flow adds nothing to what its lanes show: a
person sees the stops whose lanes they are served, and a block only where the form's `who` admits them.
Where a block's form is pressed is the app's (a generic make screen, a path of its own); what a flow
looks like is the app's; the order of the stops is the package's. A reader that doesn't know the block
carries it unchanged (13.5).

**The stamps (revision 22).** A flow declares no transitions: its lanes already say what moves. A lane
stop's `done` is the stamp its act leaves: when the act named on the stop (or, on a stop with no act, the
card's own press) lands on a record the lane holds, the record takes the done's value on its filter's
facet, written as the act's last write under the act's own source. A block stop's stamp is the next lane
stop's `pick`: the form's record is made, or moved, into the state that lane holds. When an act lands is
the utility's: a filing lands when its form is kept, a printing when the printer reports. Nothing watches
a record for the state to change; a stop stamps when it is told the act landed. A reader derives the
stamps from the stops; they are never written in the text and never published.

**Locked values (revision 36).** A block stop may end `with <facet> = <value>, …`: the form of that stop
opens with each named facet holding that value, and the person walking cannot change it there. It is how one
form serves several lines of work (an offer form with `channel = ebay` in the flow that lists on eBay), and
how a place draws its own such flow in a designer without a second form. The value is written as the form's
own write, under the form's source, and is checked as any value the form keeps (4, 7); a lock is not a
rule: the same form opened elsewhere asks the facet as it always did. A reader derives nothing from it.

**The chain (revision 22).** Two lane stops that follow one another chain: the first's `done` is a state
(not `viewed`) and it is the second's `pick`, filter and value. A lane with no `pick` (a list, 12.10) holds
no state, and is a stop only with an act (list stops, below). A block stop between two lanes leaves the chain as it is: the lanes chain across
it, and the block stamps the second's pick. The flow's `done` is the last lane stop's `done` when that is a
state, else its `pick` (an end stop holding what is finished). A package MUST be refused at publish when a
flow's lane stops do not chain, or its done is not its last lane's; the refusal names the gap. A flow
arranged from lanes a package already walks between needs nothing more to move its records on.

**Step stops (revision 34).** A stop whose lane names a `step` chains with nothing. Step stops stand in any
order, any may be left out, and one lane may be a stop of several flows; a flow is never refused for their
order or their number, so a place's own flow (revision 23) arranges a preset's step stops as it likes. State
stops still chain among themselves, and a step stop between two of them leaves their chain as it is. A step
stop's stamp is its mark: when the stop's act lands and has not written the mark itself, the stamp writes
`now` on a date and `yes` on a yes-no; a link mark is never stamped, since the act sets it (the container it
found or made), and an act that lands without setting it has not done the step. A block stop before a step
stop stamps nothing. A flow's `done` naming a marked filter alone is checked against no lane.

**List stops (revision 37).** Some work is an open set: every record of a kind may be touched, one at a
time, and touching it does not take it off the list (a thing moved from one group to another). A list (12.10)
is a stop of a flow when the stop names an act, `<lane> -> <act>`: the act is the whole of the work, and
nothing is left behind for the lane to hold. A list stop chains with nothing and stamps nothing: the state
stops chain across it as across a step stop, a block stop before it stamps nothing, and a flow whose last
lane stop is a list has its `done` checked against no lane. A package MUST be refused at publish when a list
is a stop with no act; the refusal says so. A reader that knew revision 36 refuses such a flow as it refused
every list stop.

**Elements (revision 40).** Some work is not one record walking a line. An **Element** is a lane with the act
that is its work: what a touch does there. A count of a container is several of them, on two levels: the
containers to start, the units expected, the containers to finish, the units not found. Nothing is handed
from one to the next as a state; they are joined by what the flow holds, its `context` (the container), and a
person moves among them as the work asks. A flow that says `arrange: elements` is such an arrangement:

```crubal
flow: count /2026-11-16
  utility: stock
  context: container
  arrange: elements
  stops:
    containersToCount -> start
    unitsExpected -> seen
    containersCounting -> finish
    unitsNotFound -> lost
```

Its stops chain with nothing, stand in any order, and may be lanes of different levels; one lane may be a stop
of several flows. Each lane stop still stamps as it would anywhere (a state lane's `done`, a step lane's mark,
a list nothing). A `done`, where one is written, is checked against no lane. A package MUST be refused at
publish when a lane stop of such a flow names no act, since a lane nobody presses is a list to read and no
Element; the refusal says so. `arrange: line` is the default and may be written. A reader that knew revision
39 refuses the setting as it refuses any it does not know.

## 12.12 Prints

A **print** is a label design: how a record of a class or kind prints on a piece of stock. It is a member a
package carries, like a display: named, versioned and signed with the package, installed with it, replaced
by a later package's member of the same name (11.4). A place's own package may declare its own; the prints
available at a place are its installed packages' prints whose `for:` the place holds.

```crubal
print: tag
  label: Unit tag
  describe: A 2.5 by 1 thermal tag: the id as bars, the SKU and title under them, the price at the right.
  for: Filed
  inches: 2.5 1
  fields:
    code -> cashierfuId
    title -> title
    price -> price
    shop -> place:name
  elements:
    rect 0 0 1 1 fill white
    barcode 0.06 0.02 0.88 0.68 code
    text 0.04 0.95 0.067 "{code} | {title}" anchor start weight bold clip 0.04 0.86 0.6 0.12
    text 0.96 0.95 0.067 price anchor end weight bold
```

| Setting | Holds |
|---|---|
| `print` | its name (a lower-case word); a member, published under `prints` |
| `label` · `describe` | its words on the screen that offers it |
| `for` | the class or kind it prints; a record of that class (or of the kind's levels) fills its fields |
| `inches` | its intrinsic stock, `width height` in inches, both above zero; the art is designed at this aspect |
| `stretch` | `yes`: on a stock of another aspect the art stretches to fill it; `no` (the default): it keeps its aspect, centred |
| `fields` | one line per field, `slot -> source`: the source a facet of the dictionary (checked as a shape's slot is, 12.1), `id` (the record's id), or a brand slot of the place that prints: `place:name`, `place:mark`, `place:primary`, `place:accent`, `place:words`; `id` is every print's, declared or not |
| `elements` | one line per element, drawn in order on the art's normalized boxes |

The elements, each a line of words; a number is a fraction of the art, 0 to 1, horizontal ones of its
width and vertical ones (and a text's size) of its height:

| Element | Line |
|---|---|
| a rectangle | `rect x y w h [fill white\|black\|none] [stroke dots]` |
| a Code 128 barcode | `barcode x y w h <field> [rotate cw\|ccw] [text]`: the field's value in the bars; `text` prints it under them |
| a QR code | `qr x y w h <field> [gravity bottom-right\|top-left]`: the field's value encoded; centred unless a gravity is said |
| a picture | `image x y w h <field>` (revision 28): the field's value an image's address (the place's mark, `place:mark`, or an image facet); drawn to fit the box keeping its aspect, centred; a thermal lane prints it as a bitmap, dark where the picture is dark, and prints nothing where it cannot read the picture |
| a line of text | `text x y size <field \| "words">` then any of `anchor start\|middle\|end`, `weight bold`, `clip x y w h`, `rotate cw\|ccw\|180`, `lines n` (revision 27): `x y` the anchor's point, `size` the font's height; a quoted literal may hold `{field}` places; with `lines`, from 2 to 9, the words wrap into that many lines of the font's height stacked down from `y`, within the clip's width when there is one, the last line cut with an ellipsis |

A package MUST be refused at publish when a print says no `for:`, names a `for:` that is neither a class nor a
kind, names no inches or inches that are not two numbers above zero, declares a field whose source is not a
facet, `id` or a brand slot, names a field twice, draws nothing, draws an element of another type (a rect, a barcode, a qr, a text, an image) or with a
number outside 0 to 1, or draws a field it did not declare. The engine carries a print and checks nothing
of how it prints: resolving the art to a stock (letterboxed or stretched, rotated when the stock is
portrait), the renders (a page for a driver, ZPL for a thermal printer, a bitmap) and the printers are the
app's, and so is what `place:mark` draws. A reader that doesn't know the print carries it unchanged (13.5).

