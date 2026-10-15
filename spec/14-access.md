# 14. Access

This chapter says who holds data, who may do what to which record, and how people and systems relate to
records without being given anything. Proving who a caller is belongs to the host (chapter 7.6); everything
here is decided inside CRUBAL, from data, and logged.

Two things are kept apart. **Ownership** is holding the key to data: it belongs to owners alone (14.1).
**Administration** is who may manage what inside an owner's data: it is carried by edges (14.3), and the
same mechanics apply at every depth. One structure carries all of administration and every relationship:
the **edge**. Delegated control, taking part, viewing, following and paid subscriptions are all edges, so
the same checks, history and revocation apply to every one of them.

## 14.1 Owners and the key

- **A caller is a record**: a person, an organization or a system. Edges name callers by ID.
- **An owner holds the key.** An owner is a domain (a tenant of a platform, or a site of its own; Media
  Encyclopedia is one), or a person hosted by one. Every record names its owner in its envelope (chapter
  1.1).
- **Only the owner may:** erase (redaction, chapter 8.5.2), export everything it owns, grant edges to callers
  of other owners (14.8), transfer ownership, and close its data. No edge carries these.
- **People own aspects of their own data.** A package declares which records a person may own, by kind or
  class:

  ```crubal
  ownership:
    person: Collection, List, Note, Profile
  ```

  A person's owned records live in the host's store but in **their own log chain** (chapter 8.5), so they
  can be exported or moved whole, and erased by them alone. The host signs that chain on their behalf until
  they publish a key of their own, which the host lists under its well-known `keys` by the person's ID
  (chapter 11.7). When the host installs a package version, it restamps their records too, in their chain,
  with `by: migration` (chapter 10.4). The host owns everything else, including the facts a person
  contributes to shared records: those are values with sources (chapter 1.9), not owned records.
- **The platform above owners has no default access.** A service that hosts many owners reaches an owner's
  records only through an edge that owner grants (14.8), or, for a legal order or a security incident only,
  an emergency edge under published terms (14.13). Every use of either is logged.

## 14.2 Containment: `within`

`within` is an envelope link (chapter 1.1) from a record to the record it belongs to for access: a session
within a facility, a league within a session, a team within a league. It nests to any depth and across
kinds.

- A record is `within` at most one record. The links MUST NOT form a cycle, and MUST NOT cross owners: a
  person's own records (14.1) are never within the host's, or an admin's edge on the host's root would
  reach them.
