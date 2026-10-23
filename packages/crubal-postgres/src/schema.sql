-- The persistent store's schema (docs/design/store.md). Every table is keyed by owner: a domain, or a
-- hosted person's domain:ID. The log is the truth; every other table is a cache that `rebuild` gives back
-- from the log alone. JSON columns hold the spec's JSON form unchanged. `ord` keeps insertion order, so a
-- state read back lists things in the order the log made them, as the memory store does.

create table if not exists schema_version (version text primary key, applied_at timestamptz not null default now());

create table if not exists chains (
  owner text not null,
  chain text not null,
  head_seq bigint not null default 0,
  head_hash text,
  primary key (owner, chain)
);

-- Append-only. The one update allowed is redaction (8.5.2); the trigger below refuses every other one.
create table if not exists log (
  owner text not null,
  chain text not null,
  seq bigint not null,
  log_id text not null,
  prev text,
  hash text not null,
  at text,
  witnessed boolean not null default false,
  entry jsonb not null,
  primary key (owner, chain, seq),
  unique (owner, log_id)
);

create table if not exists records (
  owner text not null,
  id text not null,
  ord bigint generated always as identity,
  kind text not null,
  level text not null,
  "of" text,
  within text,
  ancestors text[] not null default '{}',
  status jsonb,
  applied jsonb,
  wears text[] not null default '{}',
  created text,
  updated text,
  doc jsonb not null,
  primary key (owner, id)
);
create index if not exists records_level on records (owner, level);
-- A level's or a kind's rows in log order with a limit, served from the index alone (the probe: a seq scan over a million rows otherwise).
create index if not exists records_level_ord on records (owner, level, ord);
create index if not exists records_kind_ord on records (owner, kind, ord);
create index if not exists records_of on records (owner, "of");
create index if not exists records_within on records (owner, within);
create index if not exists records_ancestors on records using gin (ancestors);
create index if not exists records_values on records using gin ((doc -> 'values'));
create index if not exists records_kind on records (owner, kind);
create index if not exists records_wears on records using gin (wears);
-- The few records holding a suggestion or a held value, for the review queue: without it the question was a
-- sequential scan of the catalog on every signed-in page (a million rows, 1.3 s, Media Encyclopedia 2026-10-22).
create index if not exists records_awaiting on records (owner, ord) where (doc ? 'suggestions' or doc ? 'held');
-- The notifications not yet emailed, for the delivery pass: the kind as a whole grows for ever.
create index if not exists records_undelivered on records (owner, ord) where kind = 'notification' and not (doc -> 'values' ? 'emailedAt');

create table if not exists definitions (
  owner text not null,
  key text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, key)
);

create table if not exists installed (
  owner text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, ord)
);

-- The bundle of every installed version, whole: the install write names it by hash, and definitions are
-- rebuilt from it (docs/design/publishing.md).
create table if not exists bundles (
  owner text not null,
  package text not null,
  version text not null,
  hash text not null,
  json jsonb not null,
  primary key (owner, package, version)
);

create table if not exists edges (
  owner text not null,
  edge text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, edge)
);

create table if not exists bindings (
  owner text not null,
  key text not null,
  ord bigint generated always as identity,
  record text not null,
  primary key (owner, key)
);

create table if not exists instructions (
  owner text not null,
  issuer text not null,
  n integer not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, issuer, n)
);

create table if not exists review (
  owner text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, ord)
);
create index if not exists review_key on review (owner, (json ->> 'key'));

create table if not exists runs (
  owner text not null,
  run text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, run)
);

create table if not exists observations (
  owner text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, ord)
);
create index if not exists observations_on on observations (owner, (json ->> 'on'));
create index if not exists observations_supports on observations (owner, (json ->> 'supports'));

create table if not exists reads (
  owner text not null,
  ord bigint generated always as identity,
  json jsonb not null,
  primary key (owner, ord)
);

-- Kept beside the log, never rebuilt from it (9.1): the bytes as received.
create table if not exists intake (
  owner text not null,
  intake text not null,
  contract text,
  received text,
  "for" text,
  raw bytea,
  sha256 text,
  type text,
  json jsonb not null,
  primary key (owner, intake)
);

