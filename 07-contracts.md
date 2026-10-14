# 7. Contracts

A **contract** is a border where values cross: to and from a system, a person, or another owner. It is the
only place anything happens in the world. If something only decides, it is a rule (chapter 6); if it moves
values or does something, it is a contract.

Each system declares one contract and maps only to facets, never to another system. Ten systems need ten
maps, not forty-five bridges, and contracts chain without knowing each other: one contract's `gives`
satisfies another's `needs`.

## 7.1 Kinds

| Kind | Values go | Examples |
|---|---|---|
| `send` | out to a system | a label printer, a marketplace listing, a product feed, structured data on a page |
| `receive` | in from a system | a scanner, a catalog lookup, an import, OCR, AI text, an ID allocator, a pricer |
| `store` | both ways, between facets and an object's own fields | a location, an order |
| `form` | to a person and back | an editor, checkout, signup, a customer's correction |
| `offer` · `take` | between owners (7.8) | a distributor's catalog, a collector's records |

## 7.2 The long form

```crubal
contract: ebayListing
  kind: send
  label: eBay listing
  for: OpticalDisc
  needs:
    !title$80
    !format{DVD|Blu-ray|4K}
    !unit::price
  writes:
    title -> Title
    format -> aspects.Format
      4K -> "4K UHD Blu-ray"
    unit::price -> price.value
  reads:
    itemId -> ebay:itemId
  gives: ebay:itemId
  when: unit::status is listed
  who: caller wears Staff
  auth: oauth2
  scope: https://api.ebay.com/oauth/api_scope/sell.inventory
  credential: ebay-seller
  retry: 3 every 10m
  version: 2026-10-01
```

| Part | Holds | For kinds |
|---|---|---|
| `kind` | 7.1 | all; required |
| `label` · `describe` | what people see | all |
| `for` | which records it runs on: a class, a kind or a level | all |
| `needs` | an unnamed class (chapter 5): what must be present, and how narrow, before it may run | all |
| `gives` | the facets it brings back, so other contracts can chain on it | receive, send, form |
| `writes` | the map out (7.3) | send, form |
| `reads` | the map in (7.3) | receive, send (its answer), form |
| `stores` | the map both ways (7.3) | store |
| `when` | the trigger: a condition (chapter 6.3) that starts a run when it becomes true, or `asked` for runs started by a caller | all; default `asked` |
| `who` | who may run it: a condition over the caller (7.6) | all |
| `origin` | the origin of the values it brings in (chapter 1.9) | receive, form, take; default `reported` for systems and `declared` for forms |
| `lands` | `value` (the default) or `suggestion` (7.5) | receive, form, take |
| `absorb` · `ignore` · `keep-raw` | intake bypass (chapter 9) | receive, take |
| `auth` · `scope` · `credential` | what the other side requires (7.6) | send, receive |
| `retry` · `undo` | run handling (7.5) | send, receive |
| `version` | the dated version | all |

A part key with a prefix is a package part, carried unchanged.

## 7.3 Maps

Each map line is `from -> to`, in the direction values flow:

- in `writes`, `ourAddress -> theirField`;
- in `reads`, `theirField -> ourAddress`;
- in `stores`, `ourAddress -> theirField`, read both ways.

**Our side** is an address (chapter 1.10), with the level prefix allowed (`unit::price`). **Their side** is a
field path in their payload: names separated by `.`, a name in quotes when it holds anything but letters,
digits and `_` (`aspects."Run Time"`), `[n]` for an array position and `[*]` for every item.

**Value maps** are lines inside a map line, also in the direction of flow:

```crubal
reads:
  aspects.Format -> format
    "4K UHD Blu-ray" -> 4K
    "Blu-ray Disc" -> Blu-ray
```

Our side of a value map MUST be a real value of the facet (never an alias). A value the map doesn't name
passes through unchanged and is folded as usual (chapter 9): so a value map holds only what aliases and
shapes can't do. A value that means "does not apply" in their vocabulary maps to `-`.

A field of their payload that no `reads` line names stays on the intake record only (outcome `unknown`,
chapter 9): it is kept as received and searchable by staff, but nothing reaches the record. To carry a field
onto the record uninterpreted, map it to a key under a prefix: `aspects.Studio -> market:Studio`.

A map line MAY instead go to or from a **literal**: `"USD" -> price.currency`. A contract never computes:
anything that isn't a map, a value map or a literal is the other side's work.

## 7.4 Running a contract

A run goes through seven steps, in order. Only step 4 has an effect.

1. **Trigger and permission.** `when` holds (or a caller asked), and `who` holds for the caller.
2. **Needs.** The record satisfies `needs` as a class: every `!` line has a value, and every value fits its
   narrowing. If not, the run stops before acting, naming what is missing.
3. **Map out.** `writes` builds the payload.
4. **Act.** The host performs the act: calls the system, prints the label, shows the form.
5. **Map back.** `reads` turns the answer into values, each with a source: `origin` from the contract, `via`
   the log entry for this run.
6. **Rules.** What came in runs through intake (chapter 9) and the rules (chapter 6).
7. **Record.** The run is logged with the versions of the contract, the package and the rules it used.

## 7.5 Runs

