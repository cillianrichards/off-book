# Off Book — Build Backlog

Oct 25, 2026 · @Cillian

## How to read this backlog

Seven phases, built in order. Phases 1 and 2 test whether an eval can price results by rating band before any interface exists; launch follows Phase 5.

IDs carry their phase, so P3-08 is Phase 3, item 8. X items run alongside Phases 3 to 5, and D items are decisions, cited by the items that need them. Settle D-01 to D-04, four contradictions in the architecture, before Phase 3.

&#91;embedded content: build roadmap · 7 phases, 2 gates\]

Phases 1 and 2 can stop the project before any interface is built. Cross-cutting work runs alongside Phases 3 to 5 and must finish before launch.

## Phase 0 — Foundations

Done when every push to `main` builds and tests in GitHub Actions and a local PostgreSQL holds the pool and calibration tables. Azure hosting waits until Phase 3, because nothing before then runs live.

- [x] **P0-01 Repository and licence.** Monorepo with `packages/rules`, `apps/server`, `apps/client` and a separate `pipeline/`. AGPL-3.0 licence file, plus a third-party licence list confirming chessground, chess.js and Stockfish are compatible.
- [ ] **P0-02 CI.** This backlog file is the board; there is no separate tracker. A GitHub Actions workflow lints, type-checks and tests every push to `main`, with a separate job for the Python pipeline. A licence check fails the build when any npm or Python dependency's licence is not on an AGPL-compatible allowlist or is missing from `THIRD_PARTY_LICENCES.md`.
- [ ] **P0-03 Local stack.** One command starts PostgreSQL locally with seed data.
- [ ] **P0-04 Migrations.** Migration tool chosen and run in CI. The first migration creates `PoolVersion`, `Position` and `CalibrationVersion`, the only tables Phases 1 and 2 need.
- [ ] **P0-05 Fix the architecture doc.** Resolve D-01 to D-04 and update the document. Blocks Phase 3.

## Phase 1 — Pool v1

Exit test: every band you intend to offer holds enough positions, split by which colour is better, that memorisation is impractical. The threshold does not exist yet (D-06).

**Engine and candidates**

- [ ] **P1-01 Pin Stockfish.** Record the build hash, binary checksum and network file; the pipeline refuses to run on any other build. All three go into `PoolVersion`.
- [ ] **P1-02 Generator.** Enumerate legal lines to a configurable ply depth (default 4) and collapse transpositions to one canonical FEN: en passant only when a capture is legal, move counters normalised. Done when line counts match perft at depths 1 to 4 and a known transposition dedupes.
- [ ] **P1-03 Analysis runner.** Fixed node count, MultiPV 3, plus the shallower search; stores eval, shallow eval, best-move gap and mate flags. One thread and a fresh hash per search, parallel across positions, resumable after interruption. Done when re-running a sample gives identical evals.

**Rarity**

