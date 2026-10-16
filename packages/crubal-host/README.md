# @cruba/crubal-host

The reference CRUBAL host (docs/design/host.md): what the specification hands the host, and nothing a
business requires. It runs owners' stores on `@cruba/crubal-postgres`, proves who a caller is, resolves
secrets by name, acts through adapters, signs each owner's chain, installs published packages, publishes
views and runs schedules, and serves one small HTTP surface. It owns no model: everything goes through
`PgStore` and `PgBorder`, and what it keeps of its own (owners' keys, API keys, identity links) lives in
its own tables.

## Operations

Request bodies over `bodyLimit` (1 MiB) are refused with 413 before anything reads them; `cors` lists the
browser origins that get the headers and their preflight; one structured log line per request (owner,
caller, route, status, ms) goes to `log` or the console. Credentials' secrets beyond the connected table come
from a `SecretStore` (the environment, a function, a chain; a vault is one more implementation). Views with
`fresh: write` publish at the commit; a view with a delay (`fresh: 5m`) is published by the `/project` loop
once that much has passed since its last publish. The container is the first deployment shape:
`Dockerfile`, `compose.yml` (Postgres and the host, migrated on start) and `smoke.sh`, which brings it up,
checks `/health`, makes an owner and runs this suite against it. Environment: `CRUBAL_PG_URL`,
`CRUBAL_HOST_DOMAIN`, `CRUBAL_HOST_KEY`, `CRUBAL_HOST_CORS`, `CRUBAL_HOST_BODY_LIMIT`.

## What it does

- **Identity.** An API key, or a token an identity provider issued: `oidcVerifier({issuer, audience, jwks |
  secret, provider, identity})` checks a JWT against the issuer's JWKS (or a shared secret for HS256), its
  issuer, audience and expiry, and maps its subject through the host's identity links
  (`linkIdentity(provider, subject, owner, caller)`) to a caller. Supabase Auth is one such issuer. A
  request signed by another owner (RFC 9421 message signatures over the method, target, body digest and
  date, with the domain's Ed25519 key) resolves to the caller `<domain>:owner`, that owner acting as itself,
  its key fetched from its well-known file.
- **Owners and keys.** `createOwner(domain)` makes an owner with an Ed25519 key; every entry the owner's
  store writes is signed with it, and the public half is in the host's well-known file, so an export
  verifies anywhere. `issueKey(owner, caller)` issues an API key for a caller record (printed once, kept
  hashed); `whoIs(authorization)` resolves an API key, or any bearer token a configured verifier knows (an
  OIDC-shaped adapter goes here), to `{owner, caller}`. The store sees only the caller ID.
- **Credentials.** `secret(owner, name)` resolves a contract's credential name: a connection made in the
  host (`host.credentials`: a pasted key or password, or an OAuth grant through
  `GET /o/<owner>/connect/<name>` → the provider → `/oauth/callback`), refreshed through the provider when
  expired and marked `expired` when it can't be; else a configured source or the environment
  (`CRUBAL_SECRET_<OWNER>_<NAME>`). The fact of a connection (scheme, scopes, status, when) is readable at
  `GET /o/<owner>/connections`; the material never leaves the host's table, never enters a package or the
  log. A platform puts a vault behind the same interface.
- **Adapters.** A send's act is an adapter's: the built-in `http` adapter POSTs the payload to the
  contract's `host:url` with the credential the contract names, sent as its `auth` scheme says
  (`apikey`/`oauth2` as a bearer, `basic`), and brings the answer back as intake; a named adapter per
  contract replaces it. A missing secret or a 401 is a `failed` run with reason `credential`.
- **Packages.** `install(owner, bundle)` fetches the publisher's keys from its well-known file and hands
  the store a verified bundle.
- **The loops.** `project()` publishes every owner's stale rows (or `fresh: "write"` does it after each
  commit); `tick(now)` runs every scheduled contract's due ticks; `retry(now)` tries failed runs again
  once their contract's `retry` interval has passed, from the kept payload, and notices the owner of a run
  dead after its last attempt. All three are behind `POST /project`, `POST /tick` and `POST /retry` for a
  scheduler, guarded by the host key.
- **Terms.** A package's `terms` (12.5.1) become `GET /o/<owner>/robots.txt` (the training bots disallowed
  under `train no`, everything under `search no`), `GET /o/<owner>/terms.json`, and `X-Robots-Tag` /
  `X-Crubal-Terms` headers on every view page.
- **Emergency access** (14.13). With `emergency` terms configured (approvers, longest, the approvers'
  dedicated keys) and published in the well-known file, `POST /o/<owner>/emergency` behind the host key
  makes an edge only when the approvals are enough, each a signature over the edge with an approver's key,
  none the requester's, the mode view or control, no grant, and `until` within the longest; it is written
  witnessed into the owner's log and the owner is noticed. Every record read under it is a witnessed `read`
  write. `POST /o/<owner>/emergency/<edge>/end` ends it for the owner, except a legal order's, whose attempt
  is recorded. A witnessed entry is never redacted.

