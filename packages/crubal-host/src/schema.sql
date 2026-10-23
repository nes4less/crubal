-- The host's own schema (docs/design/host.md): owners and their keys, identities and API keys. Nothing of
-- an owner's data lives here; that is the store's. Private keys are here only in the reference host's
-- simplest form; a platform keeps them in a key store or a KMS and leaves `private` empty.

create table if not exists host_owners (
  owner text primary key,
  public text not null,
  private text,
  created text not null
);

create table if not exists host_api_keys (
  key_hash text primary key,
  owner text not null,
  caller text not null,
  label text,
  created text not null
);

-- The reference index (docs/design/index-and-forms.md): the current rows per view and audience, applied from
-- the projection stream, and where it is in each stream. Searchable over the row's text slots.
create table if not exists index_rows (
  owner text not null,
  view text not null,
  version text not null,
  audience text not null,
  record text not null,
  row jsonb not null,
  buckets jsonb not null default '{}',
  marks jsonb,
  ancestors text[] not null default '{}',
  sort jsonb not null default '[]',
  pin integer,
  seq bigint not null,
  search tsvector,
  primary key (owner, view, version, audience, record)
);
create index if not exists index_rows_search on index_rows using gin (search);
-- Picks are containments on the buckets document; the first pages of a view in its stored order come off this index.
create index if not exists index_rows_buckets on index_rows using gin (buckets);
create index if not exists index_rows_order on index_rows (owner, view, version, audience, pin, (sort ->> 0), (sort ->> 1), (sort ->> 2), record);
-- The platform index (14.8, 14.10): rows reached by an edge on an ancestor, across owners.
create index if not exists index_rows_ancestors on index_rows using gin (ancestors);
create index if not exists index_rows_record on index_rows (record);

-- The counts, sums and nested counts of a view under its picks at one index head (the filter tally): one pass
-- over the view's rows, kept here so every process answers the same question from the table until the index
-- moves (3.1 s per pass on a 347,000-row view, paid by every function instance and every pick, 2026-10-23).
create table if not exists index_tallies (
  key text primary key,
  owner text not null,
  view text not null,
  version text not null,
  audience text not null,
  seq bigint not null,
  json jsonb not null,
  at timestamptz not null default now()
);
create index if not exists index_tallies_view on index_tallies (owner, view, version, audience, seq);

create table if not exists index_cursors (
  owner text not null,
  view text not null,
  version text not null,
  audience text not null,
  seq bigint not null default 0,
  primary key (owner, view, version, audience)
);

-- Credentials behind a contract's name (docs/design/host.md, "Outbound"). The reference host keeps the
-- material here; a platform keeps it in a vault behind the same interface and leaves `material` empty.
create table if not exists host_credentials (
  owner text not null,
  name text not null,
  scheme text not null,
  material jsonb not null,
  scopes text[] not null default '{}',
  expires text,
  connected text not null,
  primary key (owner, name)
);

create table if not exists host_identities (
  provider text not null,
  subject text not null,
  owner text not null,
  caller text not null,
  primary key (provider, subject)
);

-- Link offers (7.8 `to: link`): one unguessable token per offer; unpublishing revokes, republishing keeps it.
create table if not exists host_offer_links (
  owner text not null,
  contract text not null,
  token text not null,
  revoked boolean not null default false,
  primary key (owner, contract)
);

-- Retired signing keys (11.7): each with the span it signed in, so a rotated key still verifies.
create table if not exists host_keys (
  owner text not null,
  public text not null,
  "from" text,
  until text not null,
  primary key (owner, public)
);

-- A system acting for a hosted person (14.9): what the person allowed, narrowed to items, until when, gated
-- until they lift it. Revoking keeps the row with when. Identity-adjacent, so the host's, like API keys.
create table if not exists host_acting_for (
  id bigint generated always as identity primary key,
  system_owner text not null,
  system text not null,
  person text not null,
  items text[] not null default '{}',
  until text,
  gated boolean not null default true,
  created text not null,
  revoked text
);
create index if not exists host_acting_for_person on host_acting_for (person);

-- Packages an owner publishes from this host (11.5, 11.7): each version's signed bundle and its text, listed in
-- the well-known file and served at /packages/<owner>/<name>/<version>/. A published version never changes.
create table if not exists host_published (
  owner text not null,
  package text not null,
  version text not null,
  hash text not null,
  json jsonb not null,
  text text not null,
  published text not null,
  primary key (owner, package, version)
);

-- When each view with a delay (12.6 fresh: 5m) was last published by the loop.
create table if not exists host_publish (
  owner text not null,
  view text not null,
  at text not null,
  primary key (owner, view)
);