- [ ] **P1-04 Lichess database ingestion.** Streaming parser for the monthly PGN dumps. Counts canonical-FEN frequency by rating band at the starting ply and the later check plies; the months used go into the filter settings. *Needs D-16.*
- [ ] **P1-05 Look-ahead rarity.** Decide which continuations the check a few plies on follows (engine lines or the database's own moves) and how far. Implement it against P1-04's frequency table.

**Filter and publish**

- [ ] **P1-06 Filters.** Eval ceiling (absolute eval above 3, and every mate score), stability, rarity at both plies; best-move gap recorded. Every threshold is configuration stored in the filter settings, and the run reports how many positions each filter removed.
- [ ] **P1-07 Band coverage report.** Positions per band, split by which colour is better. Flags any band where the worse side is almost always the same colour.
- [ ] **P1-08 Publish pool v1.** `PoolVersion` and its positions written in one transaction; an existing version can never be overwritten.
- [ ] **P1-09 Exit test.** Pass or fail per band against D-06. A failing band is dropped from launch, or a filter is relaxed and the pool republished as v2.

## Phase 2 — Calibration v1

Exit test: on Lichess 10+0 games, actual score tracks predicted score in every eval bucket and rating tier closely enough that no tier is an obvious farm. "Closely enough" needs a number (D-07), and the test data has a selection problem (D-08).

- [ ] **P2-01 Offset function.** Centipawns to rating points (about 0.64 × centipawns), signed by side, then to Glicko-2's internal scale (÷ 173.7178). Unit tests: +1.00 gives about 64 points and 59%; −1.40 gives about 90 points and 37%.
- [ ] **P2-02 Clamp.** Offset capped at the eval ceiling of 3 pawns, about 192 points.
- [ ] **P2-03 Validation dataset.** Lichess 10+0 rated games with both ratings, the result, and the comparison position re-evaluated with the pinned engine settings. The dumps' `%eval` comments come from other engine versions and depths, so are not reused. *Needs P1-01, P1-03, P1-04, D-08.*
- [ ] **P2-04 Calibration report.** Actual against predicted score by eval bucket and rating tier, with sample sizes and confidence intervals. Built to be rerun: the monthly check (P6-02) is the same table on Off Book's own games.
- [ ] **P2-05 Publish calibration v1.** One constant, 64 points per pawn, as `CalibrationVersion` v1.
- [ ] **P2-06 Exit decision.** Pass, or launch with per-tier constants as v1.

## Phase 3 — Playable core

Exit test: two people play an unrated 10+0 game from a pool position, with reveal, redraw and abort. The game survives a server restart, and its PGN opens at the right position in Lichess's analysis board.

**Hosting and accounts**

- [ ] **P3-01 Azure environments.** Container Apps, Azure Database for PostgreSQL and Blob Storage for staging and production, defined as code and deployed from GitHub Actions. Secrets in Key Vault.
- [ ] **P3-02 Accounts and sign-in.** `User` with handle, status and consecutive aborts. *Needs D-09.*

**Rules**

- [ ] **P3-03 Shared rules package.** Wraps chess.js: any starting FEN, legal moves, mate, stalemate, threefold repetition, 50-move rule, insufficient material. The same build runs in client and server.
- [ ] **P3-04 Custom-start tests.** Repetition counts from the given FEN, castling and en passant rights come from the FEN, and Black-to-move starts work if the ply depth ever goes odd.

**Game service**

- [ ] **P3-05 Server skeleton.** One Node.js process with HTTP API, WebSocket endpoint, and module boundaries for game, pairing, lobby, rating and fair play.
- [ ] **P3-06 Authoritative moves.** The server validates every proposed move and rejects illegal or out-of-turn ones. Each intent carries its move number, so a resend is harmless.
- [ ] **P3-07 Server clocks.** Timed on server receipt, lag compensation capped per move, flags detected on the server. A flag against insufficient material is a draw.
- [ ] **P3-08 Write-through persistence.** Each move and transition commits to PostgreSQL with the state change. Done when killing the process mid-game resumes every game and credits the lost time to both players.
- [ ] **P3-09 Reconnect.** The client rebuilds from the server's move list, never its own.
- [ ] **P3-10 Abandonment.** The disconnected player's clock runs; after the grace period the opponent may claim a win or a draw.
- [ ] **P3-11 Outbox.** Outbox table and in-process dispatcher emitting `game.started`, `game.finished` and `game.aborted`. Delivery is at-least-once, so every consumer is idempotent.
- [ ] **P3-12 Game record.** On completion, the `Game` row with position, pool and calibration versions, bands, result, termination, pairing and match ids; PGN to Blob Storage.

**Pairing state machine**

- [ ] **P3-13 Pairing schema.** Players, band, positions drawn, redraw used per player, state and timer deadlines. *Needs D-03.*
- [ ] **P3-14 Transition function.** The twelve transitions as a pure function from state and event to new state and effects. Clients send intents only.
- [ ] **P3-15 Transition tests.** One test per row of the table, plus property tests: every pairing ends Finished or Aborted, never more than three positions, and redraws never add to the abort count.
- [ ] **P3-16 First-move timers.** White's, then Black's, restarted on every redraw; deadlines persisted so a restart resumes them. Expiry counts an abort against the player who did not move.
- [ ] **P3-17 Abort limit.** At three consecutive aborts the abort control is disabled, but an unused redraw still works. Any finished game resets both players' counters.
- [ ] **P3-18 Challenge links.** A private link with band and side, so Phase 3 is playable before the lobby exists. Decide whether it survives as a feature.
- [ ] **P3-19 Position draw.** Sample from the band in the current pool version, excluding positions either player has had within the exclusion window. *Needs D-13 for Level colours.*

**Client**

- [ ] **P3-20 PWA shell.** React and TypeScript, installable, usable at phone width.
- [ ] **P3-21 Board.** chessground from any FEN, promotion picker, move list, sounds; decide on premoves.
- [ ] **P3-22 Clock display.** Counts down locally and corrects to every server message.
- [ ] **P3-23 Reveal screen.** Position, eval, the player's side, redraw and abort with the allowance left, first-move countdown.
- [ ] **P3-24 Result screen.** Result, termination reason, PGN download, link to analysis.

**PGN and analysis**

- [ ] **P3-25 PGN export.** `SetUp` and `FEN` tags on every game. Done when exports open at the right position in Lichess's analysis board and two desktop tools.
- [ ] **P3-26 Analysis board.** Stockfish WebAssembly in the browser, starting from the game's FEN.

## Phase 4 — Ratings

Exit test: every rated game shows the offset, calibration version and expected score it was rated with, and rebuilding from `RatingEvent` reproduces the `Rating` table exactly.

- [ ] **P4-01 Glicko-2 core.** Pure function of prior ratings, result, offset and calibration version, with no I/O. Tested against Glickman's published worked example. *Needs D-10, D-11.*
- [ ] **P4-02 Offset in the expected score.** P2-01's offset, clamped by P2-02, enters only the expected-score term.
- [ ] **P4-03 New-player defaults.** Initial rating, deviation and volatility, and the system constant τ.
- [ ] **P4-04 Rating events.** Append-only `RatingEvent`, unique on game and player, so a redelivered event cannot rate a game twice.
- [ ] **P4-05 Rating projection.** `Rating` rebuilt from events, with a command that rebuilds and compares against the live table.
- [ ] **P4-06 Rating consumer.** Consumes `game.finished` with the calibration version pinned on the game; ignores `game.aborted`.
- [ ] **P4-07 Separate pools.** Ratings keyed by player and time control; nothing imported from other sites.
- [ ] **P4-08 High-deviation restriction.** Players above a deviation threshold can only take the bands nearest Level, enforced in pairing.
- [ ] **P4-09 Rating explanation.** On the reveal screen and game page: side, eval, points and expected score. It must show the number Glicko-2 actually used (D-11).
- [ ] **P4-10 History and breakdown.** Rating chart over time; per game, rating and deviation before and after, offset and calibration version.
- [ ] **P4-11 Void and replay.** Voids a game and re-folds the affected events, each with its own pinned calibration. *Needs D-12.*

## Phase 5 — Lobby and integrity basics

Exit test: players find games through the lobby alone, and a collusion case can be flagged, reviewed and voided end to end. Launch sits after this phase, since Phase 6 holds what the architecture defers until after launch.

**Lobby**

- [ ] **P5-01 Seeks.** Post, cancel and expire seeks carrying time control, band, side and an inert opponent range.
- [ ] **P5-02 Live lobby.** What is actually available, by band and side, pushed over WebSocket.
- [ ] **P5-03 Matching.** Worse side pairs with better side in the same band, Level with Level; exact matches first.
- [ ] **P5-04 Widening.** After the wait, pair with any waiting seek: the requested band if compatible, otherwise Level. Respects P4-08.
- [ ] **P5-05 Opponent range, switched off.** Built and tested behind a flag.
- [ ] **P5-06 Pair throttling.** Rate-limit repeat pairings between the same two accounts.
- [ ] **P5-07 Back to the lobby.** After an abort or a finish. Whether the seek re-posts itself depends on D-15.
- [ ] **P5-08 Mini-match field.** `match_id` on `Game`, with no interface.

**Integrity**

- [ ] **P5-09 Flags and review queue.** `Flag` on a player, pair or game, with a status workflow and an admin screen to review evidence and decide.
- [ ] **P5-10 Collusion signals.** Repeat pairings; the better side resigning, flagging or blundering early; account age; device signals. *Needs X-05 for device signals.*
- [ ] **P5-11 Void action.** From the review screen, runs P4-11 and records who voided what and why.
- [ ] **P5-12 Abort-shopping report.** Abort and redraw patterns per player, set against the positions they declined.
- [ ] **P5-13 Fair-play policy.** Public page: what is checked, what happens, how to appeal.

## Phase 6 — Scale and refine

These follow launch, in whatever order liquidity and the monthly calibration check dictate. P6-08 arguably belongs before launch (D-14).

- [ ] **P6-01 Engine-assistance analysis.** Asynchronous job over stored PGNs comparing accuracy with rating, raising flags. Runs outside the live process.
- [ ] **P6-02 Monthly calibration check.** P2-04's report on Off Book's own games, with an alert when a gap persists.
- [ ] **P6-03 Calibration vN+1.** Per-tier constants, published for new games only.
- [ ] **P6-04 Position farming.** Actual against predicted results per position; drifting positions are dropped from the next pool version.
- [ ] **P6-05 Pool vN+1.** Re-run the pipeline, after a Stockfish upgrade for instance; old versions stay readable.
- [ ] **P6-06 Opponent rating ranges on.**
- [ ] **P6-07 Quick-pair.**
- [ ] **P6-08 Concentrating players.** Scheduled sessions, arenas, or alerts when someone is seeking. *Needs D-14.*
- [ ] **P6-09 More time controls.**
- [ ] **P6-10 Native wrappers.**
- [ ] **P6-11 Mini-match interface.**
- [ ] **P6-12 Split the process.** Redis and separate services, once X-01 and X-03 show one process is not enough.

## Cross-cutting

These run alongside Phases 3 to 5 and must be done before launch.

- [ ] **X-01 Observability.** Structured logs; metrics for active games, move latency, WebSocket connections and outbox lag; alerts that reach you.
- [ ] **X-02 Backups.** PostgreSQL point-in-time restore, proven by actually restoring; soft delete on Blob Storage.
- [ ] **X-03 Load test.** Simulated players against one process, to find its ceiling in concurrent games.
- [ ] **X-04 Rate limits.** API and WebSocket message limits per connection and per account.
- [ ] **X-05 Privacy.** UK GDPR privacy notice, lawful basis for device signals, data export and account deletion. Deletion anonymises the user but keeps games and rating events, because opponents' histories depend on them.
- [ ] **X-06 Terms and cookies.** Terms of service and cookie consent.
- [ ] **X-07 AGPL compliance.** The running app links to its exact source, as the AGPL requires for network users; contributing guide.
- [ ] **X-08 Security.** Dependency scanning in CI, secrets out of the repository, session and CSRF protection.
- [ ] **X-09 Accessibility.** Keyboard move entry, and screen-reader announcements of moves and clocks.

## Decisions and spikes

Settle D-01 to D-04 before Phase 3; each of the rest is needed by the item that cites it.

**Contradictions in the architecture**

- [ ] **D-01 Live game state.** The game service section keeps it in Redis; the tech stack keeps it in memory with write-through to PostgreSQL, and Redis only for several instances. The second fits one developer.
- [ ] **D-02 When `Game` is written.** The data model says once, at completion; write-through means every move is written during play. Either `Game` is mutable while live, or moves get their own table.
- [ ] **D-03 Missing entities.** The state machine persists pairings and timers on every transition, but the data model has no `Pairing`. The outbox table is missing too.
- [ ] **D-04 Pairing before the lobby.** Phase 3 plays games from the pool, but seeks arrive in Phase 5. Something must pair players in between (P3-18).

**Numbers to set**

- [ ] **D-05 Live parameters.** First-move timer, disconnection grace, seek wait before widening (the doc's open question 1), recent-position exclusion window, pair-throttle limit, lag-compensation cap, high-deviation threshold.
- [ ] **D-06 Pool depth.** Minimum positions per band and colour for the Phase 1 exit test.
- [ ] **D-07 Calibration tolerance.** Largest acceptable gap between actual and predicted score, and minimum games per cell.

**Design questions**

- [ ] **D-08 Calibration test data.** In a Lichess game, a +2 position was reached by someone outplaying their opponent, so the advantage is confounded with form beyond rating. Real positions at ply 4 are near level and common, the opposite of the pool. Decide what the test uses and which bias you accept.
- [ ] **D-09 Accounts.** Own accounts, or sign-in with Lichess.
- [ ] **D-10 Update timing.** Rate after every game, as Lichess does, or batch into Glicko-2 rating periods.
- [ ] **D-11 Where the offset sits.** Glicko-2 scales the rating difference by the opponent's deviation. If the offset sits inside that scaling, an uncertain opponent shrinks it, and the expected score shown before play is not the one used.
- [ ] **D-12 Void replay scope.** Removing a voided game changes the player's rating before their later games. Do those later opponents keep their ratings, and which pre-game ratings does the re-fold use for them?
- [ ] **D-13 Level band colours.** Level has no choice of side, but someone plays White and someone gets the +0.4. How are colours assigned?
- [ ] **D-14 Concentrating players.** The doc's open question 2. With one time control and no engine opponents, this may be a launch requirement rather than Phase 6.
- [ ] **D-15 Band persistence.** The doc's open question 3: does a chosen band re-post after a return to the lobby?
- [ ] **D-16 Rarity definition.** Which Lichess rating bands and months define "common" for P1-04.