-- A send's mapped-out payload, kept beside the log (docs/design/runs.md): the run write holds only its hash,
-- so the payload can be shown, replayed to the adapter on retry, and erased.
create table if not exists outtake (
  owner text not null,
  run text not null,
  contract text not null,
  record text,
  key text not null,
  raw bytea not null,
  sha256 text not null,
  primary key (owner, run)
);

create table if not exists cursors (
  owner text not null,
  contract text not null,
  view text not null,
  version text not null,
  audience text not null,
  seq bigint not null,
  primary key (owner, contract, view, version, audience)
);

create table if not exists schedules (
  owner text not null,
  contract text not null,
  last_tick text,
  primary key (owner, contract)
);

create table if not exists projections (
  owner text not null,
  view text not null,
  version text not null,
  audience text not null,
  record text not null,
  row jsonb,
  buckets jsonb,
  marks jsonb,
  ancestors text[] not null default '{}',
  sort jsonb,
  pin integer,
  seq bigint not null,
  primary key (owner, view, version, audience, record)
);

create table if not exists projection_stream (
  owner text not null,
  view text not null,
  version text not null,
  audience text not null,
  seq bigint not null,
  json jsonb not null,
  primary key (owner, view, version, audience, seq)
);

-- A view published at least once for an audience, and under which version: a view with no rows is
-- otherwise indistinguishable from one never published, and would rebuild whole on every write.
create table if not exists published (
  owner text not null,
  view text not null,
  audience text not null,
  version text not null,
  primary key (owner, view, audience)
);

create table if not exists stale (
  owner text not null,
  view text not null,
  record text not null,
  since bigint not null,
  primary key (owner, view, record)
);

-- The log never changes except by redaction (8.5.2): a write replaced by its hash, or an entry reduced to
-- its hash. Anything else is refused here, whatever the caller.
create or replace function log_only_redaction() returns trigger language plpgsql as $$
declare
  i integer;
  old_writes jsonb := old.entry -> 'writes';
  new_writes jsonb := new.entry -> 'writes';
begin
  if tg_op = 'DELETE' then
    raise exception 'the log is append-only: % cannot be deleted', old.log_id;
  end if;
  if new.owner <> old.owner or new.chain <> old.chain or new.seq <> old.seq or new.log_id <> old.log_id
     or new.hash <> old.hash or coalesce(new.prev, '') <> coalesce(old.prev, '') then
    raise exception 'the log is append-only: only a redaction may change %', old.log_id;
  end if;
  -- A whole entry reduced to its hash.
  if new.entry ? 'redacted' then
    if (new.entry - 'log' - 'prev' - 'chain' - 'sig' - 'redacted') <> '{}'::jsonb then
      raise exception 'a redacted entry keeps only log, prev, chain, sig and redacted: %', old.log_id;
    end if;
    return new;
  end if;
  -- Write by write: every write is unchanged or replaced by {"redacted": "sha256:…"}.
  if (new.entry - 'writes') <> (old.entry - 'writes') or jsonb_array_length(new_writes) <> jsonb_array_length(old_writes) then
    raise exception 'the log is append-only: only a write may be redacted in %', old.log_id;
  end if;
  for i in 0 .. jsonb_array_length(old_writes) - 1 loop
    if (new_writes -> i) <> (old_writes -> i) and not (((new_writes -> i) ? 'redacted') and ((new_writes -> i) - 'redacted') = '{}'::jsonb) then
      raise exception 'the log is append-only: write % of % may only be redacted', i, old.log_id;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists log_only_redaction on log;
create trigger log_only_redaction before update or delete on log for each row execute function log_only_redaction();

insert into schema_version (version) values ('2026-10-15') on conflict do nothing;

-- One order across an owner's chain and the chains of the people it hosts (14.1), for a rebuild.
alter table log add column if not exists ord bigint generated always as identity;

-- The platform index reads a caller's edges across owners (14.8, docs/design/host.md).
create index if not exists edges_who on edges ((json->>'who'));
