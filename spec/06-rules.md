# 6. Rules

A **rule** says what must, should or probably is true, and what follows from it. Rules are pure: they read
values and return verdicts or proposed values. They never act. Anything that moves values or touches the
world is a contract (chapter 7).

## 6.1 The shape of a rule

```crubal
rule: dvdIsMpeg2
  for: OpticalDisc
  when: format is DVD
  then: videoCodec is MPEG-2
  strength: suggest
  because: DVD-Video is MPEG-2 by standard
  version: 2026-10-13
```

| Part | Holds | Default |
|---|---|---|
| `for` | where the rule applies: a class (its wearers), a kind, a level (`unit::`), or `everywhere` | `everywhere` |
| `when` | a condition (6.3); the rule applies only where it holds | always |
| `then` | the consequence (6.4) | required |
| `strength` | `must`, `should` or `suggest` (6.2) | required |
| `because` | the reason shown to people when the rule refuses, flags or fills | none |
| `version` | the dated version | required when published |

Rules are named like keys and versioned like facets (chapter 4.1). A rule expanded from a shortcut (chapter
4.4) or a class line (chapter 5.3.1) is named by where it came from: `title: required`,
`DvdOnly: format{DVD}`.

## 6.2 Strengths

| Strength | A write that breaks it | A value it needs that is empty | A value it can produce |
|---|---|---|---|
| **must** | refused, with the reason | the record is **incomplete** | derived, and a person may not adopt it |
| **should** | saved and **flagged** | flagged | derived; adopting it is flagged |
| **suggest** | nothing; a person's value wins | **filled**, with the rule as its source | derived; a person may adopt it freely |

"A write that breaks it" means a write to a value the rule's `then` tests. A rule whose verdict changes
because *another* value changed never deletes anything: see 6.7.

## 6.3 Conditions

```
condition = term *( " and " term / " or " term )   ; "and" binds tighter than "or"
term      = [ "not " ] ( test / "(" condition ")" )
test      = path " is " value                      ; equals
          / path " is _" / path " is -"            ; is unknown · does not apply
          / path " in " values                     ; one of: "in DVD, Blu-ray"
          / path " in " number ".." number         ; inside a range, ends included
          / path " has" [ " " value ]              ; has a value · the list holds this item
          / path ( " before " / " after " ) value  ; dates, moments, times of day, or now
          / path ( " over " / " under " ) value    ; numbers, quantities, money, ranked choices
          / path " is unique"                      ; global (6.6); in "then" only
          / path " shown to " audience             ; visibility (chapter 12.4); in "then" only
          / path " is " state                      ; a value's state (6.3.2)
path      = address / aggregate
aggregate = combine " of " address                 ; "worst of parts[*].condition"
          / ( "count" / "least" / "most" ) " of " address   ; how many · smallest · largest
```

- **Addresses** are chapter 1.10's, plus the wildcard `[*]` for every row or part, and the level prefix
  (`unit::condition`) to read a lower level from above.
- **Values** are written as in the text form (chapter 2), read by the facet at the path.
- **`now`** is the moment the rule is evaluated, supplied by the caller so results stay reproducible:
  `when: auctionEnds before now`. Moments compare by instant; a local date or time of day compared with a
  moment is undetermined; a plain date compared with a moment compares by the moment's UTC date.
- **Aggregates** use the combine rules (chapter 4.4), `count`, and `least` and `most` (the smallest and
  largest number, quantity, money or date; for ranked choices, use `best` and `worst`). `over` and `under` on a ranked choice
  compare positions in the list: earlier is higher.

### 6.3.1 Empties in conditions

A test on an **absent** or **unknown** value is **undetermined**. A test on **does not apply** (`-`) is
false, except `is -`, which is true.

| `and` | true | false | undetermined |
|---|---|---|---|
| **true** | true | false | undetermined |
| **false** | false | false | false |
| **undetermined** | undetermined | false | undetermined |

`or` is the mirror (true wins), and `not undetermined` is undetermined. `has`, `is _` and `is -` are never
undetermined: they test the empties themselves. `is unique` holds for an empty value: empties are never
compared with other records.

A rule whose `when` is false or undetermined doesn't apply. A `must` rule whose `then` is undetermined makes
the record incomplete; a `should` rule's flags it; a `suggest` rule's fills it when it can.

### 6.3.2 Value states

A condition MAY test the **state** of a value, not only the value: `is confirmed`, `is contradicted`, `is
unobserved` (chapter 9.7.2), `is conflicted` (it has alternatives, chapter 8.4), `is new` (a value the
vocabulary doesn't hold yet), `is held` (6.7), `is adopted` (chapter 8.2) and `is suggested` (it has
suggestions). State tests are never undetermined.

They are what lets contracts form a **cascade**: cheap sources first, expensive ones only when needed.

```crubal
contract: aiTitle
  kind: receive
  when: title is conflicted or not title has
```

## 6.4 Consequences

`then` is a condition (6.3) that should hold, read in one of two ways:

**A check.** Any test. It holds or it breaks. `then: runtime in 1..600`, `then: not hdrFormats has`.

**A production.** A test of the form `key is value` produces that value when the key is empty:

| Right side | Kind | Example |
|---|---|---|
| a plain value | a **fill** | `then: videoCodec is MPEG-2` |
| a template | a **derivation** | `then: listingTitle is "{title} [{format}]"` |
| an aggregate | a **rollup** | `then: condition is worst of parts[*].condition` |

