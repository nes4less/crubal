# 13. Conformance

An implementation **conforms** at a level when it does everything that level requires and passes that
level's corpus. Each level includes the levels before it.

## 13.1 Levels

| Level | Chapters it implements | Corpus folders it passes |
|---|---|---|
| **Reader** | 1–3, and reading facet definitions' types (4.2) | `reader/`, `reader-errors/` |
| **Dictionary** | 4–5 | `dictionary/`, `dictionary-errors/` |
| **Rules** | 6 | `rules/`, `rules-errors/` |
| **Store** | 8–10 | `store/`, `store-errors/` |
| **Exchange** | 7, 9 (as it applies to borders), 11 | `exchange/`, `exchange-errors/`, `package-errors/` |
| **Views** | 12 | `views/`, `views-errors/` |

A level is claimed whole. An implementation that does part of a level conforms only at the level below it.

## 13.2 What every level requires

- **No loss.** Reading and printing never lose a pair (chapter 3), and every unknown key, package setting and
  package part is carried unchanged.
- **Refuse in plain words.** Every refusal names the line or address and says what is wrong, and every
  refusal, flag, fill and hold names its rule (chapter 6.8).
- **Determinism.** The same input under the same versions gives the same output: the same canonical JSON, the
  same outcomes, the same results.
- **No secrets.** Nothing an implementation writes into CRUBAL text or JSON is a secret (chapter 7.6).

## 13.3 Claiming conformance

A claim names the language version, the level, and the corpus version it passed:

```
CRUBAL 2 · Store · corpus 2026-10-14
```

A claim SHOULD link the corpus run's output. Passing a later corpus version renews the claim.

## 13.4 The corpus

The corpus (`corpus/`, described in its README) is part of the specification. When a case and a chapter
disagree, one of them is a bug; it is fixed in a new version of both.

- Every MUST in chapters 1–11 SHOULD have at least one case that tests it.
- Cases use the `test` package (`test.example/test`) and stay independent of any adopter.
- The corpus is versioned by date, like packages, and a version never changes.

## 13.5 Extensions

A package extends CRUBAL only through what the chapters allow: prefixed keys, prefixed definition settings,
prefixed contract parts, new kinds, and new sharing modes defined by their properties. An implementation MAY
understand a package's extensions; it MUST NOT require them to conform, and MUST carry them when it doesn't.

## 13.6 Not part of conformance

How an implementation stores data (tables, documents, files), which rules it compiles into its database, how
it schedules runs, which engine an index uses (chapter 12.6.1), and how its screens look. Two conforming implementations may differ in all of these and
MUST still give the same results.
