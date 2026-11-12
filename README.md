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

## Setting up

You need Git, Docker with Compose, Node.js 24, pnpm and uv. Install them for your system, then follow "Then, on every system" below. Python needs no separate install: uv fetches 3.13 itself.

**Windows** (PowerShell; Windows 11 or a recent Windows 10, with `winget`)

```powershell
winget install -e --id Git.Git               # Git Bash is needed for `pnpm db:check`
winget install -e --id Docker.DockerDesktop  # use the WSL 2 backend; `wsl --install` first if WSL is absent
winget install Schniz.fnm                    # Node version manager
winget install --id=astral-sh.uv -e
```

Then make fnm switch Node by itself. Windows PowerShell refuses to load a profile under its default execution policy, so allow local scripts first, then create your profile if it does not exist, add fnm's setup line to it, and open a new PowerShell window. Without that line, `fnm use` fails with "We can't find the necessary environment variables".

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
if (-not (Test-Path $profile)) { New-Item $profile -Force }
Add-Content $profile 'fnm env --use-on-cd | Out-String | Invoke-Expression'
```

pnpm needs Node, so on Windows it is installed in the steps below, once fnm has provided Node.

**macOS**

```sh
brew install fnm uv
brew install --cask docker                   # Docker Desktop
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

**Linux**

```sh
curl -fsSL https://fnm.vercel.app/install | bash
curl -LsSf https://astral.sh/uv/install.sh | sh
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

Install Docker Engine with the Compose plugin from Docker's documentation for your distribution.

On macOS and Linux, add `eval "$(fnm env --use-on-cd)"` to `~/.zshrc` or `~/.bashrc`, then open a new terminal.

**Then, on every system**

```sh
git clone https://github.com/cillianrichards/off-book.git
cd off-book
fnm install          # reads the version from .nvmrc
fnm use
npm install -g pnpm  # Windows only; macOS and Linux installed pnpm above
pnpm install
```

`package.json` pins the pnpm version, and pnpm fetches that version itself, so any recent pnpm will do to start. `engineStrict` makes `pnpm install` stop with `ERR_PNPM_UNSUPPORTED_ENGINE` if Node is not 24 or later: run `fnm use` and try again. The checks are under "Development" below and need nothing more, except the database ones, which need Docker running.

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

Find candidate positions (P1-02) with `uv run python -m off_book_pipeline.collect OUTPUT PGN [PGN ...]`, from PGN files that are plain, gzip, bzip2, xz or zip. Only games in which both players are rated 2200 or more count (`--min-rating 0` counts every game). This reader is for collections that can be downloaded; the masters candidates come from Lichess's API instead (P1-10). It writes one candidate per line (FEN, earliest ply, games and share of games, tab-separated) and a report beside it saying how many positions each threshold removed. It reads about 800 games a second, so about an hour for 2.5 million games, and meanwhile keeps a cache of about 12 bytes per position counted (about 2 GB for 2.5 million games) in the system's temporary directory unless `--work-dir` says otherwise. The output is generated data, so keep it out of git.

The masters candidates come from Lichess's masters database (P1-10), in two steps. The crawl, run once, is the pipeline's only network code: create a Lichess personal API token (free, no scopes needed, at lichess.org/account/oauth/token), put it in `LICHESS_TOKEN`, and from `pipeline/` run `uv run python -m off_book_pipeline.masters_crawl data/masters.jsonl --crawl-threshold PERCENT`. It looks up one position at a time, waits whenever Lichess asks, and appends each answer's counts to the store, never names or game ids, so stopping it loses nothing: run it again to carry on, or again with a lower threshold to extend it. `--max-lookups` and `--max-minutes` stop it early. Lichess sets the pace: it allows about 26 lookups, then asks for a minute's pause, so the crawl manages about 0.4 lookups a second, or roughly 1,500 an hour, and says each time it waits. To see the cost first, crawl at 1%, then 0.5%, 0.2% and 0.1%: each run reuses the last and reports its lookups and time. Then crawl at 0.05% for the full crawl; that matches the rarity threshold, so it takes no more data than the rule needs. A stricter threshold later means crawling the same store again at that threshold, which adds only what is new. Each run records its threshold and the code's commit in the store; tag the commit that runs the full crawl.

`pipeline/data/` is outside git. The store, candidates and analysis results are kept in the private `cillianrichards/off-book-data` repository; copy any new version there, because losing the store means crawling again. From it, `uv run python -m off_book_pipeline.masters data/masters.jsonl OUTPUT [--rare-below PERCENT]` writes the candidates file offline, for any threshold at or above the crawl's, as often as you like.

Analyse the candidates (P1-03) with `uv run python -m off_book_pipeline.analyse CANDIDATES OUTPUT --engine PATH_TO_STOCKFISH` (or set `OFF_BOOK_STOCKFISH`). It checks the engine first, runs one Stockfish per CPU core unless `--workers` says otherwise, and appends each result to OUTPUT as JSON Lines. If it stops for any reason, run the same command again to carry on. At the default 100,000 and 10,000 nodes it takes about a quarter of a second per position per core. `--nodes` and `--shallow-nodes` change the search, but only for a new OUTPUT.

Local database: Docker with Compose. PostgreSQL 18 runs in a container, bound to localhost, and dbmate applies the migrations in `db/migrations`.

```sh
cp .env.example .env     # DATABASE_URL for the local database
pnpm db:up               # start it and apply every migration
pnpm db:check            # migrations applied, tables present, versions immutable (needs bash: Git Bash on Windows)
pnpm db:reset            # wipe it and start again, empty and migrated
docker compose down      # stop it, keeping its data
```

The live server saves games in this database. Start it with `pnpm --filter @off-book/server start` once `DATABASE_URL` is set (the same as in `.env`; Node does not read `.env` itself); it reloads any game left in play, and Ctrl+C stops it cleanly, saving every game first. Nobody can sign in to play until P2-02.

The server's PostgreSQL tests (the game store, and restarting the server process mid-game, P2-08 and P2-12) run against this database, touching only rows they create; `pnpm test` skips them unless the variable is set:

```sh
OFF_BOOK_TEST_DATABASE_URL=postgres://off_book:off_book@127.0.0.1:5432/off_book pnpm --filter @off-book/server test:postgres
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
