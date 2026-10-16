# The gate, as a runbook

What to run, in order, when the first adopter package exists (release.md "The gate"). Every step is a
command against the reference host over a Postgres store; nothing here is new machinery.

1. **Publish the standard packages** from `std/` with the crubal.com key (the site build does this:
   `site/build.mjs` signs each bundle and writes the well-known file with `packages` and their version
   URLs). Confirm `https://crubal.com/.well-known/crubal.json` lists every package the adopter extends.
2. **Bring a host up**: `cd packages/crubal-host && ./smoke.sh` (Docker), or locally
   `node bin/crubal-host.ts migrate`, `owner create <adopter domain>`, `key issue <owner> <owner>`, `serve`.
   `GET /health` answers `ok: true`.
3. **Install by name**: `POST /o/<owner>/install { "package": "<publisher>/<name>" }` as the owner. The
   host fetches the publisher's well-known file, the bundle at the version URL, installs what it extends
   first from their publishers, and verifies each against the published keys. A tampered bundle is refused.
4. **Project and serve**: `POST /project` (host key), then `GET /o/<owner>/v/<view>`: rows from the
   reference index, counts, `x-crubal-seq`, `x-robots-tag` from the terms.
5. **A form run**: `GET /o/<owner>/forms/<contract>?record=<id>` as a caller, then
   `POST /o/<owner>/run/<contract> { record, answers }`; the value lands with the contract's origin.
6. **A send acted and answered**: `POST /o/<owner>/run/<send contract> { record }`; the adapter acts (the
   `http` adapter posts to `host:url` with the named credential), the answer closes the run and lands.
7. **A scheduled tick**: `POST /tick { "now": "<moment>" }` (host key); each due tick runs once.
8. **An erasure**: `POST /o/<owner>/erase/<record>` as the owner; the record's values leave the log and
   the state, the row leaves the projection and the stream carries its removal.
9. **The claim**: `node packages/crubal/bin/crubal.ts claim corpus --out packages/crubal/CLAIM.md`; tag
   `corpus/<date>`; date the spec; publish the packages (release.md "What happens at the gate").

Each step has a test that already does it on a local host (`packages/crubal-host/test/host.test.ts`); the
gate is the same steps against the real publisher and the adopter's own package.
