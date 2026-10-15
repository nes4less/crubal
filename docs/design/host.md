# The host

**Status:** design, 2026-10-15. Not part of the specification. The spec names "the host" wherever it hands
something off (authentication, secrets, acting, the clock, signing, terms); this document says what that
is, draws the line between a reference host anyone can run and what a platform adds, and lists the
decisions. Cashierfu is the platform in the examples; every call here holds for any host.

## What the spec hands the host

| Handed off | Where | The host must |
|---|---|---|
| Who a caller is | 7.6, 14 | prove identity (sign-in, OAuth, API keys) and give the store a **caller record ID**; nothing else about identity crosses into CRUBAL |
| Secrets | 7.6 | resolve a contract's `credential` name to a secret; no secret in text, JSON or the log |
| Acting | 7.4 step 4 | perform a run's act against the outside system (call, print, show, send) and bring the answer back as intake |
| The clock | 6.3, 7.11 | offer `now` to rules and schedules; run due ticks |
| Signing | 8.5, 11.7 | hold each owner's key (and a hosted person's until they publish their own), sign entry hashes, publish keys in the well-known file |
| Packages | 8.5 `install`, 10.4, 11.5, 11.7 | install a published version for an owner, restamp, and publish the owner's own packages |
| Freshness | 12.6 | run the projector after writes (`fresh: write`) or on a schedule; run index contracts |
| Terms | 12.5.1 | turn a view's terms into robots rules, headers and a terms file |
| Recovery | 14.13 | account recovery for an owner who can't sign in, never an edge on their data |
| Emergency access | 14.13 | approvers with dedicated keys, published terms, witnessed entries, alerts |
| Owners | 14.1 | one store per owner on a shared database; a person's own records in their own chain |

## The calls

1. **A reference host exists and is open**, `packages/crubal-host` in this repository, under the same licence
   as the engine. It does everything the table above requires and nothing a business requires: no plans,
   billing, support tooling or brand. It is what proves the handoffs work, what a small site runs on its own,
   and what a platform builds on. Cashierfu is **a host built on it**: tenancy, billing, the operator UI,
   support and the emergency process are Cashierfu's; the mechanics are the reference host's. ME runs on
   the reference host first and becomes a Cashierfu tenant when Cashierfu exists.
2. **One process shape, two deployments.** The host is one Node service with an HTTP surface and two loops
   (projector, ticks). It runs as a long-lived service, or as serverless functions plus a scheduler hitting
   `/project` and `/tick`; `fresh: write` publishes inline after the commit, so the serverless shape loses
   nothing for small owners. Nothing in the host assumes one or the other.
3. **The host owns no model.** Everything it does goes through `PgStore` and `PgBorder`; it never writes a
   table of the store's directly. What it keeps of its own (sessions, identity links, key material, adapter
   state) lives in its own schema, never in an owner's log.
4. **Acting is an adapter, never a package.** A package declares a contract (`auth`, `scope`, `credential`,
   `to`); the host maps the contract to an **adapter**, code the host ships, keyed by the system it talks to.
   Packages carry no code. An owner connecting eBay means the host has an eBay adapter and the owner's
   package has an eBay contract.
5. **A send is two entries.** Today the border logs `acted` the moment it maps out. With a real act in the
   middle, a send is `started` (the payload and the idempotency key are logged, then the adapter acts) and
   then `acted` or `failed` (and the answer, if any, comes back through `receive`). The engine's `Exchange`
   gains the split; `retry` and late answers (7.5) fall out of it.
6. **Identity maps to a record.** A signed-in person is a `person` record of the owner (or a hosted person
   who is an owner themselves); an API key is a `system` record. The host keeps the link (identity provider
   subject → owner → record ID) in its own schema and hands the store only the ID. The signup contract
   (14.4) is what mints the person record and grants their first edge.
