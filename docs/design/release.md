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

## The gate, run 2026-10-19 (brief 17 item 9)

The reference host was brought up locally over its own schema (`gate_2026_10_19`, owner `gate.example`),
with `CRUBAL_HOST_OF` pointing cashierfu.com and mediaencyclopedia.com at the Cashierfu app's host on the
development machine, which had just published the 2026-11-11 package set. crubal.com answered its
well-known file with core 2026-10-14, units 2026-10-15 and party 2026-10-16 (step 1). The host migrated,
made its owner and issued a key; `/health` answered (step 2). The install by name of
`cashierfu.com/product` fetched the adopter's well-known file, resolved what it extends, and **stopped at
crubal.com/party: the bundle crubal.com serves carries no signature**, and a conforming store refuses an
unsigned bundle (step 3). The site build signs only when `CRUBAL_SIGNING_KEY` is in its environment, and
the first pair's private half had never reached it. The steward rotated the key that afternoon (public half
in the well-known file from 2026-10-19), set the private half in the deployment and redeployed; the install
by name then went through, party verified from crubal.com and the adopter's packages from its host, and
steps 4, 5, 7 and 8 passed on them (the gate log has each answer). Step 6 against the adopter's own
packages has no `http` send to run (its sends are adapter-bound: eBay, Stripe mail, the bench printer, the
marketplace stream); the host suite shows it with a test contract. **The gate is passed.**

The claim was re-run the same day against the corpus dated 2026-10-19, which gained cases for the
revisions of the day: a state facet moving under `transitions` (exchange/032), a member's form on a record
they don't own (exchange/033), a class nothing wears (dictionary/010). Reader 25, Dictionary 48, Rules 61,
Store 110, Exchange 172, Views 198. The spec's status line carries the date; the tag `corpus/2026-10-19`
and the npm publish (`@cruba/crubal` 0.2.0, the store and the host 0.1.0) follow the steward's merge and
the signed site.

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
and `profile` forms; roles and relations stay the adopter's. Layer ruling the same day: crubal.com is the silent
engine and publishes only core, units and party; product, service and commerce moved to the Cashierfu layer
(ME repo, `crubal/cashierfu/`, owner cashierfu.com) and media to ME's own (`crubal/me/media.crubal`). Media classes
by format and the order kind are now Cashierfu- and ME-layer work, taken layer by layer after this one.
