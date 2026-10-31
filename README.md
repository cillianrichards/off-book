# Off Book

An open-source chess app in which every game starts from a pre-played position, and ratings are adjusted for the Stockfish evaluation of that position.

## Layout

| Path | What it is |
| --- | --- |
| `packages/rules` | Shared chess rules (chess.js), used identically by client and server |
| `apps/server` | Live server: one Node.js process |
| `apps/client` | Progressive web app |
| `pipeline/` | Offline Python pipeline that builds the position pool and rating calibration |
| `tools/licence-check` | CI's licence check: every package against an allowlist, every direct dependency against `THIRD_PARTY_LICENCES.md` |

The design is in `Off Book — Software Architecture.md` and the work plan in `Off Book — Build Backlog.md`.

## Development

TypeScript workspace: Node.js 24 and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm lint            # oxlint, with type-aware rules
pnpm check-format    # oxfmt; `pnpm format` rewrites
pnpm typecheck
pnpm test            # Node's built-in test runner
```

Pipeline: Python 3.13 and uv.

```sh
cd pipeline
uv sync
uv run ruff check
uv run ruff format --check
uv run mypy
uv run pytest
```

The pool is analysed with Stockfish 19 (P1-01). Any build of it will do, downloaded or compiled yourself: the pipeline checks the engine's bench signature, not the file, and refuses to run on anything else. Check a build by hand with `uv run python -m off_book_pipeline.engine PATH_TO_STOCKFISH`. Set `OFF_BOOK_STOCKFISH` to the same path and `pytest` runs its engine test against the real build as well as a fake; CI builds Stockfish 19 from source for this.

Generate the candidate positions (P1-02) with `uv run python -m off_book_pipeline.generate OUTPUT [--ply N]`: one canonical FEN per line, sorted, at four plies by default (72,074 positions, about ten seconds). The output is generated data, so keep it out of git.

Local database: Docker with Compose. PostgreSQL 18 runs in a container, bound to localhost, and dbmate applies the migrations in `db/migrations`.

```sh
cp .env.example .env     # DATABASE_URL for the local database
pnpm db:up               # start it and apply every migration
pnpm db:check            # migrations applied, tables present, versions immutable (needs bash: Git Bash on Windows)
pnpm db:reset            # wipe it and start again, empty and migrated
docker compose down      # stop it, keeping its data
```

The schema changes only through migrations. Add one with `docker compose run --rm migrate new <name>`; it lands in `db/migrations`. Migrations are forward-only: never edit or roll back one that has been pushed; fix a mistake with a new migration.

Every local database is disposable: published pools and calibrations are files loaded into it, never kept only there.

Licences, from the repository root once both of the above are installed:

```sh
pnpm check-licences
```

CI (`.github/workflows/ci.yml`) runs all of these on every push to `main`.

## Licence

Copyright © 2026 the Off Book authors.

Off Book is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See `LICENSE`.

Third-party components and their licences are listed in `THIRD_PARTY_LICENCES.md`.
