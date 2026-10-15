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

create table if not exists host_identities (
  provider text not null,
  subject text not null,
  owner text not null,
  caller text not null,
  primary key (provider, subject)
);
