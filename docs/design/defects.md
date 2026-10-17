# Engine defects found by review

A running list, one entry per defect or gap, with the chapter it offends, how it was found, and what was done.
The first pass (2026-10-17) read the paths the Cashierfu app drives against the spec: forms and intake (3, 7.7,
9), publishing and versioning (4.8, 11), access and `who` (14), restamp and dry run (10), the log's `by` (8).

## Fixed, with a test

| # | Found | Chapter | Defect | Fix | Test |
|---|---|---|---|---|---|
| D1 | operator's first save, brief 2 | 3, 9 | A form body's JSON values (a boolean, `$link`, `$image`, a list) were serialized into text and misread as a spelling or a detail. | `leaves` stops at a value object; `foldIn` takes chapter 3's forms as values, a list item by item. | intake-json-forms |
| D2 | brief 2 step 3 | 7.6, 14.6 | `who: caller may edit X` read only a `roles` value on the caller's record, never their edges, so a hosted caller could never satisfy it and a member with consume could run any form on their record. | `permitted` asks the run's access whether the caller holds the item on the record. | who-may |
| D3 | operator's first rerun, brief 2 | 4.8, 12.4 | A new `must … shown to` rule was a breaking change needing a review recipe; a show rule tests no data. | `classify` treats show rules as safe. | publish-show-rule |
| D4 | operator's first save, brief 2 | 8.5 | A form run on an existing record logged `by: {contract, run}`, not the person; arrivals already named them. | `receiveRun` commits by the person for a form with a caller. | cashierfu settings proof |
| D5 | pass 1 | 3, 7.7 | A compound answer as an object was split into unknown leaves (`shipTo.name`), so no form could take a compound. | `leaves` keeps an object whole at a path the contract maps; `foldIn` folds a compound's children under their facets. | audit-forms-access |
| D6 | pass 1 | 1.4.3, 1.4.4 | A bare decimal under a facet with a unit (`12.5` under `#USD`) was split into `12` + unit `.5` and sent to unit review. | A bare decimal is the number in the facet's unit: money for a currency, a quantity otherwise; a facet taking any currency still needs one. | audit-forms-access |
| D7 | pass 1 | 3 ("what is absent stays absent") | An empty-string answer landed as the value `""`. | An empty string is no answer: outcome `ignored`, the value kept; an empty is written as `$empty`. | audit-forms-access |
| D8 | pass 1 | 14.4, 12.4 | `may` gave a control holder only their items, so staff with the settings preset saw less than a member (`see` false); and `see` below admin was true for every facet, so a member with consume read staff-only values through the host's record read. | Each mode includes the ones below it; a `see` below admin is what the show rules give the caller's audience capped at member, or an item; `Access.shown` carries the rules, set wherever definitions are at hand. | audit-forms-access, host 14.8 |
| D9 | pass 1 | 10.1, 10.4 | An install two versions ahead applied only the recipe from the installed version; the second recipe's data stayed stale and invalid against the new list. The dry run reported the same single step. | `recipesBetween`: every recipe from the installed version to the new one, oldest first, in install and dry run. | postgres install |
| D10 | pass 1 | 14.12 | A version that dropped a preset or menu item live edges still granted installed silently, leaving grants that name nothing. | Install compares the new version's permissions with the previous version's and refuses while a live edge grants a dropped name; lapsed edges don't count. | postgres install |

## Gaps, noted and not changed

| # | Chapter | Gap | Proposal |
|---|---|---|---|
| G1 | 14.4 | Consume lets a caller run **any** contract on the record their edge sits on; the spec says "the contracts and forms the package opens to consumers", and nothing declares which. A form's `who: caller may …` narrows it (D2), one form at a time. | A contract setting naming the lowest audience that may run it (`audience: member`, default `member` for forms today, `staff` for anything with a `who`), checked beside the menu. Spec amendment before the Storefront's checkout forms. |
| G2 | 7.6 | `who` paths over the caller's values (`caller.role is staff`) read the caller's record; a hosted caller (14.8) has none here, so such a `who` can never hold for them. | Read the hosted person's record from their platform through the host (a vouched read), or document that `who` over values is for local callers and `caller may` for everyone. |
| G3 | 12.4, 14.4 | A relation-only edge (`mode: none`, a follower) makes its holder a `member` for audiences. The spec's member is "every person the owner has admitted by any live edge", so this reads as intended, but a follower then reads member views. | Decide in the spec whether `none` admits to member or stays public; the engine follows the spec's word today. |
| G4 | 9.2 | A compound answer's child contradictions are folded into the parent's single outcome; a wrong child type lands as given. | Per-child outcomes under the parent's path, as rows already get. |
