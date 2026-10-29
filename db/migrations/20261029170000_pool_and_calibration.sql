-- migrate:up

-- P0-04: the only tables Phases 1 and 2 need.
--
-- A pool or calibration version's record is a published file (a GitHub release asset for a pool, a file
-- in the repository for a calibration); these tables are loaded from it. Each row keeps the SHA-256 of the
-- file it came from, so a database can always be checked against the record.
--
-- Versions are immutable (CLAUDE.md): rows are inserted once and never updated or deleted, which the
-- triggers at the end enforce. A database is thrown away and reloaded instead.

create table pool_version (
  version integer primary key check (version > 0),
  -- The pinned Stockfish build (P1-01).
  engine_build_hash text not null,
  engine_binary_sha256 text not null check (engine_binary_sha256 ~ '^[0-9a-f]{64}$'),
  engine_network text not null,
  -- Node count, MultiPV, shallow depth and the rest (P1-03); every filter threshold (P1-06).
  search_settings jsonb not null,
  filter_settings jsonb not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null
);

create table position (
  id bigint generated always as identity primary key,
  pool_version integer not null references pool_version,
  -- Canonical FEN (P1-02): transpositions are one position within a pool.
  fen text not null,
  ply smallint not null check (ply >= 0),
  -- Centipawns from White's point of view, as Lichess reports evals. Mate scores never reach a published
  -- pool (P1-06), so both evals are always numbers.
  eval_cp integer not null,
  shallow_eval_cp integer not null,
  -- Best move against second best, in centipawns; null when there is only one legal move.
  best_move_gap_cp integer check (best_move_gap_cp >= 0),
  rarity_score double precision not null,
  unique (pool_version, fen)
);

create index position_pool_version_eval on position (pool_version, abs(eval_cp));

create table calibration_version (
  version integer primary key check (version > 0),
  -- Rating points per pawn of eval: 64 in v1. Per-tier constants arrive in a later migration (P6-03).
  points_per_pawn numeric not null check (points_per_pawn > 0),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  published_at timestamptz not null
);

create function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is immutable: % is not allowed; publish a new version instead', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger pool_version_immutable before update or delete on pool_version
  for each row execute function forbid_change();
create trigger pool_version_no_truncate before truncate on pool_version
  for each statement execute function forbid_change();
create trigger position_immutable before update or delete on position
  for each row execute function forbid_change();
create trigger position_no_truncate before truncate on position
  for each statement execute function forbid_change();
create trigger calibration_version_immutable before update or delete on calibration_version
  for each row execute function forbid_change();
create trigger calibration_version_no_truncate before truncate on calibration_version
  for each statement execute function forbid_change();

-- migrate:down

-- Forward-only (P0-04): a mistake is fixed by a new migration, so rolling back always fails.
do $$ begin raise exception 'migrations are forward-only; write a new migration instead'; end $$;
