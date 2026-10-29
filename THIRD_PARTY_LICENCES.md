# Third-party licences

Off Book is licensed under the GNU Affero General Public License, version 3 or (at your option) any later version (`AGPL-3.0-or-later`); see `LICENSE`.

This file is the register of every third-party component: what it is, its licence, why that licence is compatible, and what it obliges us to do. Any new dependency is added here in the same commit that adds it. Licences were checked against the upstream licence file and package metadata on 25 October 2026.

## How CI checks this register

The licence check (`pnpm check-licences`, run in CI) fails the build when:

- any installed npm or PyPI package, direct or transitive, declares a licence that is not on the allowlist in `tools/licence-check/allowlist.json`, which gives the reason each licence is compatible;
- any direct dependency, meaning one declared in a `package.json` or in `pipeline/pyproject.toml`, is not named in a table row below as `` `name` (npm) `` or `` `name` (PyPI) ``.

Transitive packages are held to the allowlist but not listed here, because this file is written by hand; the notices shipped with the client are generated from the bundle (X-07). A package whose metadata declares no usable licence needs an override in the allowlist, pinned to its version, after its licence has been checked by hand. If only one platform installs the package, the override names that platform (as Node's `process.platform` does), so the check elsewhere does not report it as unused: pytest, for instance, pulls in colorama only on Windows.

## Why the licences combine

- **GPL-3.0 components.** Section 13 of both the AGPL-3.0 and the GPL-3.0 expressly permits combining works under the two licences. Each part keeps its own licence; the AGPL's network-use clause applies to Off Book's own code. A "GPL-3.0-or-later" or "GPL-2.0-or-later" component can always be used under version 3.
- **Permissive components** (BSD, MIT, Apache-2.0) may be included in an AGPL work. Their obligations are about keeping notices.

## Runtime components

| Component | Used in | Version checked | Licence | Compatible | Obligations |
| --- | --- | --- | --- | --- | --- |
| [chess.js](https://github.com/jhlywa/chess.js), `chess.js` (npm) | `packages/rules`, so client and server | 1.4.0 | BSD-2-Clause | Yes | Keep the copyright notice in source. The client bundle is a binary redistribution, so the notice must also ship with it (see below). |
| [chessground](https://github.com/lichess-org/chessground), `@lichess-org/chessground` (npm) | `apps/client` (board) | 10.5.0 | GPL-3.0-or-later | Yes, via section 13 | Conveyed to browsers in the client bundle; our corresponding source is published under the AGPL. Use the scoped package: the unscoped `chessground` package on npm is marked as no longer supported. |
| [Stockfish](https://github.com/official-stockfish/Stockfish), native CLI | `pipeline/` (pool analysis) | `master` at `ff3a6c5`; the exact build is pinned in P1-01 | GPL-3.0-or-later | Yes | None while the binary is only run, not distributed. It runs as a separate program over UCI and is not linked into our code. Its evaluations are data we publish in the pool, not a copy of Stockfish. Binaries and network files stay out of git. |
| Stockfish compiled to WebAssembly | `apps/client` (analysis board, P3-26) | Candidates: `@lichess-org/stockfish-web` 0.5.0, `stockfish` 19.0.1 | GPL-3.0 family (see note) | Yes, either candidate | Sent to the player's browser, so it is conveyed. GPL-3.0 section 6(d) allows the corresponding source to sit on another server, but we stay responsible for it being available, so mirror or pin the exact upstream source of the build we ship, and link to it beside the engine. Keep Stockfish's licence and acknowledgements with the build: its networks are trained on Leela Chess Zero data released under the Open Database License. |

Note on the WebAssembly candidates: `stockfish` (nmrugg/stockfish.js) declares `GPL-3.0`. `@lichess-org/stockfish-web` declares `AGPL-3.0-or-later` in `package.json` but ships the GPL-3.0 text as its `LICENSE` file. Either reading is compatible; record which applies when P3-26 picks a build.

## Obligations later backlog items must meet

- **Shipped notices.** The client bundle must carry the licence notices of what it bundles. chess.js's BSD-2-Clause requires it outright.
- **Engine source offer.** The analysis board's Stockfish build needs a link to its exact source.
- **Network source offer.** Already covered by X-07: the running app links to its exact source.

## Not yet chosen

Recorded here when the backlog item that needs them makes the choice.

- **Piece set and board theme** (P3-21). chessground ships the cburnett piece set, which [Lichess records](https://github.com/lichess-org/lila/blob/master/COPYING.md) as GPL-2.0-or-later by Colin M.L. Burnett, so it is compatible. Some other Lichess piece sets are non-free; check each before adopting it.
- **Move sounds** (P3-21).
- **Lichess open database** (P1-04), the source of rarity counts and calibration data. Confirm its licence when ingestion starts.

## Development tools

Used to build and check the code; not distributed with the app.

| Tool | Package | Version | Licence |
| --- | --- | --- | --- |
| PostgreSQL, the local stack's database | Docker image `postgres`, pinned by digest in `compose.yaml` | 18 | PostgreSQL Licence (permissive). The image is pulled and run, not redistributed; its Debian base packages carry their own licences |
| TypeScript | `typescript` (npm) | 6.0.3 | Apache-2.0 |
| Node.js type definitions | `@types/node` (npm) | 24.19.2 | MIT |
| oxlint, the linter Lichess uses | `oxlint` (npm) | 1.89.0 | MIT |
| oxlint's type-aware rules | `oxlint-tsgolint` (npm) | 7.0.2005 | MIT |
| oxfmt, the formatter Lichess uses | `oxfmt` (npm) | 0.74.0 | MIT |
| pnpm | Installed separately, pinned by `packageManager` | 12.15.0 | MIT |
| uv | Installed separately | ≥ 0.11 | MIT OR Apache-2.0 |
| uv's build backend | `uv_build` (PyPI) | ≥ 0.11 | MIT OR Apache-2.0 |
| Ruff, the pipeline's linter and formatter | `ruff` (PyPI) | 0.17.2 | MIT |
| mypy, the pipeline's type checker | `mypy` (PyPI) | 2.4.0 | MIT |
| pytest, the pipeline's test runner | `pytest` (PyPI) | 9.1.1 | MIT |