- A **fill** produces only at `suggest`. At `must` and `should`, a plain value is a check.
- A **derivation** or **rollup** produces at every strength. The engine writes it, recomputes it whenever
  what it reads changes, and stores it with `origin: derived` and the rule as its `via`.
- A production writes only at a level where its key is stored: the top level, or a level where the key
  varies (chapter 1.7). Below that, records read the produced value through, as they read any other.
- A person who edits a produced value **adopts** it (✎, chapter 8): the value stops following the rule
  until it is given back. The strength says whether adopting is allowed (6.2).

### 6.4.1 Templates

A template is a quoted text with **placeholders**: `{address}` is replaced by the value there, printed as in
the text form without its detail. `{{` and `}}` write a literal brace.

- `{a ?? b ?? c}` takes the first of them that has a value.
- `{a?}` is replaced by nothing when `a` is empty, and a space or one of `· , - :` written right before it is
  dropped with it: `"{title} · {subtitle?}"` is `"Vacation"` when there is no subtitle.
- If any other placeholder's value is empty, the template produces nothing. Templates are the only computation inside rules: arithmetic, lookups and AI
belong to contracts.

## 6.5 What rules are for

Every one of these is a rule of the shape above; no other mechanism exists.

| Use | Example |
|---|---|
| a check | `then: runtime in 1..600` · should |
| a requirement | `then: title has` · must |
| forbidding | `when: format is DVD` `then: not hdrFormats has` · must |
| narrowing | `for: OpticalDisc` `then: format in DVD, Blu-ray, 4K` · must |
| a gate | `when: not format in Blu-ray, 4K` `then: hdrFormats is -` · must |
| a fill | `when: format is DVD` `then: videoCodec is MPEG-2` · suggest |
| a derivation | `then: listingTitle is "{title} [{format}]"` · should |
| a rollup | `then: condition is worst of parts[*].condition` · must |
| a global rule | `then: gtin is unique` · must |

## 6.6 Global rules

A **global rule** reads other records: `is unique` (no other record in the scope holds the same value) and
catalog membership (chapter 12). Its scope is the rule's `for`. Global rules are their own class of rule
because they need indexes; a conforming store at the Rules level MUST enforce `must`-strength global rules
at write.

## 6.7 When a verdict changes

A rule's verdict can change without anyone writing the value it tests: a gate closes because `format`
changed, a new rule version narrows a list. Then the engine never deletes and never refuses the unrelated
write. The affected value is **held**: kept, hidden from forms and pages, and flagged with the rule. It
comes back if the verdict changes again, and a person or a migration recipe (chapter 10) can resolve it.

Holding and releasing are logged writes (`as: held`, chapter 8.5), made by the engine with the rule as `by`.
They are never worked out again from the rules, so a later rule version can't change what was held in the
past.

## 6.8 Rule sets

The rules that apply to a record are those whose `for` it matches, from every class it wears, every facet
shortcut, and the package. A package MUST be refused at publish when its rule set breaks any of these:

1. **Layered.** Draw an edge from every address a rule reads (in `when` or on the right of `then`) to the
   address it produces. The graph MUST have no cycle: no rule depends on its own effect, and no two fills
   chase each other. Addresses, not bare keys: a rollup that reads `parts[*].condition` and produces
   `condition` on the whole is not a cycle.
2. **No contradictions.** Two `must` rules that can apply to the same record MUST NOT require disjoint
   values of the same key. Implementations MUST detect this at least for `is`, `in` and range tests whose
   `when` conditions are both satisfiable at once; they MAY detect more.
3. **One spelling.** A shortcut and a rule written in full that say the same thing MUST NOT both be present.

**Order.** Evaluation order never changes a result, except where a `replace` combine meets contributions in
order (chapter 4.4). An implementation MUST say which order it used in that case.

**Traceable.** Every refusal, flag, fill, derivation and hold names its rule, and every produced value's
source names it as `via`.

## 6.9 Results

After a write, a record's rule results are:

| Result | Means |
|---|---|
| **complete** | for each class it wears: no `must` rule is undetermined or broken |
| **completeness** | a number from 0 to 1: the asked facets that have a value, divided by all asked facets. Unknown counts as empty, does-not-apply as answered. Parts are measured on themselves and never added to the whole's count, so a five-disc set isn't less complete than one disc for the same answers |
| **incomplete** | a `must` rule needs a value that is empty; lists the rules |
| **flagged** | a `should` rule broke or is undetermined; lists the rules and addresses |
| **filled** · **derived** | values the rules produced, with their sources |
| **held** | values hidden by a changed verdict (6.7) |

A write that breaks a `must` rule is not a result: it is refused, and nothing changes.

## 6.10 The JSON form

```json
{
  "rule": "dvdIsMpeg2",
  "for": "OpticalDisc",
  "when": "format is DVD",
  "then": "videoCodec is MPEG-2",
  "strength": "suggest",
  "because": "DVD-Video is MPEG-2 by standard",
  "version": "2026-10-13"
}
```

Conditions are stored as their text (6.3), so there is one grammar for them, not two.

## 6.11 Open

- Events versus current values.
- Which rules a store compiles into its database and which it checks in the application is an
  implementation choice; the results MUST be the same.
