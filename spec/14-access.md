# 14. Access

This chapter says who may do what to which record, and how people and systems relate to records without
being given anything. Proving who a caller is belongs to the host (chapter 7.6); everything here is decided
inside CRUBAL, from data, and logged.

One structure carries all of it: the **edge**. Ownership, delegated control, taking part, viewing,
following and paid subscriptions are all edges, so the same checks, history and revocation apply to every
one of them.

## 14.1 Principals and boundaries

- **A caller is a record**: a person, an organization or a system. Edges name callers by ID.
- **The owner is the tenant.** An owner (chapter 1.1, a domain) has its own store, log and packages, and
  holds `own` over every record it has. Nothing in this chapter crosses from one owner to another: owners
  meet only through offer and take (chapter 7.8).
- **The platform above owners has no default access.** A service that hosts many owners reaches an owner's
  records only through an edge that owner grants, and every use of it is logged like any other.

## 14.2 Containment: `within`

`within` is an envelope link (chapter 1.1) from a record to the record it belongs to for access: a session
within a facility, a league within a session, a team within a league. It nests to any depth and across
kinds.

- A record is `within` at most one record. The links MUST NOT form a cycle.
- **`within` is not `of`.** `of` is a level of one kind, where values fold (chapter 1.7). `within` carries
  access and never moves a value. A unit is `of` its product without being `within` it: whoever owns the
  catalog doesn't own every seller's units.
- **Ancestors.** A record's ancestors are every record up its `within` chain. A store MUST keep each record's
  ancestors so that an access check is a lookup, never a walk, at any depth. Changing a `within` link is an
  envelope write (chapter 8.5), and the store updates the ancestors of everything below it.
- **Membership is not containment.** A person who plays on a team is not `within` the team. They hold an
  edge to it (14.3). Their own record stays theirs, they can be on many teams, and leaving is one edge.

## 14.3 Edges

An **edge** says that a caller stands in a relation to a record, with a mode of access.

```crubal
edge: E-71
  who: person:P-2201
  relation: coordinator
  mode: control
  on: L-9                       // the spring league
  grants: scheduleGames, recordScores
  where: not status is archived
  until: 2027-06-30
  by: E-12                      // the facility owner's edge
```

| Part | Holds | Default |
|---|---|---|
| `who` | the caller | required |
| `relation` | what the link means: `owner`, `captain`, `player`, `follower`, `subscriber`, or a name the package declares | required |
| `mode` | `own`, `control`, `consume`, `view` or `none` (14.4) | required |
| `on` | the record it is on; it also covers every record `within` it | required |
| `grants` | for `control`: the presets and menu items it carries (14.6) | none |
| `where` | a condition (chapter 6.3) that narrows it further (14.6) | none |
| `until` | a moment it lapses at | never |
| `by` | the edge it was granted under (14.5), or `owner` for the owner's own grant | required |

Edges are written and removed only through the border, as logged writes (chapter 8.5), and every one has a
history.

## 14.4 Modes

| Mode | The caller may | Example |
|---|---|---|
| **own** | everything on the record and what is within it, including deciding who else controls it | a facility's operator; a team's captain; a collector over their collection |
| **control** | what its `grants` list, on the record and what is within it | front-desk staff with `checkIn`; a league coordinator |
| **consume** | take part: run the contracts and forms the package opens to consumers, and see and change only their own part | a player submitting availability; a customer buying |
| **view** | read, as the views built for them allow | a fan; the public |
| **none** | nothing; the edge is a relation only (14.8) | a follower |

Each mode includes the ones below it. **Ownership is full access**: an `own` edge carries every menu item
(14.6) on its records. Full access is full permission, never a way around the data: `must` rules, archived
records and the trust order still apply to an owner.

**Effective access.** A caller's access to a record is worked out from every live edge the caller holds on
the record or on any of its ancestors: the highest mode among them, and for `control`, every item they carry
together. An edge whose `where` doesn't hold for the record, or whose `until` has passed, doesn't count.

**Audiences** (chapter 12.4) are edges every caller of a kind holds implicitly: `public` is `view` for
everyone, `member` is `view` for every signed-in person, `staff` is anyone with a `control` edge on the
owner's records, and `owner` is the owner.

## 14.5 The grantor chain

- **You grant only what you hold.** An edge's mode is at most its grantor's, its `on` is within the grantor's
  reach, and its `grants` are among the grantor's. An `own` edge may grant anything up to `own`; a `control`
  edge may grant only if it carries the `grant` item for what it grants.
- **An edge is only as good as its grantor.** An edge is live while the edge named in its `by` is live and
  still covers it. When an edge lapses or is removed, every edge granted under it lapses with it, down the
  chain. Nothing is deleted: lapsed edges stay in the history.
