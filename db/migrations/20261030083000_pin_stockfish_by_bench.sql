-- migrate:up

-- P1-01: Stockfish is pinned by its bench signature, not by its binary's checksum (decided 30 October 2026).
-- Any build of the pinned release that reproduces the signature is accepted, on any platform, so a checksum
-- could differ between machines analysing the same pool and identifies nothing worth keeping.
--
-- Altering the table is not an update to a version: `pool_version` is still empty, and the triggers that
-- keep its rows immutable are untouched.

alter table pool_version drop column engine_binary_sha256;

-- Nodes searched by `stockfish bench` with its default arguments: the figure Stockfish's commit messages
-- record as "Bench:" and its CI checks on every platform.
alter table pool_version add column engine_bench bigint not null check (engine_bench > 0);

-- migrate:down

-- Forward-only (P0-04): a mistake is fixed by a new migration, so rolling back always fails.
do $$ begin raise exception 'migrations are forward-only; write a new migration instead'; end $$;