Every run has a **run ID** (`R-118`), and the log entry for its writes names it (chapter 8).

- **Idempotency.** A run's key is the contract, the record and the hash of its mapped-out payload. A host
  MUST NOT act twice for the same key unless the earlier run failed before acting.
- **Retry.** `retry: 3 every 10m` retries a failed act up to three times, ten minutes apart. With no `retry`,
  a failed act is not retried.
- **Late answers.** An answer that arrives after its run closed is taken as intake against that run, and
  folds like any other.
- **Undo.** `undo: ebayEndListing` names the contract that reverses this one. The engine never assumes a
  contract is reversible.
- **Suggestions.** With `lands: suggestion`, values that arrive don't change the record: they are kept as
  suggestions on it, for a person to accept. Customer corrections land this way.

## 7.6 Authorization and authentication

**Authorization is inside CRUBAL.** `who` is a condition (chapter 6.3) over the **caller**, which is a record:
a person, an organization or a system. Its values are read with the `caller` prefix
(`caller.role is staff`), and `caller wears Staff` tests its classes. What a caller sees is decided by
`show` rules (chapter 12).

**Authentication is the host's job.** Sign-in, OAuth flows and API keys belong to whatever runs the
contracts. A contract only declares what the other side requires:

- `auth`: the scheme, such as `oauth2`, `apikey`, `basic` or `none`;
- `scope`: the scopes or permissions it asks for;
- `credential`: a **name** the host resolves to its secret (`ebay-seller`).

**No secret ever appears in CRUBAL text** or its JSON. A package MUST be publishable as it is.

## 7.7 Forms

A form is a contract with a person. Its screen assembles itself:

- the fields are `needs`, in its lines' order and sections (chapter 5.3.2), each drawn with its facet's own
  control (a choice as bubbles, a date at its precision);
- `writes` shows current values, `reads` takes the person's answers;
- `who` is the person, and `origin` says what the person is doing: `declared` when they state it,
  `observed` when they read it off a real instance in front of them.

## 7.8 Offer and take

Sharing between owners is two contracts, one on each side. Only the overlap flows.

```crubal
contract: catalogOffer
  kind: offer
  for: Movie
  gives: title, format, releaseDate, runtime, cast
  to: public
  mode: gathered

contract: catalogTake
  kind: take
  from: distributor.example
  reads:
    title -> title
    runtime -> runtime
  mode: gathered
  lands: value
```

- **`to`** (offer): `public`, `followers`, named parties, or `private`. Visibility per record, facet or value
  is decided by `show` rules.
- **`from`** (take): the presenter, by domain.
- **`mode`** is defined by three properties. The four named modes are presets, and a package MAY name other
  combinations:

| Mode | `copy` | `updates` | `control` |
|---|---|---|---|
| `dump` | yes | no | consumer |
| `observed` | no (read through) | yes | presenter |
| `gathered` | yes | yes, as intake | consumer; their edits win |
| `controlled` | yes | yes | the presenter's `terms` |

- **`terms`** (offer, controlled): `reshare: no`, `expires: 2027-01-01`, `revocable: yes`.
- Only `observed` is enforced by the engine (a read-through is never stored). The others are agreements the
  engine honours, backed by licence and law.
- A presenter's update never overrides a value a person entered on the consumer's side, unless the consumer
  took `controlled` terms.
- **Parties** are identified by domain, with their keys published at a well-known address on that domain
  (the address is fixed when the spec's home is chosen).

## 7.9 The JSON form

```json
{
  "contract": "ebayListing",
  "kind": "send",
  "for": "OpticalDisc",
  "needs": [
    { "facet": "title", "required": true, "length": "80" },
    { "facet": "format", "required": true, "values": ["DVD", "Blu-ray", "4K"] },
    { "facet": "price", "required": true, "level": "unit" }
  ],
  "writes": [
    { "from": "title", "to": "Title" },
    { "from": "format", "to": "aspects.Format", "values": [ { "from": "4K", "to": "4K UHD Blu-ray" } ] },
    { "from": "unit::price", "to": "price.value" }
  ],
  "reads": [ { "from": "itemId", "to": "ebay:itemId" } ],
  "gives": ["ebay:itemId"],
  "when": "unit::status is listed",
  "who": "caller wears Staff",
  "auth": "oauth2",
  "credential": "ebay-seller",
  "retry": { "times": "3", "every": "10m" },
  "version": "2026-10-01"
}
```

`needs` uses chapter 5.9's class line objects. A literal map side is `{"literal": value}`.

## 7.10 Well-formed contracts

A package MUST be refused at publish when a contract breaks these:

1. Every part is one its kind allows (7.2).
2. `needs` is a well-formed class (chapter 5.10).
3. Every our-side address names a facet the package defines (or an unknown-key prefix in `reads`).
4. Every our-side value in a value map is a real value of its facet.
5. `credential` is a name, never a value; nothing in the contract is a secret.
6. `when`, `who` and `show` are conditions that parse (chapter 6.3).
7. `undo` names a contract of the same package.

## 7.11 Open

- Scheduled triggers (`every day at 03:00`) wait on `now` in conditions (chapter 6.11).
- Partial success (a run that acted on some items and not others).
- The well-known address for party keys.