- **`within` is not `of`.** `of` is a level of one kind, where values fold (chapter 1.7). `within` carries
  access and never moves a value. A lower record is `of` the record above without being `within` it (a
  seller's unit is `of` a shared product): whoever administers the shared record doesn't administer every
  record below it.
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
  on: L-9                       // the rec league
  grants: scheduleGames, recordScores
  where: not status is archived
  until: 2027-06-30
  by: E-12                      // the facility operator's edge
```

| Part | Holds | Default |
|---|---|---|
| `who` | the caller, of this owner or another (14.8) | required |
| `relation` | what the link means: `operator`, `captain`, `player`, `follower`, `subscriber`, or a name the package declares | required |
| `mode` | `admin`, `control`, `consume`, `view` or `none` (14.4) | required |
| `on` | the record it is on; it also covers every record `within` it | required |
| `grants` | for `control`: the presets and menu items it carries (14.6) | none |
| `where` | a condition (chapter 6.3) that narrows it further (14.6) | none |
| `until` | a moment it lapses at | never |
| `gate` | `review`: writes under it land as suggestions for review (14.7) | none |
| `reviewer` | with `gate`: who accepts or denies them | the grantor |
| `by` | the edge it was granted under (14.5), `owner` for the owner's own grant, or `platform` for an emergency edge (14.13) | required |

Edges are written and removed only through the border, as logged writes (chapter 8.5), and every one has a
history.

## 14.4 Modes

| Mode | The caller may | Example |
|---|---|---|
| **admin** | administer everything on the record and what is within it, including deciding who else controls it | a facility's operator; a team's captain |
| **control** | what its `grants` list, on the record and what is within it | front-desk staff with `checkIn`; a league coordinator |
| **consume** | take part: run the contracts and forms the package opens to consumers, and see and change only their own part: the records and rows a contract created for them | a player submitting availability; a customer buying |
| **view** | read, as the views built for them allow | a fan; the public |
| **none** | nothing; the edge is a relation only (14.9) | a follower |

Each mode includes the ones below it. **`admin` is full administration**: it carries every menu item (14.6)
on its records, but never the owner's key (14.1). It is never a way around the data either: `must` rules,
archived records and the trust order still apply.

**An owner** holds `admin` over every record it owns, and the key besides.

**Effective access.** A caller's access to a record is worked out from every live edge the caller holds on
the record or on any of its ancestors: the highest mode among them, and for `control`, every item they carry
together. An edge whose `where` doesn't hold for the record, or whose `until` has passed, doesn't count.

**Audiences** (chapter 12.4) are read off edges: `public` is `view` for everyone; `member` is every person
the owner has admitted (the signup contract grants their first edge, `consume` or `view`, on the owner's
root); `staff` is anyone with a `control` or `admin` edge on any of the owner's records, and anyone holding
an emergency edge (14.13); `owner` is the owner. An audience says which projection a caller may read; which
*rows* of it they see is the view's partition (chapter 12.6), so a `control` edge over one league admits its
holder to staff views and shows them that league only, and an emergency responder reads staff views of
what their edge covers. A `view` edge admits to `member` and no higher: what it opens is a member view
partitioned by its relation (a season's stats for `relation subscriber`, 14.10), never a staff projection.

**A contract grants the consumer's edge.** A contract that creates a record for a caller (an order, a
booking, a submission) also writes that caller's edge on it, `mode: consume` with the contract's relation,
under the running system's own edge as `by`. The owner owns the record; the consumer holds their part, and
that is what "their own part" means above.

## 14.5 The grantor chain

- **You grant only what you hold.** An edge's mode is at most its grantor's, its `on` is within the grantor's
  reach, and its `grants` are among the grantor's. An `admin` edge may grant anything up to `admin`; a
  `control` edge may grant only if it carries the `grant` item for what it grants.
- **An edge is only as good as its grantor.** An edge is live while the edge named in its `by` is live and
  still covers it. When an edge lapses or is removed, every edge granted under it lapses with it, down the
  chain. Nothing is deleted: lapsed edges stay in the history.
- **Every chain ends at an owner.** Following `by` from any edge reaches an `owner` grant in a finite number of
  steps. The owner holds the key at the top of every chain. The one exception is an emergency edge (14.13),
  which ends at `platform` and can't be granted onward.
- **Upper admins stay above.** The admin of a league can remove the edges inside a team that sits within it,
  including the captain's `admin`.

## 14.6 Permissions: menus, presets and narrowing

A package declares what can be granted on its records:

```crubal
permissions: facility
  menu:
    checkIn: run checkIn                         on: administered
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
  relations: operator, coordinator, captain, player, subscriber, follower only
```

- **Relations** are the names an edge's `relation` may take on the package's records. One marked `only` is
  relation-only: an edge with it has `mode: none` (14.10).
- **Menu items** are the only things that can be granted. Each is a verb with its targets, and optionally
  an `on` scope.
- **The verbs:** `see` (a value is shown), `edit` (a form may write it), `run` (a contract may start),
  `review` (queue items may be decided: vocabulary, arrivals, migrations, gated writes), `archive` and
  `merge` (chapter 1.12), `apply` (instructions, chapter 10.7), `install` (a package version, and the
  restamp that follows) and `grant` (making edges for the listed items). Targets are facets, classes, views,
  contracts and queues; `*` means all. The owner's powers (14.1) are not verbs and can't be granted.
- **Scopes.** `on: owned` means records the caller owns (14.1); `on: administered` means records the caller
  has `admin` on; `on: relation player` means records the caller holds that relation to; any other `on` is a
  condition over the record and `caller`. With no `on`, an item covers what the edge it is granted on
  covers.
- **Presets** are named bundles of items, each on an audience. A spec `role` (chapter 12.4) is a preset.
- **À la carte.** An edge's `grants` may mix presets and single items.
- **Narrowing only.** An edge's `where` adds conditions; it can never widen an item. A specific grant ("may
  edit price only on units in NM or VG condition") is an item plus a `where`.

A package MUST be refused at publish when an item names a verb, facet, class, view, contract or queue that
doesn't exist, a preset names an item that doesn't exist, a preset grants anything its audience can't see, or
a contract's relation isn't declared.

## 14.7 Gated edges

An edge with `gate: review` gives access whose writes don't land. Each write made under it becomes a
**suggestion** on the record (chapter 7.5), and the edge's `reviewer` accepts or denies it. Accepting writes
the value with its original source; denying keeps it in the history as denied. Both are logged review writes
(chapter 8.5).

A gate fits any access that should be watched before it is trusted: support from outside (14.8), a new
member of staff, a community contributor, a utility on trial. Lifting the gate is a new version of the edge,
logged like any other.

## 14.8 Across owners

An owner MAY grant an edge to a caller of another owner: a peer-to-peer connection, with the other side
proven by its domain's key (chapter 7.8). Support from the platform that hosts the owner is one such edge.

- Only the owner may grant it (14.1); no admin can.
- It SHOULD carry an `until`, and SHOULD carry `gate: review` unless the owner chooses otherwise.
- Every write the foreign caller makes is logged in the owner's log with that caller as `by`, so the owner can
  see everything it did as a view of its own log.
- Offer and take (chapter 7.8) remain the way owners share data. A cross-owner edge shares access, not data:
  the foreign caller works on the owner's records where they are.

## 14.9 Systems

A system is a caller like a person. When a utility registers, it **requests** menu items, as an app requests
scopes: the enricher asks for `edit` on the facets it fills, `on: wears OpticalDisc`. An admin who approves
grants a `control` edge carrying exactly those items, gated while it is on trial if they choose. What every
system may do is therefore a list anyone with `view` on the edge can read, and removing the edge cuts it off.

An AI agent that signs in is a system or acts for a person; either way it holds only the edges granted to
it, and its writes carry its own `by` in the log.

## 14.10 Relations

An edge with mode `none` is a **relation** only: following a team, watching a listing, favouriting a
release.

- **A relation never grants anything.** Following gives a caller nothing they couldn't already see.
- **You can follow only what you can view.** If the caller's view lapses, the relation goes dormant, and it
  comes back if view returns. It is never removed silently.
- **Relations drive feeds and notifications.** A view MAY declare `partition: relation follower` (or any
  relation, `owned` or `administered`): each projection row carries its record and ancestors, the host hands
  the index the verified caller's edges, and the index serves a caller only the rows they stand in that
  relation to. The store decides the rows; the index only matches them (chapter 12.6.1).
- **Paid subscriptions are contracts.** A checkout that sells a season's stats creates an edge with
  `mode: view`, `relation: subscriber` and an `until`, and usually a `follower` relation beside it. The
  purchase decides access; the relation decides the feed.

## 14.11 The JSON form

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

A gated edge adds `"gate": "review"` and, when it isn't the grantor, `"reviewer"`. Permissions hold `menu`
(name → `{"verbs": {"run": ["checkIn"]}, "on": "administered"}`), `presets` (name → `{"items": […],
"audience": "staff"}`) and `relations` (name → `{"only": true}` or `{}`); `ownership` maps `person` to the
kinds and classes a person may own.

## 14.12 Well-formed access

A store MUST refuse a write that:

1. makes a `within` cycle;
2. grants an edge its grantor can't (14.5): a higher mode, a record outside the grantor's reach, or items the
   grantor doesn't hold or can't grant;
3. grants an edge to another owner's caller, unless the owner itself grants it (14.8);
4. names a preset or item the package doesn't declare;
5. gives `grants` to an edge whose mode isn't `control`, or a mode other than `none` to a relation the package
   declares as relation-only;
6. makes a person the owner of a record the package's `ownership` doesn't let a person own.

## 14.13 Emergency access

A platform that hosts owners MAY reach an owner's records without the owner's grant, only through an
**emergency edge**, and only for a **legal order** or a **security incident** that threatens the owner or
others. It is the one edge not granted from inside the owner, so everything about it is stricter than any
other.

- **Not for lockouts.** An owner who can't sign in has an authentication problem, which the host solves by
  account recovery (chapter 7.6). Recovery restores the owner's own access; it never needs an edge on their
  data.
- **Declared in advance.** A platform that can make emergency edges MUST publish its terms for them in its
  well-known file (chapter 11.7): who can approve, the longest they last, and how owners are told. An owner
  can always read them before trusting the platform, and a platform with no published terms can make none.
- **Several people, none of them the requester.** An emergency edge is created only when at least two
  approvers (or more, as the terms say) have each approved it, none of them the person asking. Each approval
  is signed with a key kept for this purpose alone, separate from everyday credentials, and given right after
  a fresh sign-in. No automation can approve.
- **A stated reason.** The edge carries its kind (`legal` or `incident`), the reason, and the reference of the
  order or incident.
- **As narrow and short as possible.** It is `view`, or `control` with only the items it names; never `admin`,
  never any owner power (14.1), never `grant`. It has an `until` no later than the terms allow, and it can't
  be extended: more time is a new edge with new approvals.
- **Writes are gated.** Any write under it lands as a suggestion with the owner as reviewer (14.7), unless a
  legal order requires the write itself, in which case the order's reference is on the write.
- **Reads are logged too.** Everything read under an emergency edge is written to the log, record by record,
  which no other edge requires.
- **Witnessed on both sides.** The edge, its approvals and every read and write are in the owner's signed log
  and, as a copy, in the platform's own log, each entry marked `witnessed: true`, which neither side can
  redact (chapter 8.5).
- **The owner is told.** At once, unless a legal order requires a delay. A delay is recorded with the order's
  reference and its end, and the owner is told when it ends.
- **The owner can end it**, unless it cites a legal order; then ending it is the order's matter, and the
  owner's attempt is recorded.
- **Every emergency edge raises an alert** at the platform and, once it may be told, at the owner.

```json
{
  "edge": "E-9001",
  "who": "platform.example:staff/S-14",
  "relation": "emergency",
  "mode": "view",
  "on": "R-ROOT",
  "until": "2026-10-16T18:00Z",
  "emergency": {
    "kind": "incident",
    "reason": "Card-skimming script reported on the storefront",
    "reference": "INC-2026-114",
    "approvals": [ { "by": "platform.example:staff/S-02", "sig": "…" }, { "by": "platform.example:staff/S-31", "sig": "…" } ],
    "notify": "now"
  },
  "by": "platform"
}
```

A store MUST refuse an emergency edge that lacks the approvals its platform's published terms require,
names the requester as an approver, carries `admin`, `grant` or an owner power, or outlasts the terms.
