-- migrate:up

-- P2-12: one row per game, created when it starts and updated while it is live, holding its moves and
-- clocks as lila's game document does (D-02). No PGN file is kept: PGN is built from this row (P2-18).
--
-- The game service holds live games in memory and saves each one as its status changes, and otherwise
-- within 30 seconds of a move (D-01, P2-08), so a row may trail the game it records by up to 30 seconds.
-- Restarting the service reloads every started game from here.

create table game (
  -- Eight letters and digits, as lila's game ids are.
  id text primary key check (id ~ '^[0-9A-Za-z]{8}$'),
  -- Off Book user ids. The `user` table arrives with sign-in (P2-02), which adds the foreign keys.
  white_id text not null,
  black_id text not null check (black_id <> white_id),
  -- Every game starts from a FEN, cleaned by the rules package (P2-03).
  initial_fen text not null,
  -- Lichess's limits for a real-time clock: up to 180 minutes, with up to 180 seconds' increment.
  clock_initial_seconds integer not null check (clock_initial_seconds between 1 and 10800),
  clock_increment_seconds integer not null check (clock_increment_seconds between 0 and 180),
  status text not null check (status in ('started', 'finished', 'aborted')),
  -- The moves in SAN from the starting FEN, and each side's remaining time in centiseconds after each of
  -- its own moves.
  moves text[] not null default '{}',
  white_clock_history integer[] not null default '{}',
  black_clock_history integer[] not null default '{}',
  -- The clock after the last saved move: each side's remaining time in centiseconds, and when the side to
  -- move's clock started running, null before both sides have moved and once the game is over. A running
  -- clock is stored by when it started, as lila stores it, so time keeps passing while the service is down.
  white_remaining_cs integer not null,
  black_remaining_cs integer not null,
  clock_running_since timestamptz,
  result text check (result in ('1-0', '0-1', '1/2-1/2')),
  termination text check (
    termination in (
      'checkmate', 'stalemate', 'insufficientMaterial', 'fiftyMoves', 'fivefoldRepetition',
      'flag', 'abandonment', 'aborted'
    )
  ),
  created_at timestamptz not null,
  last_move_at timestamptz,
  finished_at timestamptz,
  check ((status = 'started') = (termination is null)),
  check ((status = 'started') = (finished_at is null)),
  check ((status = 'finished') = (result is not null)),
  check ((status = 'aborted') = coalesce(termination = 'aborted', false)),
  check (status = 'started' or clock_running_since is null),
  check (cardinality(white_clock_history) + cardinality(black_clock_history) = cardinality(moves))
);

-- The game service loads every started game when it starts (P2-08).
create index game_started on game (created_at) where status = 'started';

-- migrate:down

-- Forward-only (P0-04): a mistake is fixed by a new migration, so rolling back always fails.
do $$ begin raise exception 'migrations are forward-only; write a new migration instead'; end $$;
