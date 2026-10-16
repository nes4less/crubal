# The party package: proposal

**Status:** proposal for the operator, 2026-10-16. Nothing here is published; `std/party` is written once the
decisions at the end are ruled. Spec 11.7 names `crubal.com/party` as the package holding "the `person`,
`organization` and `system` kinds, their base classes, and the caller facets that edges, contracts and the trust
order read (chapter 14)". Every other standard vocabulary leans on it: a caller is a record of one of these
kinds (14.1), `who` conditions read its facets (7.6), audiences and roles sit on it (12.4), and the host writes
one of its records when an account is connected (host.md).

## What is already fixed by the spec and the engine

- **A caller is a record** of kind `person`, `organization` or `system`, looked up by ID in the owner's store
  when a contract runs. `who` reads `caller.<facet>`, `caller wears <Class>` and `caller may <verb> <target>`;
  the last one is read off the caller's `roles`, a many-valued link to the package's `role` declarations
  (corpus exchange/005-who). So `roles` is a party facet, and the roles themselves are the adopter's presets.
- **A hosted person** is the owner `domain:id`: the person record is the host's (owned by the domain, in the
  host's chain), and what the person owns under `ownership:` is in their own chain, signed by the host until
  they publish a key. The host maps a sign-in (provider, subject) to that caller in its own table, not on the
  record (7.6: authentication is the host's).
- **Audiences come from edges, not facets.** `member` is anyone the signup contract admitted, `staff` is anyone
  with a `control` or `admin` edge, `owner` is the owner (14.4). No party facet says "this person is staff".
- **A system is a caller like a person** (14.9). It requests menu items when it registers; an admin grants a
  `control` edge carrying them. The host writes the connection as a `system` record through a party form:
  name, scheme, scopes granted, connected or expired, when (host.md).
- **`trust: person`** is a source rank for a person's write through any form (11.7); it names no facet.

## The three kinds

One level each. Levels exist for values to fold down (`of`, 1.7), and nothing folds between parties: a
department is not a narrower organization the way a unit is a narrower product. Hierarchy among parties is
`within` for access and edges for membership (14.2), which the engine already does.

**person** — someone who signs in and writes through a form. Staff, customers, sellers, community members.
The record carries what every adopter needs to show and address a person, and nothing the host keeps for
authentication.

**organization** — a company, a club, a public body, a label. An owner domain is an organization when it
wants to be a record (so a partner's edge has a `who`, so a publisher is a link and not text); an
organization need not be an owner.

**system** — a utility, a partner's service or an AI agent that writes through a contract. Its record is the
visible side of a connection and carries no secret.

## Draft package

```crubal
// crubal.com/party: who acts. The three caller kinds, what any adopter needs of them, and the facets that
// access reads. Authentication stays in the host; roles and presets stay in the adopter's package.
package: party /2026-10-16
  owner: crubal.com
  label: Parties
  crubal: 2
  licence: CC-BY-4.0
  prefixes:
    schema: https://schema.org/

kind: person
  levels: person
  base: Person
  schema:
    person: schema:Person
kind: organization
  levels: organization
  base: Organization
  schema:
    organization: schema:Organization
kind: system
  levels: system
  base: System
  schema:
    system: schema:SoftwareApplication

// Any party
!name$200 =schema:name
image^ =schema:image
url$ =schema:url
email$ =schema:email
phone$ =schema:telephone
description$ =schema:description
roles&role*
memberOf&organization* =schema:memberOf

// People
givenName$ =schema:givenName
familyName$ =schema:familyName
locale$                                  // BCP 47: en-GB
timezone$                                // IANA: Europe/London
signedUp@ymdhm

// Organizations
legalName$ =schema:legalName
domain$ unique                           // the owner domain when the organization is one
taxId$ =schema:taxID
facet: address
  type: compound
  same-as: schema:address
  facets:
    street$ =schema:streetAddress
    locality$ =schema:addressLocality
    region$ =schema:addressRegion
    postalCode$ =schema:postalCode
    country$ =schema:addressCountry        // ISO 3166-1 alpha-2

// Systems
operator&organization                    // who runs it
systemKind{utility|partner|agent}
scheme{oauth2|apikey|basic|none}
scopes$*                                 // what was granted
requests$*                               // the menu items it asked for (14.9)
connection{connected|expired|revoked}
connectedAt@ymdhm
version$

class: Person
  for: person
  facets:
    !name
    givenName
    familyName
    image
    email
    phone
    locale
    timezone
    roles
    memberOf
    signedUp
class: Organization
  for: organization
  facets:
    !name
    legalName
    domain
    url
    email
    phone
    address
    image
    description
    taxId
class: System
  for: system
  facets:
    !name
    operator
    systemKind
    url
    scheme
    scopes
    requests
    connection
    connectedAt
    version
    roles

// Contact details and tax identity are for the owner's people, never for the public or other members.
rule: emailIsPrivate
  for: everywhere
  strength: must
  then: email shown to staff
rule: phoneIsPrivate
  for: everywhere
  strength: must
  then: phone shown to staff
rule: addressIsPrivate
  for: everywhere
  strength: must
  then: address shown to staff
rule: taxIdIsPrivate
  for: everywhere
  strength: must
  then: taxId shown to staff

// The host writes the connection through this form (host.md). The form is the party package's so every host
// writes the same record; the edge that grants what the system asked for is the adopter's (14.9).
contract: connect
  kind: form
  origin: observed
  needs:
    !name
    scheme
    scopes
    requests
    connection
    connectedAt

// A person keeps their own details. Who may run it is the adopter's edge (consume on their own record).
contract: profile
  kind: form
  origin: declared
  needs:
    !name
    givenName
    familyName
    image
    email
    phone
    locale
    timezone
```

What is deliberately **not** in it:

- No sign-in identities on the record (provider, subject, password hashes, tokens): the host's table maps them
  to the caller, and erasing a person erases both.
- No `Staff`, `Customer` or `Seller` class. Those are relations and edges in the adopter's package
  (`relation: seller`, a `staff` preset), and `who: caller may run unitizer` reads the roles. A class on the
  person would be a second spelling of the same fact that drifts from the first. The ME plan's
  `who: caller wears Staff` becomes `caller may run unitizer`, or a `me:Staff` class if ME wants one.
- No `signup`. It grants the first edge with the adopter's relation (`customer`) on the adopter's root, so it
  is the adopter's form; party gives it the kind to create.
- No preferences, consents or marketing flags: `me:` facets, or a later package, when a second adopter needs
  the same ones.

## How it meets the engine

- The ID forms stay as they are: `person: C-1` in the owner's chain; `test.example:C-1` as an owner; edges
  `who: person:C-1` (or `system:S-2`).
- `roles&role*` is the facet `callerStates` reads today. `memberOf` is informational; it grants nothing (14.10:
  membership is an edge).
- The host's connect flow (host.md) runs `connect` for the owner with `origin: observed`; the system's record
  ID is minted like any other, and the credential stays in the host's store under its name.
- JSON-LD shapes come from the `schema:` lines; a public view of a person shows `name` and `image` and whatever
  else the adopter opens, with the contact rule keeping the rest at staff.
- Erasure (8.5.2): a person's values are all `person`-origin on their own record, so `erase <id>` redacts
  them and the host drops the identity row; their owned chain is erased by them alone (14.1).

## Decisions for the operator

1. **One level per kind.** Recommended as above. The alternative is `organization > unit` style levels for
   departments or branches; I advise against it, `within` already carries that.
2. **Staff, customer, seller as roles and relations, not classes.** Recommended. If you want `caller wears
   Staff` to stay readable in ME's contracts, ME declares `me:Staff` itself; party does not.
3. **Contact facets in party, shown to staff by default.** Recommended, so every adopter gets the same privacy
   rule without writing it. The alternative is party carrying only `name` and `image`, with contact left to
   adopters.
4. **The organization's `address` and `taxId`.** Recommended in, since commerce (invoices, shipping) needs an
   address on a party and would otherwise define its own. `taxId` could wait for commerce instead.
5. **`system` facets as drafted**: the host's five (name, scheme, scopes, connection, connectedAt) plus
   `operator`, `systemKind`, `requests` and `version`. `requests` is what 14.9 says a utility asks for; it is
   on the record so the grant can be compared with the ask.
6. **Two forms in party, `connect` and `profile`; `signup` stays the adopter's.** Recommended.
7. **`roles` on systems too.** Recommended: an AI agent or a utility holding a preset reads the same way as a
   person in `who`. The alternative is edges only for systems.

Say which numbers stand and which change, in prose. Then `std/party` is written, published through the
engine's own checks like the other five, and the ME plan's `party` references point at real facets.
