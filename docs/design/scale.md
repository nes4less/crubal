# The scale rule

**Status:** design, 2026-10-19; built with 0.3.0 (brief 18 step 1 in the Cashierfu plan). What the engine,
the store and the host promise about size, where that promise is enforced, and how it is measured.

## The bar

Cashierfu is to hold millions of products and other records and serve thousands of users; the first owner
at scale is Media Encyclopedia with about 710,000 records on its first day and past 1,200,000 later. The
engine was measured at 22,000 records on ME's shape and 100,000 synthetic before this; a few paths still
loaded an owner's whole state. The rule closes that class of defect rather than those paths.

## The rule

**Nothing assumes an owner's state fits in memory.** The log is the truth, the tables are the state, the
index serves reads, and every operation works on a working set that loads what it touches. What follows:

- **A commit** runs on a working set (`working.ts`): records load by id, level, parent, target or key as the
  operation asks for them, and the operation runs again until it asked for nothing new. Record ids and
  children are fetched one query per kind, not one each.
- **A read** has the same tool: `PgStore.read(fn)` runs a pure function on a working set and returns its
  result. `fn` runs more than once as records load, so it builds what it returns inside itself; a read that
  accumulated into a variable outside would count twice (found on the first day, in a sales report).
- **The tables answer the small questions directly:** `records(where, opts)` by level, kind, parent,
  placement or one key's value, paged by `ord` and filtering archived; `get(id)`; `edges()`; `installed()`;
  `defines()` (the working package); `review()` (open) and `reviews()` (all); `binding(key)` and
  `bindings(keys)`; `observations(where)` by what they are on or support, evidence type or address;
  `emergencyReads()`. Each is one indexed query.
- **The whole state has one named door.** `wholeState()` loads everything and says so in its name: for a
  rebuild, an erase, an install's restamp, a person's export and a test's assertions. `state()` is the
  guarded door: a store built with `wholeState: "refuse"` throws on it, and its working sets throw on
  `records.all()`, in reads and in commits alike. The host builds every store that way unless told
  otherwise, so no request path can load a catalog by accident and the suites catch any that tries. An
  install's own commit is the one exception, since a restamp walks the package's records by design; a
  `read(fn, { allowAll: true })` is the explicit opt-in for the few walks that are what they are
  (provisioning's one-time repair, a person's erasure, the review screen's held values).
- **Access** is built inside a read from the edges (small) and the records the caller stands on, loaded as
  the check walks up; the index's serve, the records route, the forms route and the connections check all
  do this. `Access.checkWithin` over every record is the corpus runner's; a commit checks only the chains of
  the records it wrote.
- **An exchange knows its owner.** A store's border names it, so an arrival never reads a record to learn
  the domain; an offer asks for what it is `for` by target, and only an offer that names no target walks.
- **The host** keeps a bounded cache of stores (least recently used go; 256 by default) and walks owners a
  page at a time in every loop (tick, project, deliver, push, drain, retry, expire), so nothing in a request
  or a loop pass is proportional to the number of owners held in memory.
- **The tables are indexed for the questions asked:** records by (owner, level), (owner, kind), (owner, of),
  (owner, within), a GIN on `wears`, a GIN on the values document, the log by its key, stale marks by their
  key, index rows by their key with a GIN on the search vector and one on ancestors, observations by what
  they are on and support, review items by key. The probe asks the planner, not the schema.
- **Drain** finds the records with an instruction still to apply by SQL that mirrors `issuersFor` (the
  parent's instructions, a kind's, a class's worn by the record or its parent), never by walking.
- **A bulk path for conversions:** `PgStore.load(records, by, opts)` lands records in batches, one entry
  per batch, each value citing the entry that landed it, the checks, rules and stale marks of a commit
  applying, and the views publishing once at the end. A thousand records land in under a second; a million
  rows in an afternoon.

## What still walks, said plainly

- An **offer that names no `for`** walks the owner's records (7.8 allows the form; name `for:` on a large
  owner).
- **`expire`** walks records for sources past their `until`; it is a loop, not a request path, and will take
  an index on `until` when a loop pass on a large owner shows it.
- An **install's restamp** walks the package's own records: that is what a migration is, and it runs when an
  operator installs, not on a request.
- A **view with no level** selects everything; every view in the Cashierfu and ME packages has one.
- In the app, eleven reads marked `scale:` still ask for a whole level or kind (a catalog listing, a sitemap,
  an inventory report, the import's dry-run key index, the bench's per-container counts, the channel units
  screen, a guest's lookup by email). They are honest about it, they load one level rather than the state,
  and they are to move to the index or to SQL aggregates as the probe orders them.

## What the probe found (2026-10-19)

Four runs; completion.md "R: round three" has the table. Fixed on the way: a spread over a stream's
entries that overflowed at 500,000 rows; the index holding a whole stream before applying it; definitions
parsed per store rather than shared; the index paging in process rather than in the database; two missing
ordered indexes; key lookups that the GIN couldn't answer. After: a commit on a million records in single-
digit milliseconds, a warm page in 2 ms, a cold page in under 0.7 s (the counts, once per index change), a
thousand owners' reads with the heap flat. Still walking, said plainly: an install's restamp (1.8 GB
resident on a million records for two minutes; an operator action; the one path that should page), and
the cold counts after every index change, which the ingest could keep incrementally.

## The probe

`packages/crubal-host/bench/scale.ts`: a host of many owners (a thousand, a thousand records each) and one
large owner (a million records), loaded through the bulk path, then the costs that must not grow: a commit
on the large owner, the first publish of its largest view and the index taking it, an incremental publish
after one write, a page and a search from the index, a key lookup, a tick across every owner, a thousand
reads to a thousand different owners, and the process's memory before and after them; last, the planner's
plan for every query the working set and the projector make. The numbers are recorded in `completion.md`
under "R: round three" when the run completes, and again on ME's own full copy when the steward's dump is
in hand.
