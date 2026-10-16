# @cruba/crubal-host

The reference CRUBAL host (docs/design/host.md): what the specification hands the host, and nothing a
business requires. It runs owners' stores on `@cruba/crubal-postgres`, proves who a caller is, resolves
secrets by name, acts through adapters, signs each owner's chain, installs published packages, publishes
views and runs schedules, and serves one small HTTP surface. It owns no model: everything goes through
`PgStore` and `PgBorder`, and what it keeps of its own (owners' keys, API keys, identity links) lives in
its own tables.

## What it does

- **Owners and keys.** `createOwner(domain)` makes an owner with an Ed25519 key; every entry the owner's
  store writes is signed with it, and the public half is in the host's well-known file, so an export
  verifies anywhere. `issueKey(owner, caller)` issues an API key for a caller record (printed once, kept
  hashed); `whoIs(authorization)` resolves an API key, or any bearer token a configured verifier knows (an
  OIDC-shaped adapter goes here), to `{owner, caller}`. The store sees only the caller ID.
- **Secrets.** `secret(owner, name)` from a configured source or the environment
  (`CRUBAL_SECRET_<OWNER>_<NAME>`); never from a package, never into the log.
- **Adapters.** A send's act is an adapter's: the built-in `http` adapter POSTs the payload to the
  contract's `host:url` with the credential the contract names, sent as its `auth` scheme says
  (`apikey`/`oauth2` as a bearer, `basic`), and brings the answer back as intake; a named adapter per
  contract replaces it. A missing secret or a 401 is a `failed` run with reason `credential`.
- **Packages.** `install(owner, bundle)` fetches the publisher's keys from its well-known file and hands
  the store a verified bundle.
- **The loops.** `project()` publishes every owner's stale rows (or `fresh: "write"` does it after each
  commit); `tick(now)` runs every scheduled contract's due ticks. Both are behind `POST /project` and
  `POST /tick` for a scheduler, guarded by the host key.

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
POST /o/<owner>/run/<contract>           { record, answers? }   a form run lands the answers; a send acts
POST /o/<owner>/receive/<contract>?record=&run=   an answer (or an arrival with ?level=&of=)
GET  /o/<owner>/records/<id>[?full=1]    the values the caller may see
GET  /o/<owner>/forms/<contract>?record= the form as data for this caller
GET  /o/<owner>/stream/<contract>?cursor=view=seq   ·   POST …/ack { cursor }
GET  /o/<owner>/review   ·   POST /o/<owner>/review/<item> { decision }
POST /o/<owner>/install { bundle }       owner only
GET  /o/<owner>/export                   owner only: the log and the intake
POST /o/<owner>/erase/<record>           owner only
POST /project  ·  POST /tick             the loops; X-Host-Key
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

An OIDC verifier for a real identity provider, the OAuth connect flow and the `system` record a connection writes
(docs/design/host.md, "Identity and credentials"), the retry loop for failed runs, terms as robots rules
and headers, signed requests between owners, and the emergency-access mechanics.
