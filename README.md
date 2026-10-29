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

Local database: Docker with Compose. PostgreSQL 18 runs in a container, bound to localhost.

```sh
cp .env.example .env     # DATABASE_URL for the local database
docker compose up --wait # start it, and wait until it accepts connections
pnpm db:reset            # wipe it and start again empty
docker compose down      # stop it, keeping its data
```

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
