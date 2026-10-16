# The reference index and the form contract

**Status:** design, 2026-10-15; ruled; built: the form as data (`formOf`, corpus `forms/`) and the reference
index in `packages/crubal-host` (stream entries now carry `sort` and `pin`, spec 12.7). Two pieces of the host (host.md) that face people: the index that
serves a view's pages, counts and search from the projection stream (spec 12.6.1), and the shape a form
takes when a host renders a contract of kind `form` (7.7). Neither decides anything about visibility: the
store decided when it projected; the index matches edges and roles; a form's fields are the contract's
needs.

## The reference index

(ruled: Postgres, in the host's own schema.)

**What it is.** An index subscribes through a stream contract (12.6.2) and holds, per view and audience,
the current rows. It is a utility like any other: the owner's package names it in a contract, it holds a
`system` record, and it carries a `control` edge with `run` for the contract when it serves a view above
`public`.

**Tables** (host schema, keyed by owner, view, version, audience):

| Table | Holds |
|---|---|
| `index_rows` | `record`, `row` (the slots), `buckets`, `marks`, `ancestors[]`, `seq`, and `search tsvector` built from the row's text slots |
| `index_cursors` | the last `seq` applied per (owner, contract, view, version, audience) |

A row is upserted on an entry with `row`, deleted on `removed`, and the table truncated on `reset`. Applying
is idempotent by (view, audience, seq): an entry at or below the cursor is ignored. The index acknowledges
through the contract's `ack` after each batch it applied.

**Serving** `GET /o/<owner>/v/<view>?page=&<filter>=<bucket>,<bucket>&q=`:

- **Audience.** The caller's audience (14.4) decides which audience's rows are served: `public` with no
  caller; a member or staff caller gets the view built for their audience, never a higher one.
- **Partition.** In a partitioned view the host hands the index the caller's live edges; a row is served
  when one of them stands in the partition's relation to the record or an ancestor (12.6). The index
  matches, it never decides.
- **Marks.** A slot marked with a role the caller doesn't hold is dropped from the row before it is served.
- **Pages** follow the view's `order` and `page` as projected (rows arrive ordered; the index keeps `seq`
  for ties and re-sorts by the order keys it finds on the row). **Counts** per bucket follow 12.3: each
  filter's counts are over the rows narrowed by every *other* picked filter.
- **Search** (`q=`) is Postgres full text over the row's text slots, ranked, combined with the filters.
  Nothing outside the row is searched, so nothing a view left out can be found.
- **Indexable pages** (12.5): the first page with no pick or one `index` filter's single bucket is marked
  indexable; everything else carries `noindex`. The index tells the host; the host writes the header.
- **Lag.** Every answer carries the `seq` it reflects per view (12.6.1).

**What it is not.** Not the truth (a contract checks the store, never the index), not a cache of records,
not a place a slot is added. Dropping and rebuilding it from the stream is always safe.

## The form contract

(ruled: unsaved answers live in the host's session, never the store.)

A form is a contract with a person (7.7). The host renders one from the contract alone; the package writes
no UI.

**`GET /o/<owner>/forms/<contract>?record=<id>`** returns the form as data:

```json
{
  "contract": "unitizer",
  "record": "U-9KD2",
  "origin": "observed",
  "sections": [
    { "title": "Condition", "fields": [
      { "key": "condition", "label": "Condition", "ask": "How does it look?", "type": "choice",
        "values": [{ "value": "NM", "label": "Near mint" }, …], "ranked": true, "required": true,
        "current": "VG", "editable": true, "state": "conflicted" },
      { "key": "sealed", "type": "yes-no", "words": ["Sealed", "Opened"], "current": null, "editable": true },
      { "key": "unit::price", "type": "number", "unit": "USD", "places": 2, "range": ["0", "10000"], "editable": false }
    ] }
  ],
  "parts": [ { "slot": "disc", "rows": [ { "row": "disc1", "fields": [ … ] } ] } ],
  "candidates": [ … ],
  "submit": { "run": "unitizer", "record": "U-9KD2" }
}
```

- **Fields are the contract's `needs`**, in their order and sections (5.3.3), each carrying what its facet
  says (type, values with labels and aliases folded, unit and accepted units, precision, words, length,
  range, `pick`, `ordered`, qualifiers) narrowed by the need's own line, and what the record says: the
  `current` value, its `state` (6.3.2: confirmed, contradicted, conflicted, suggested, held, new), and
  `editable` from the caller's `edit` item (14.6) and the gate (14.7).
- **An arrival form** (a form with `ref`, 9.2a) carries `candidates` when the arrival is held, so the
  person decides on the spot; their choice is the review decision.
- **Parts** come as rows per slot, with the slot's class lines as fields; a `fungible` slot adds `count`.
- **Submit** names the form's run (`{run, record}`; the host turns it into `POST /o/<owner>/run/<contract>`
  with `{record, answers}`); the host maps the
  answers back through the contract's `reads`, and the run lands as a form run (origin from the contract,
  `by: person`). Nothing is minted or written until then; drafts are the session's and die with it.
- **Validation before submit** is a courtesy, never the decision: the host MAY check a value against its
  facet (4.9) as the person types, using the same engine, and the store decides again at the run.

## What this needs

| Piece | Where |
|---|---|
| `index_rows`, `index_cursors`, the applier, the server | `packages/crubal-host` |
| `formOf(contract, record, caller)`: the form as data, from the engine's dictionary, access and record | `packages/crubal` (pure) |
| a corpus folder `forms/` with cases: fields from needs and sections; `editable` by edge and gate; candidates on a held arrival; a part's rows; a submit landing as a form run | `corpus/` |
| index cases over the stream cases: pages, counts after picks, partition by edges, marks dropped, a reset, search finding a slot and not a left-out facet | `packages/crubal-host` tests |
