# Benchmark results

Local Postgres 17 (Homebrew) on an Apple Silicon laptop, 2026-10-16. Numbers are one run each, after the
seed; the second `whoami` is warm. `bench/platform.ts` seeds straight into the tables (reads only; the write
path is `bench/bench.ts`).

## The platform benchmark (Cashierfu brief 0, audit G8)

Ten owners, one hosted person with five edges in each (three `helper` with control, two `follower`), half the
records products in one public view with one filter, half units.

| | 100,000 records | 1,000,000 records |
|---|---|---|
| seed | 4.4 s | 44.6 s |
| `whoami` (edges across owners) | 2.2 ms | 2.7 ms |
| `whoami`, warm | 0.8 ms | 1.9 ms |
| cross-owner relation read, `helper` (30 rows) | 3.9 ms | 9.3 ms |
| cross-owner relation read, `follower` | 3.1 ms | 3.3 ms |
| per-owner index page, first page, no picks | 50.7 ms | 503.3 ms |
| per-owner index page, one pick | 39.3 ms | 363.8 ms |
| per-owner search | 27.1 ms | 244.3 ms |
| record read by id | 0.3 ms | 0.6 ms |

**Reading it.** The two cross-owner reads the platform adds are flat: they go through the `edges(who)` and
`index_rows(ancestors, record)` indexes and touch tens of rows whatever the catalog size. The per-owner page
grows with the owner's view: the reference index loads every row of the view into memory to filter, count and
sort (`indexer.ts`, `serve`), so a 50,000-row view costs half a second a page. That is the reference index's
known shape, not the platform's; a page over a view that size wants ordering, paging and bucket counts done in
SQL (or a replacement index, which the stream contract allows). Noted for the Storefront object; a deployment
the size of ME (a few hundred thousand units, tens of thousands of products per catalog view) will hit it.
