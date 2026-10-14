# CRUBAL

CRUBAL is a language and engine for data about any kind of thing. Everything is a key and a value: records
are pairs, a facet's definition is pairs about a key, and rules, contracts, views and packages are pairs too.
The engine is universal at the kind level; commerce, media and the rest are packages that attach to kinds.

| Folder | Holds | Licence |
|---|---|---|
| [`spec/`](spec/README.md) | the specification, CRUBAL 2, in 13 chapters | CC-BY-4.0 |
| [`corpus/`](corpus/README.md) | the conformance test corpus | CC-BY-4.0 |
| `packages/crubal/` | the reference implementation, `@cruba/crubal` (TypeScript first; a Rust core compiled to WebAssembly once the language freezes) | Apache-2.0 |

**Status:** the spec is a complete working draft. The reference implementation passes the **Reader**, **Dictionary**, **Rules**, **Store** and **Exchange** levels and is being built level by level
(Reader, Dictionary, Rules, Store, Exchange, Views); each level is done when its corpus folders pass.

The home of the core definitions and standard packages will be `crubal.com`.

## Licences

Code is licensed under the Apache License 2.0 (`LICENSE`). The specification and the corpus are licensed
under Creative Commons Attribution 4.0 International (`LICENSE-spec`).
