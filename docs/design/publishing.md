# Publishing and installing

**Status:** design, 2026-10-15; the bundle, the JSON readers (by printing), `crubal publish` with the
classifier and the recipe check, and signed bundles on crubal.com are built; `store.install` and definitions
from the store are next. Not part of the specification; spec chapters 10, 11.4–11.8 and 8.5 say what
a published package and an installed one are. This document says how a bundle is made, signed, served,
found, verified, installed, and how a store builds its definitions from what it has installed. One pipe,
two ends.

## The bundle

A published version is **one JSON document**, `package.json`, at the version's URL. It holds the package
header (11.6), the members list, every member in its JSON form, the recipes since the previous version, the
package's reference records if it has any, and the signature.

```json
{
  "crubal": "2",
  "package": "me", "version": "2026-11-01", "owner": "mediaencyclopedia.com", "id": "mediaencyclopedia.com/me",
  "label": "Media Encyclopedia", "licence": "CC-BY-4.0",
  "extends": [{ "package": "crubal.com/media", "version": "2026-10-14" }],
  "prefixes": { "media": "crubal.com/media", "wd": "https://www.wikidata.org/entity/" },
  "units": { "package": "crubal.com/units", "version": "2026-10-15" },
  "trust": ["person", "me:unitizer", "observed", "declared", "reported"],
  "members": { "facet:videoCodec": "2026-10-13", "class:OpticalDisc": "2026-11-01", "view:explore": "2026-11-01" },
  "kinds": [ … ], "facets": [ … ], "classes": [ … ], "rules": [ … ], "contracts": [ … ],
  "shapes": [ … ], "filters": [ … ], "views": [ … ], "roles": [ … ], "permissions": { … }, "ownership": { … },
  "recipes": [ { "migration": { "from": "me /2026-10-13", "to": "me /2026-11-01" }, "steps": [ … ] } ],
  "records": [ … ],
  "previous": "2026-10-13",
  "hash": "sha256:…",
  "sig": "…"
}
```

- **The text is the same bundle.** `package.crubal` (and any record files) are served beside the JSON for
  people. The no-loss rule (chapter 3) makes them one document: a reader turns the text into exactly this
  JSON, so the text needs no signature of its own.
- **The hash** is the SHA-256 of the canonical form (3.9) of the document without `hash` and `sig`. **The
  signature** is the owner's Ed25519 key over the hash's bytes, as a log entry's is (8.5), made with the key
  the owner publishes in its well-known file at the time of publishing. A key rotated later verifies old
  bundles through the well-known file's `keys` history.
- **The members list is the version.** Each member carries its dated version; the package's version names
  the list. A member that didn't change keeps its version; one that did takes the publish date (`.2` for a
  second publish that day). The bundle holds every member, changed or not, so an installer needs nothing
  from earlier versions but the recipes it carries.
- **`previous`** names the version this one follows, so the chain of recipes can be walked without the
  registry.

## Publishing: the `publish` command

`crubal publish <dir>` makes a version from a package's source files (or the host makes one from an owner's
working package, 11.4):

1. **Read and check.** The source and every package it extends, at the pinned versions (fetched and
   verified as in installing below); then every publish check (11.5), with extended definitions present so
   5.10 and 7.10 can see kinds and facets that aren't the package's own.
2. **Diff against the previous version.** The previous bundle is fetched by `previous` or the well-known
   file. Each member is classified by chapter 4.8, 5.11 and 7.2: unchanged, safe, minor, breaking. An
   unchanged member keeps its version; the rest take the new date.
3. **Require the recipes.** A breaking member needs a step that covers it (10.5 (5)); a recipe `from` the
   previous version `to` this one is required when anything broke, and refused when nothing did.
4. **Pin checks.** A moved `extends` pin is itself a change: the extended package's recipes between the old
   and new pins are listed in the bundle's `recipes` after the package's own, so an installer restamps
   through them in order (10.1).
5. **Write, hash, sign.** The document, then `hash`, then `sig` with the key the host or the command holds
   for the owner. The command never holds a secret in a package; it reads the private key from the
   environment or a key store.
6. **Serve.** The host (or the site build) puts the bundle at `https://<domain>/<name>/<version>/` with the
   text beside it, updates `<name>/` to the latest, and adds the version to the well-known file.

The standard packages publish by the site build from `std/`, with crubal.com's key, which does not exist
yet; until it does their bundles are unsigned and readers that insist on a signature refuse them (11.7).

## Finding: the well-known file and the registry

`https://<domain>/.well-known/crubal.json` is the truth for a domain's packages and keys (11.7): `keys`
(current and past, each with `from` and `until`), `packages` with each version's URL, `emergency` for a
platform. The registry at crubal.com lists identities and points at their domains; it never hosts a bundle.

A **tenant is a domain.** A hosted owner with no domain of its own publishes under a subdomain the platform
serves for it (`shop.cashierfu.com`), whose well-known file the platform writes. Identity never depends on
the platform's name beyond that.