## The reference index

`GET /o/<owner>/v/<view>?page=&<filter>=<bucket>,<bucket>&q=` serves a view's page from the index
(`src/indexer.ts`, docs/design/index-and-forms.md): the index pulls the view's projection stream from the
store into its own `index_rows`, idempotently by (view, audience, seq), truncating on a `reset`, and
serves pages in the view's order from the `sort` and `pin` the store put on each row, counts per bucket
over the rows the *other* picks leave, full-text search over the row's text slots, partition by the caller's
edges, role-marked slots dropped for a caller without the role, and the `X-Robots-Tag` header
(`noindex` past page one or off a single `index` bucket). It reads nothing but the stream and can be
dropped and rebuilt from it.

## The HTTP surface

```
GET  /.well-known/crubal.json
GET  /o/<owner>/v/<view>?page=&<filter>=&q=   a view's page, counts and indexability, from the index
GET  /o/<owner>/robots.txt  ·  GET /o/<owner>/terms.json
GET  /o/<owner>/connections  ·  GET|POST|DELETE /o/<owner>/connect/<name>  ·  GET /oauth/callback   owner only
POST /o/<owner>/emergency (platform)  ·  POST /o/<owner>/emergency/<edge>/end (owner or platform)
POST /o/<owner>/run/<contract>           { record, answers? }   a form run lands the answers; a send acts
POST /o/<owner>/receive/<contract>?record=&run=   an answer (or an arrival with ?level=&of=)
GET  /o/<owner>/records/<id>[?full=1]    the values the caller may see
GET  /o/<owner>/forms/<contract>?record= the form as data for this caller
GET  /o/<owner>/stream/<contract>?cursor=view=seq   ·   POST …/ack { cursor }
GET  /o/<owner>/v/<view>?…&shape=<name>  (a further shape the view names: crubal:jsonld, crubal:portable)
GET  /o/<owner>/offer                       the offers this caller may read (7.8 `to`: public, link token, followers, named parties)
GET  /o/<owner>/offer/<contract>[?link=]    one offer as a border wrapper: records with sources, mode, terms, the signed entries
POST /o/<owner>/offer/<contract>/link       the owner mints the link token (kept across republishing)
POST /o/<owner>/offer/<contract>/unpublish  the token stops working, nothing is deleted
POST /o/<owner>/take/<contract>             the owner takes: a signed fetch of the presenter's offer, the wrapper verified against its keys, each record taken into ours (bound by the presenter's id)
POST /o/<owner>/inbox/<contract>            a presenter's pushed stream entries, signed; they land in the index under the presenter's name
POST /push · POST /expire                    loops behind the host key: push `when: entry` streams and acknowledge; sweep taken values past their terms
GET  /o/<domain>:<id>/export · POST /o/<domain>:<id>/erase/<record>   a hosted person (14.1), signed in to the domain as that caller: their own chain, their own records only
POST /o/<owner>/rotate                      a new key signs from now; the well-known file lists the old with until and the new with from (11.7)
POST /o/<owner>/install { package, version? }   install by name from the publisher's well-known file (11.7): the bundle fetched where the file says, what it extends installed first, each verified against the publisher's keys; { bundle } installs one handed in
GET  /health                                the database reachable and every chain's head (503 when not)
POST /drain                                 a loop behind the host key: pending instructions applied at a rate ({ owner?, rate? })
GET  /o/<owner>/review (open items by key)   ·   POST /o/<owner>/review { key, decision, … }
POST /o/<owner>/install { bundle }       owner only
GET  /o/<owner>/export                   owner only: the log and the intake
POST /o/<owner>/erase/<record>           owner only
POST /project  ·  POST /tick  ·  POST /retry   the loops; X-Host-Key
```

A route with no caller is `public`; what a caller may run, edit or see is the store's access (chapter 14),
never the host's. The owner is a caller whose ID is the owner itself.

## Running it

`CRUBAL_PG_URL=… CRUBAL_HOST_DOMAIN=… CRUBAL_HOST_KEY=…`, then `node bin/crubal-host.ts migrate`,
`owner create <domain>`, `key issue <owner> <caller>`, `serve --port 8787`. Everything runs and is tested
locally (`CRUBAL_PG_URL=postgres:///postgres npm test`): the test starts the server on a free port, makes
an owner and keys, installs a signed package through the API, runs a form and a send with an adapter whose
answer closes the run, reads the record as staff, verifies the exported log against the well-known file,
erases as the owner, and drives the loops with the host key.

## Not yet here

The `system` record a connection writes into the owner's data (it needs the party package's kinds, which
wait with the vocabularies), and a deployment: the host runs and is tested locally only.
