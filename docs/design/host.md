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

## Identity and credentials

There are three directions a call can take, and the spec settles the line for each: authentication is the
host's, authorization is CRUBAL's, and no secret enters CRUBAL. What follows is the host's side.

### Inbound: who is calling us

| Caller | Proven by | Becomes |
|---|---|---|
| a person | a session from the identity provider (OIDC; Supabase Auth for ME) | their `person` record, or their hosted-person owner |
| a system of the owner's (a utility, a bench tool) | an API key the host issued, hashed in the host's schema, bound to one record | its `system` record |
| an outside system calling back (a webhook) | the partner's own signature or token, verified by that partner's adapter | the same `system` record the outbound side uses |
| another owner (offer and take, a cross-owner edge) | a signature over the request with that owner's domain key, published in its well-known file (7.8) | a caller of that owner, written `domain:ID` |
| nobody | | `public` |

The host hands the store the caller ID and nothing else; from there every decision is an edge, a menu item
or a `who`. A system has **one record whichever direction the call goes**, so the inbound and outbound
layers meet in one place and never contradict each other.

### Outbound: how we authenticate to the world

A contract says `auth` (the scheme), `scope` (what it asks for) and `credential` (a **name**, 7.6). The
host owns everything behind the name:

- **Credentials are per owner.** One package and one contract serve every owner, so `credential:
  ebay-seller` resolves to *this owner's* eBay. The credential store is keyed by (owner, name) and holds
  scheme-shaped material: a key, a username and password, or an OAuth grant (access token, refresh token,
  expiry, the scopes granted).
- **Connecting is a host flow, recorded as data.** An owner connects an account in the host (the OAuth
  consent for `oauth2`; pasting a key for `apikey`). The host stores the material under the name, and
  writes or updates a `system` record for the partner through a form contract of the core party package:
  the name, the scheme, the scopes granted, `connected` or `expired`, and when. That record is the visible
  side of the connection, so views can show it and edges can govern who may reconnect it, and it carries no
  secret.
- **Lifecycle is the host's.** Refreshing a token before it expires, rotating a key, re-running consent
  when a scope is missing: none of it touches a package. A credential replaced under the same name changes
  nothing in CRUBAL.
- **Failure is a run.** An act refused for authentication is a run that `failed` with reason
  `credential`; the contract's `retry` applies after a refresh, and a connection that can't be refreshed
  marks the `system` record `expired`, which rules and views can see.
- **`scope` is checked at connect time and at run time.** The host asks the provider for the contract's
  scopes when connecting and refuses a run whose contract asks for a scope the grant doesn't hold, before
  acting.
- **Adapters never see names.** The host resolves the name and hands the adapter the material; an adapter
  is the same code for every owner.

### Between owners

Identity between owners is the domain key (7.8, 11.7). Requests carry it as an HTTP message signature
(RFC 9421) over the method, target, date and body digest, made with the domain's Ed25519 key; the receiving
host fetches the signer's well-known file, verifies, and treats the caller as that owner. `to: link` offers
use the unguessable token the spec names instead of a signature. Hosted persons who publish a key of their
own sign the same way with it.

### What is kept where

| | Lives in | Never in |
|---|---|---|
| sessions, identity links (subject → owner → record) | the host's schema | the owner's log |
| API key hashes | the host's schema | |
| credentials (keys, grants, refresh tokens) | the host's secret store (environment for one owner, a vault for many) | the host's database tables, the log, any package |
| the fact and state of a connection | a `system` record in the owner's data | |
| signing keys | the host's key store or a KMS | |

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

1. **Publishing and installing** (call 7, designed in `publishing.md`): the bundle, the publish command,
   `store.install`, and definitions built from `installed` bundles and `define` writes. Engine and store
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

Ruled 2026-10-15: open reference host (1); identity through an OIDC-shaped adapter the reference host ships
with a self-hostable provider, ME plugging Supabase Auth into it (2); everything runs and is tested locally,
a staging deployment only when ME is wired (3); the send split (4); signed requests between owners (5).


- **Open reference host** (call 1): the mechanics in the open repository, Cashierfu as a host built on it.
  The alternative is one closed host; it would make ME's path to Cashierfu the only path and leave the
  spec's handoffs unproven in the open.
- **Identity provider for the reference host:** OIDC in general; for ME, Supabase Auth is already there and
  is an OIDC-shaped provider, so the identity link table maps Supabase subjects to person records.
- **Where it runs:** serverless plus a scheduler (Vercel functions and cron, where ME already is) or a
  long-lived service. The host is written for both; the first deployment should be whichever ME's launch
  needs least new infrastructure for, which is serverless.
- **The send split** is an engine change with new corpus cases; it changes what today's `run` logs.
- **Signed requests between owners** (RFC 9421 with the domain key) as the protocol for offer, take and
  cross-owner edges; the alternative is bearer tokens issued per pair of owners, which would need a
  registration step the spec doesn't have.
