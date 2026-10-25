# Off Book

An open-source chess app in which every game starts from a pre-played position, and ratings are adjusted for the Stockfish evaluation of that position.

## Layout

| Path | What it is |
| --- | --- |
| `packages/rules` | Shared chess rules (chess.js), used identically by client and server |
| `apps/server` | Live server: one Node.js process |
| `apps/client` | Progressive web app |
| `pipeline/` | Offline Python pipeline that builds the position pool and rating calibration |

The design is in `Off Book — Software Architecture.md` and the work plan in `Off Book — Build Backlog.md`.

## Development

TypeScript workspace: Node.js 24 and pnpm (version pinned in `package.json`).

```sh
pnpm install
pnpm typecheck
```

Pipeline: Python 3.13 and uv.

```sh
cd pipeline
uv sync
```

## Licence

Copyright © 2026 the Off Book authors.

Off Book is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See `LICENSE`.

Third-party components and their licences are listed in `THIRD_PARTY_LICENCES.md`.