7. **Definitions come from the store.** The store stops being handed its dictionary and views: it builds
   them from the owner's `installed` bundles (the text of each pinned package version) and `definitions`
   (the owner's `define` writes), in `extends` order. Installing a package is the host calling
   `store.install(bundle)`: an `install` write, the bundle kept, the restamp that follows. This is engine
   work that lands before any host code.
8. **The reference index is part of the host.** A small index that reads the projection stream into its own
   tables and serves pages, counts and search for the owner's views, so a site needs nothing else to show a
   catalog. A platform may replace it; the contract is the stream.

## The pieces

| Piece | Interface | Reference implementation |
|---|---|---|
| Identity | `whoIs(request) → { owner, caller } \| anonymous` | sessions backed by an identity provider (OIDC), API keys hashed in the host's schema |
| Secrets | `secret(owner, name) → string` | environment variables for a single owner; a vault adapter for many |
| Adapters | `act(contract, payload, secret) → { body, type } \| abstain \| fail` | `http` (generic JSON over HTTPS with the contract's `auth`), `print`, `email`; eBay and the like as named adapters |
| Clock | `now()` | the system clock; tests inject |
| Signer | `sign(owner, hash) → sig`, `keys(owner)` | Ed25519 keys in the host's schema or a KMS; the store's `link` takes the signer |
| Installer | `install(owner, bundle)` | fetch a version's bundle from its domain's well-known file, verify the publisher's signature, `store.install` |
| Projector loop | `project(owner)` on commit or on schedule | inline after commit for `fresh: write`; `/project` for delays |
| Tick loop | `tick(owner, contract, now)` | `/tick` on a schedule, over every owner's scheduled contracts |
| Index | reads `entriesSince`, serves `GET /v/<view>` | Postgres tables of its own in the host's schema |
| Well-known | `/.well-known/crubal.json` | owners' keys, packages and versions, emergency terms |
| Terms | `robots.txt`, headers, `/.well-known/ai-terms` | from the owner's package `terms` |

## The HTTP surface

Owner-scoped, small, and the same for every owner. Authentication is a session cookie or a bearer key; the
host resolves it to a caller before anything else.

```
POST /o/<owner>/run/<contract>              a send or form run on a record     body: { record, answers? }
POST /o/<owner>/receive/<contract>          an answer or an arrival             body: the payload as received
GET  /o/<owner>/records/<id>                a record, plain or full form
GET  /o/<owner>/forms/<contract>?record=    a form's fields (its needs, placed), with current values
GET  /o/<owner>/v/<view>?page=&<filter>=    a view's page, from the index
GET  /o/<owner>/stream/<contract>?cursor=   a stream contract's entries (an index pulling)
POST /o/<owner>/stream/<contract>/ack       the index acknowledging
GET  /o/<owner>/review                      the review queue, by key
POST /o/<owner>/review/<item>               a decision
POST /o/<owner>/install                     install a package version
GET  /o/<owner>/export                      the owner's log and intake (the owner's power)
POST /o/<owner>/erase/<record>              erasure (the owner's power)
POST /project  ·  POST /tick                the loops, for a scheduler; guarded by a host key
```

Every route runs through the store's access (14): the host adds nothing to what an edge allows, and a route
with no caller is `public`.

## Owners and tenancy

An owner is a row in the host's `owners` table (domain, keys, plan if the platform has one) and a `PgStore`
over the shared database. A hosted person is an owner too (`domain:ID`), made by the signup contract when a
package declares `ownership`. The host never reads across owners; a platform's support reaches an owner's
data only through a cross-owner edge the owner grants (14.8) or an emergency edge (14.13), and the host logs
both as the spec says.

## Emergency access and recovery

Recovery is the identity provider's (password reset, a new key for an API client) and touches no edge.
Emergency access is a procedure the host enforces mechanically: approvers' keys are registered in the host,
each approval is a signature over the edge's hash made after a fresh sign-in, the edge is refused without the
published number of approvers or with the requester among them, every read under it is a `read` write,
every entry it touches is `witnessed`, and the owner is notified by the channel in the terms. The reference
host implements the mechanics and the checks; the people and the policy are the platform's.

## What is not the host's

Pages and apps (an index serves data; a site renders it), payment processing (a contract to a processor,
through an adapter), analytics, email templates, and anything an owner's package can say. If it can be said
in CRUBAL, it is not host code.

## Order of work

1. **Definitions from the store** (call 7): `installed` bundles + `define` writes → dictionary, views,
   contracts, permissions; `store.install`; the corpus's store cases exercised through it. Engine and store
   only.
2. **The send split** (call 5) in the engine, with corpus cases for `started`/`acted`/`failed`, retry and a
   late answer.
3. **The reference host, minimal:** identity by API key, secrets from the environment, the `http` adapter,
   the clock, signing, the projector and tick loops, the HTTP surface. Tests drive it over the Postgres
   store with a fake adapter.
4. **The reference index.**
5. **Well-known, terms, erasure and export routes.**
6. ME on the reference host, with its own package (its plan is in the ME repository).

## Decisions for the operator

- **Open reference host** (call 1): the mechanics in the open repository, Cashierfu as a host built on it.
  The alternative is one closed host; it would make ME's path to Cashierfu the only path and leave the
  spec's handoffs unproven in the open.
- **Identity provider for the reference host:** OIDC in general; for ME, Supabase Auth is already there and
  is an OIDC-shaped provider, so the identity link table maps Supabase subjects to person records.
- **Where it runs:** serverless plus a scheduler (Vercel functions and cron, where ME already is) or a
  long-lived service. The host is written for both; the first deployment should be whichever ME's launch
  needs least new infrastructure for, which is serverless.
- **The send split** is an engine change with new corpus cases; it changes what today's `run` logs.
