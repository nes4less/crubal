# 12. Views

**Stub.** Views are not designed yet. This chapter records what is settled, so the chapters before it can
refer to it, and what the design must answer.

## 12.1 Settled

- **A view is a selection over many records.** It is the seventh piece of the stack, beside contracts, and
  refers only to rules, classes and facets.
- **Catalogs are rules over worn classes.** A record is in a catalog when a global rule (chapter 6.6) says so,
  usually by the classes it wears.
- **Filters are maps.** A filter is a map from a facet's values to what a shopper picks, the first map of the
  catalog, not a second copy of the data.
- **Related-by-facet carousels** and **"also on other formats"** (products that share a Work, chapter 1.6)
  are views.
- **How a group is shown** (separate pages, or options on one page) is a view setting.
- **Hand-made lists are records**, not views: an ordered set of links with a name and an owner.
- **`show` rules decide visibility** to an audience (chapters 6, 7.6, 7.8).

## 12.2 To design

- The syntax: select, order, limit and paging.
- Filter maps: how values are grouped, renamed and ordered for people, and how dependent facets (chapter 11.2
  `follows`) are counted together.
- `show` rules: the audiences, and per record, facet and value visibility.
- How a view is published, versioned and cached, and what a stored projection (a card) is.
- The view corpus.