- **Every chain ends at an owner.** Following `by` from any edge reaches an `owner` grant in a finite number of
  steps.
- **Upper owners stay above.** The owner of a league can remove the edges inside a team that sits within it,
  including the captain's `own`.

## 14.6 Permissions: menus, presets and narrowing

A package declares what can be granted on its records:

```crubal
permissions: facility
  menu:
    checkIn: run checkIn                         on: owned
    sellPasses: run sellPass, see unit::price
    scheduleGames: edit gameTime, run publishSchedule
    recordScores: edit score
    seeCost: see unit::cost
    decideArrivals: review arrivals
    archiveUnits: archive unit
    grantStaff: grant checkIn, sellPasses
  presets:
    frontDesk: checkIn, sellPasses               audience: staff
    coordinator: scheduleGames, recordScores     audience: staff
    seller: sellPasses, archiveUnits, seeCost    audience: member
```

- **Menu items** are the only things that can be granted. Each is a verb with its targets, and optionally
  an `on` scope.
- **The verbs:** `see` (a value is shown), `edit` (a form may write it), `run` (a contract may start),
  `review` (queue items may be decided: vocabulary, arrivals, migrations), `archive` and `merge` (chapter
  1.12), `apply` (instructions, chapter 10.7), `install` (a package version, and the restamp that follows)
  and `grant` (making edges for the listed items). Targets are facets, classes, views, contracts and queues;
  `*` means all.
- **Scopes.** `on: owned` means records the caller owns; `on: relation player` means records the caller
  holds that relation to; any other `on` is a condition over the record and `caller`. With no `on`, an item
  covers what the edge it is granted on covers.
- **Presets** are named bundles of items, each on an audience. A spec `role` (chapter 12.4) is a preset.
- **À la carte.** An edge's `grants` may mix presets and single items.
- **Narrowing only.** An edge's `where` adds conditions; it can never widen an item. A specific grant ("may
  edit price only on units in NM or VG condition") is an item plus a `where`.

A package MUST be refused at publish when an item names a verb, facet, class, view, contract or queue that
doesn't exist, a preset names an item that doesn't exist, or a preset grants anything its audience can't see.

## 14.7 Systems

A system is a caller like a person. When a utility registers, it **requests** menu items, as an app requests
scopes: the enricher asks for `edit` on the facets it fills, `on: wears OpticalDisc`. An owner who approves
grants a `control` edge carrying exactly those items. What every system may do is therefore a list anyone
with `view` on the edge can read, and removing the edge cuts it off.

An AI agent that signs in is a system or acts for a person; either way it holds only the edges granted to
it, and its writes carry its own `by` in the log.

## 14.8 Relations

An edge with mode `none` is a **relation** only: following a team, watching a listing, favouriting a
release.

- **A relation never grants anything.** Following gives a caller nothing they couldn't already see.
- **You can follow only what you can view.** If the caller's view lapses, the relation goes dormant, and it
  comes back if view returns. It is never removed silently.
- **Relations drive feeds and notifications.** A view MAY declare `partition: relation follower` (or any
  relation, or `owned`): each projection row carries its record and ancestors, the host hands the index the
  verified caller's edges, and the index serves a caller only the rows they stand in that relation to. The
  store decides the rows; the index only matches them (chapter 12.6.1).
- **Paid subscriptions are contracts.** A checkout that sells a season's stats creates an edge with
  `mode: view`, `relation: subscriber` and an `until`, and usually a `follower` relation beside it. The
  purchase decides access; the relation decides the feed.

## 14.9 The JSON form

```json
{
  "edge": "E-71",
  "who": "person:P-2201",
  "relation": "coordinator",
  "mode": "control",
  "on": "L-9",
  "grants": ["scheduleGames", "recordScores"],
  "where": "not status is archived",
  "until": "2027-06-30T00:00Z",
  "by": "E-12"
}
```

Permissions hold `menu` (name → `{"verbs": {"run": ["checkIn"]}, "on": "owned"}`) and `presets` (name →
`{"items": […], "audience": "staff"}`).

## 14.10 Well-formed access

A store MUST refuse a write that:

1. makes a `within` cycle;
2. grants an edge its grantor can't (14.5): a higher mode, a record outside the grantor's reach, or items the
   grantor doesn't hold or can't grant;
3. names a preset or item the package doesn't declare;
4. gives `grants` to an edge whose mode isn't `control`, or a mode other than `none` to a relation the package
   declares as relation-only.

## 14.11 Open

- Whether an organization's stewardship gives all its members full access, or only its admins (a preset the
  organization grants).
- Time-limited support access from a platform above owners: its shape as an edge an owner grants, and how
  its uses are shown to the owner.
