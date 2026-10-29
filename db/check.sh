#!/usr/bin/env bash
# Checks the local database (P0-04): `pnpm db:check`, after `pnpm db:up` or `pnpm db:reset`.
#
# - every migration is applied, and rolling back is refused (migrations are forward-only);
# - the pool and calibration tables exist and are empty;
# - their rows can be inserted but never updated, deleted or truncated.
#
# Nothing it does persists: every write is rolled back. It reaches the database through Docker Compose,
# so it needs nothing installed beyond Docker. To run it against another PostgreSQL, set PSQL and DBMATE
# to commands that take the usual psql and dbmate arguments.

set -euo pipefail
cd "$(dirname "$0")/.."

sql() {
  if [[ -n "${PSQL:-}" ]]; then
    $PSQL -X -q -v ON_ERROR_STOP=1 --tuples-only --no-align "$@"
  else
    docker compose exec -T db psql -U off_book -d off_book -X -q -v ON_ERROR_STOP=1 --tuples-only --no-align "$@"
  fi
}

dbmate() {
  if [[ -n "${DBMATE:-}" ]]; then $DBMATE "$@"; else docker compose run --rm --quiet-pull migrate "$@"; fi
}

failures=0
pass() { echo "ok      $1"; }
fail() {
  echo "FAILED  $1"
  failures=$((failures + 1))
}

# One row in each table, inside the caller's transaction.
fixtures="
insert into pool_version values
  (1, 'build', repeat('a', 64), 'nn-test.nnue', '{}', '{}', repeat('b', 64), now());
insert into position (pool_version, fen, ply, eval_cp, shallow_eval_cp, best_move_gap_cp, rarity_score)
  values (1, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 1, 30, 25, 10, 0.5);
insert into calibration_version values (1, 64, repeat('c', 64), now());
"

if dbmate status --exit-code >/dev/null; then
  pass 'every migration is applied'
else
  fail 'every migration is applied (run `pnpm db:up`)'
fi

for table in pool_version position calibration_version; do
  count=$(sql -c "select count(*) from $table" 2>/dev/null || echo missing)
  if [[ "$count" == 0 ]]; then pass "$table exists and is empty"; else fail "$table exists and is empty (got: $count)"; fi
done

if sql >/dev/null <<<"begin; $fixtures rollback;"; then
  pass 'rows can be inserted'
else
  fail 'rows can be inserted'
fi

for statement in \
  'update pool_version set engine_network = null' \
  'delete from pool_version' \
  'truncate pool_version cascade' \
  'update position set eval_cp = 0' \
  'delete from position' \
  'truncate position' \
  'update calibration_version set points_per_pawn = 1' \
  'delete from calibration_version' \
  'truncate calibration_version'; do
  if error=$(sql 2>&1 >/dev/null <<<"begin; $fixtures $statement; rollback;"); then
    fail "refused: $statement (it succeeded)"
  elif [[ "$error" == *'is immutable'* ]]; then
    pass "refused: $statement"
  else
    fail "refused: $statement (failed for another reason: $error)"
  fi
done

if dbmate rollback >/dev/null 2>&1; then
  fail 'rollback is refused (it succeeded; run `pnpm db:reset`)'
elif dbmate status --exit-code >/dev/null; then
  pass 'rollback is refused and every migration is still applied'
else
  fail 'rollback is refused and every migration is still applied'
fi

if ((failures > 0)); then
  echo "$failures check(s) failed."
  exit 1
fi
echo 'Local database is at the latest migration, empty, and immutable where it should be.'
