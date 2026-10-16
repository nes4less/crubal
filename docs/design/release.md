# Releasing CRUBAL 2

**Status:** design, 2026-10-15; ruled. What makes the specification published, how the corpus is versioned,
and who changes what afterwards.

## The gate

CRUBAL 2 is **published** when the first adopter package installs and runs end to end on the reference host
over the Postgres store: a bundle fetched by its well-known file, verified, installed with its dependencies,
its views projected and served by the reference index, a form run through the border, a send acted and
answered, a scheduled tick, an erasure. Until then the spec is a working draft, whatever its completeness,
because the handoffs it names are unproven.

## What happens at the gate

1. The specification gets its **date**: `CRUBAL 2 · 2026-MM-DD`, in the README's status line and on
   crubal.com, and the "Open in the spec" list is confirmed empty.
2. The **corpus is tagged**: `corpus/2026-MM-DD` on the repository. A conformance claim (13.3) cites that
   tag; a later tag renews it. Tags never move.
3. `@cruba/crubal` goes to **0.2.0**, claiming `CRUBAL 2 · Views · corpus 2026-MM-DD`;
   `@cruba/crubal-postgres` and `@cruba/crubal-host` publish at 0.1.0 as the reference store and host.
4. crubal.com serves the **spec chapters** as pages, the dated version, the corpus tag and the claim.
5. The **freeze rule** starts (11.8): a dated revision of 2 only adds; a change that breaks what readers
   hold is CRUBAL 3, with its form recipe. The corpus is tagged with each revision.

## After the gate

- **The steward.** The operator approves every spec change, as sole steward, by merging it; the rule is
  written in the repository's CONTRIBUTING file. A wider process is adopted only when others adopt CRUBAL,
  and is itself a dated revision.
- **A revision** is a pull request that changes spec text, adds corpus cases for what it adds, keeps every
  earlier case passing, and bumps the date. The reference implementation passes the new corpus before the
  revision merges.
- **A bug** between a case and a chapter (13.4) is fixed in both in one revision, the case winning when the
  chapter's intent is clear from the design documents and the chapter winning otherwise.
- **The design documents** (`docs/design/`) stay informative: they say why and how; the spec says what. A
  design that changes the spec goes through a revision.

## Before the gate: the order of work

Everything below is engine assembly; kinds, the standard vocabularies and the adopter package wait for it.
Steps 1–6 landed 2026-10-15.

1. JSON readers for definitions; the bundle builder, the change classifier and `crubal publish`; the
   well-known writer. (publishing.md)
2. `store.install` and definitions from the store. (publishing.md)
3. The send split, outtake and the review item for dead runs. (runs.md)
4. `formOf` and the `forms/` corpus folder. (index-and-forms.md)
5. The reference host, minimal: identity adapter, secrets, the `http` adapter, signing, loops, the HTTP
   surface. (host.md)
6. The reference index. (index-and-forms.md)
7. Everything the spec states that isn't app-contingent (completion.md, eight steps: review decisions and
   replay, held release, adopt, the small gaps, split, views for pages, exchange between hosts, hosted
   persons and key rotation, operations, the MUST audit, the benchmark, the claim).
8. Then the standard vocabularies and the first adopter package, and the gate.

Step 7 landed 2026-10-16 (completion.md), with the host installing by name from a publisher's well-known
file, dependencies first. What the gate names is now exercised by the host suite against two owners on one
host: install by well-known, views projected and served by the index, a form run, a send acted and
answered, a scheduled tick, an erasure, an offer taken across owners, a stream pushed. The runbook for the
real thing is `docs/design/gate-runbook.md`. Step 8 waits on the operator's parked rulings (the standard
vocabularies: party, media classes by format, the order kind; the ME package's triage). Party was ruled and
landed 2026-10-16 (`std/party`, docs/design/party.md): the three caller kinds, contact facets at staff, `connect`
and `profile` forms; roles and relations stay the adopter's. Still parked: media classes by format, the order kind,
the ME triage.