## Installing

`store.install(bundle, from)` on an owner's store, driven by the host:

1. **Verify.** The bundle's `hash` recomputes; `sig` verifies against the publisher's key from its
   well-known file (fetched by the host, handed to the store as `Keys`); `crubal` is at or below the
   store's language version (11.8); `id` matches the domain it came from.
2. **Dependencies first.** Every `extends` entry must already be installed at exactly that version, else
   the install is refused naming the missing one; the host installs the chain from the bottom. The same
   package at another version may be installed: that is a pin move.
3. **The install write.** One entry: `{"install": {"package": id, "version", "hash"}}`, and the bundle kept
   whole in `installed.bundle` (the design's table). Rebuild needs the bundle to rebuild definitions, so the
   bundle is state the log points at by hash, like intake bytes are.
4. **Restamp.** When a previous version of the same package was installed, the bundle's recipes from that
   version to this one run (10.4), each step's writes `by: migration`, and every view is marked stale.
   When nothing was installed before, nothing restamps.
5. **Definitions change.** From this entry on the store's dictionary includes the new version (below).

Uninstalling is not a thing the spec has: a package an owner no longer wants is left installed, its views
retired by the owner's `define` writes.

## Definitions from the store

The store builds what the engine runs with, instead of being handed it:

```
dictionary(owner) =
  for each installed package, in dependency order (extended before extending, then by install order):
    read the bundle's definitions (JSON form) into the dictionary
  then the owner's working package: every `define` write in log order, as the member now stands
```

- **Reading the JSON forms.** The engine reads definitions from text today. Installing needs readers for
  the JSON forms of 4.6, 5.9, 6.10, 7.9, 10.6, 11.6, 12.7 and 14.11, and `define` writes already carry them
  (8.5). This is the one engine piece the pipe needs that doesn't exist: `readDefinitionsJson(bundle,
  into)`, the inverse of the writers the site build uses, proven by round-trip cases (text → JSON → read →
  canonical JSON equal).
- **The working package wins last.** A `define` write names a member by kind and name; it replaces that
  member whatever installed package defined it, which is how an owner narrows or retires something it
  adopted, and the checks (11.5) run on the result at every `define` so a definition that breaks the set is
  refused as a write.
- **Views, contracts and permissions** come out the same way: `views(owner)`, `contracts(owner)`,
  `permissions(owner)`, built once per transaction and cached until the next `install` or `define` entry
  (the store knows, because it wrote it).
- **The store's `Projecting` and `BorderOptions` go away** as things a host passes in; a store knows its
  own definitions. Tests keep passing text in through a `define`-less install of a test bundle.

## Pin moves and the extended package's recipes

An adopter at `extends: commerce /2026-10-01` publishes a version pinned to `/2026-11-01`. Its bundle lists
commerce's recipes between the two after its own. A store installing the new adopter version restamps
through them in order, because commerce's definitions in the store's dictionary change with the pin, and
the adopter's data was written under the old ones. The host installs the newer commerce first (step 2), the
adopter second; the restamp runs once, at the adopter's install, so a store never holds data under two
pins at once.

## What this needs in the engine

| Piece | Where | Proven by |
|---|---|---|
| `readDefinitionsJson` for every member kind | `packages/crubal` | round-trip cases over the corpus's definitions and the standard packages |
| the bundle builder: members list, versions by diff, hash, signature | `packages/crubal` (`crubal publish`) | cases: unchanged member keeps its version; a breaking change without a recipe is refused; the hash recomputes; a tampered bundle fails |
| the change classifier (4.8, 5.11) | `packages/crubal` | one case per row of 4.8 |
| `store.install`, `store.dictionary()` and friends | `packages/crubal-postgres` | installing the standard packages into a store and running a corpus case over the result; a pin move restamping |
| the well-known writer | the host | the host's tests |

## Decisions for the operator

Ruled 2026-10-15: crubal.com's Ed25519 key exists (public `ZdAEPbw_CMLYZIjYM-xXBRF2tSu0Wb5aO76ebEqi4Do`, in
the well-known file from this date; the private half in the publisher's key store, to be placed in the
site build's environment as `CRUBAL_SIGNING_KEY`) (6); unsigned bundles are refused by default with a
development override (7); the bundle is one document (8).


- **A crubal.com signing key.** Nothing here signs until one exists; it should live in a key store the site
  build can reach (Vercel's encrypted environment for the build, with the public half in the well-known
  file). Rotation is a well-known file edit.
- **Signed or refused.** Whether a store refuses an unsigned bundle by default (strict, and today every
  standard package is unsigned) or installs it marked unverified until a key appears. I'd refuse by default
  with an explicit override for development, since the first adopter is us.
- **The bundle as one document.** As designed, one `package.json` per version with the text beside it; the
  alternative is a signed manifest over separate files, which is more to fetch and more to get wrong.
