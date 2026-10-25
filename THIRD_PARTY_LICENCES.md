# Third-party licences

Off Book is licensed under the GNU Affero General Public License, version 3 or (at your option) any later version (`AGPL-3.0-or-later`); see `LICENSE`.

This file is the register of every third-party component: what it is, its licence, why that licence is compatible, and what it obliges us to do. Any new dependency is added here in the same commit that adds it. Licences were checked against the upstream licence file and package metadata on 25 October 2026.

## Why the licences combine

- **GPL-3.0 components.** Section 13 of both the AGPL-3.0 and the GPL-3.0 expressly permits combining works under the two licences. Each part keeps its own licence; the AGPL's network-use clause applies to Off Book's own code. A "GPL-3.0-or-later" or "GPL-2.0-or-later" component can always be used under version 3.
- **Permissive components** (BSD, MIT, Apache-2.0) may be included in an AGPL work. Their obligations are about keeping notices.

## Runtime components

| Component | Used in | Version checked | Licence | Compatible | Obligations |
| --- | --- | --- | --- | --- | --- |
| [chess.js](https://github.com/jhlywa/chess.js) | `packages/rules`, so client and server | 1.4.0 | BSD-2-Clause | Yes | Keep the copyright notice in source. The client bundle is a binary redistribution, so the notice must also ship with it (see below). |
| [chessground](https://github.com/lichess-org/chessground), npm `@lichess-org/chessground` | `apps/client` (board) | 10.5.0 | GPL-3.0-or-later | Yes, via section 13 | Conveyed to browsers in the client bundle; our corresponding source is published under the AGPL. Use the scoped package: the unscoped `chessground` package on npm is marked as no longer supported. |
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

| Tool | Version | Licence |
| --- | --- | --- |
| TypeScript | 6.0.3 | Apache-2.0 |
| pnpm | 12.15.0 | MIT |
| uv and its `uv_build` backend | uv ≥ 0.11 | MIT OR Apache-2.0 |
