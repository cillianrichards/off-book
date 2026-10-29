# Off Book — Build Backlog

Oct 25, 2026 · @Cillian

## How to read this backlog

This file is the board; there is no separate tracker. Seven phases, built in order, riskiest first. Phase 1 tests cheaply whether a pool exists at all, the one question that can stop the project. Phase 2 is plain chess, a milestone rather than a product: only the developer plays it, and nothing is built that only standard-position play needs. Phases 3 to 5 add what makes Off Book different, and launch follows Phase 5.

IDs carry their phase, so P3-08 is Phase 3, item 8. Phase 1 keeps its original IDs because the first migration cites them and migrations are never edited, so the items that moved out leave a pointer. X items run alongside Phases 2 to 5, and D items are decisions, cited by the items that need them. Settle D-01, D-02 and the outbox half of D-03 at the start of Phase 2 (P2-00).

&#91;embedded content: build roadmap · 7 phases, 2 gates\]

Phase 1 can stop the project before any interface is built. Cross-cutting work runs alongside Phases 2 to 5 and must finish before launch.

## Phase 0 — Foundations

Done when every push to `main` is checked in GitHub Actions on Linux and Windows, and one command on a freshly set-up machine gives a PostgreSQL at the latest migration. Azure hosting waits until Phase 2, because nothing before then runs live.

- [x] **P0-01 Repository and licence.** Monorepo with `packages/rules`, `apps/server`, `apps/client` and a separate `pipeline/`. AGPL-3.0 licence file, plus a third-party licence list confirming chessground, chess.js and Stockfish are compatible.
- [x] **P0-02 CI.** A GitHub Actions workflow lints, type-checks and tests every push to `main`, with a separate job for the Python pipeline. A licence check fails the build when any installed npm or Python package's licence is not on an AGPL-compatible allowlist, or when a direct dependency is missing from `THIRD_PARTY_LICENCES.md`.
- [x] **P0-03 Local stack.** `docker compose up --wait` starts PostgreSQL 18, bound to localhost, image pinned by digest; `pnpm db:reset` wipes it. `DATABASE_URL` is documented in `.env.example`. No seed data: nothing reads the database before Phase 2 (P2-20). Done when CI starts the stack from nothing with the same compose file and connects.
- [x] **P0-04 Migrations.** dbmate, forward-only: a mistake is fixed by a new migration, never by editing or reversing an old one. `pnpm db:up` runs it through the compose file once the database is healthy; `up --wait` cannot, because it counts a one-shot service as failed. The first migration creates `PoolVersion`, `Position` and `CalibrationVersion`, the tables the pool and calibration need. Done when CI finds the three tables present, empty and at the latest migration, and refusing updates and deletes (`db/check.sh`).
- [ ] **P0-05 Windows CI.** The TypeScript and licence jobs also run on `windows-latest`, since development happens on Windows and Linux-only CI missed CRLF line endings, pnpm's `.cmd` shim and a Windows-only dependency. The stack test stays on Linux, because GitHub's Windows runners cannot run Linux containers.
- [ ] **P0-06 Developer setup.** The README lists prerequisites and install steps for Windows, macOS and Linux: Docker Desktop (with WSL 2 on Windows), Node through fnm, pnpm and uv. `engineStrict` makes `pnpm install` refuse the wrong Node version. Done when a fresh clone on Windows passes every check by following the README alone.

## Phase 1 — Pool feasibility

Exit test: after the eval ceiling and stability filters, every band you intend to offer holds enough positions, split by which colour is better, that memorisation is impractical, before rarity removes any more. The threshold does not exist yet (D-06). Rarity and publishing wait for Phase 3, because they trim and ship a pool rather than decide whether one exists.

- [ ] **P1-01 Pin Stockfish.** Record the build hash, binary checksum and network file; the pipeline refuses to run on any other build. All three go into `PoolVersion`.
- [ ] **P1-02 Generator.** Enumerate legal lines to a configurable ply depth (default 4) and collapse transpositions to one canonical FEN: en passant only when a capture is legal, move counters normalised. Done when line counts match perft at depths 1 to 4 and a known transposition dedupes.
- [ ] **P1-03 Analysis runner.** Fixed node count, MultiPV 3, plus the shallower search; stores eval, shallow eval, best-move gap and mate flags. One thread and a fresh hash per search, parallel across positions, resumable after interruption. Done when re-running a sample gives identical evals.
- **P1-04, P1-05 and P1-08** moved to Phase 3 as P3-01, P3-02 and P3-04.
- [ ] **P1-06 Filters.** Eval ceiling (absolute eval above 3, and every mate score) and stability; best-move gap recorded. Every threshold is configuration stored in the filter settings, and the run reports how many positions each filter removed. Rarity joins these filters in P3-03.
- [ ] **P1-07 Band coverage report.** Positions per band, split by which colour is better. Flags any band where the worse side is almost always the same colour. Rerun after rarity in P3-05.
- [ ] **P1-09 Exit test.** Pass or fail per band against D-06. A failing band is dropped from launch, or the ply depth or a filter changes, before any interface work.

## Phase 2 — Playable chess

Exit test: you play both sides of an unrated 10+0 game from any FEN, through a challenge link, signed in as two of the seed's test users against the local stack. The game survives a server restart, its PGN opens at the right position in Lichess's analysis board, and the same build runs on staging.

Plain chess is a milestone, not a product: only the developer plays it, and nothing here exists only for standard-position play. Every game starts from a FEN, so Phase 3 plugs pool positions in without rework.

**Design first**

- [ ] **P2-00 Fix the architecture doc.** Resolve D-01, D-02 and the outbox half of D-03, and update the document. Blocks the rest of Phase 2.

**Hosting and accounts**

- [ ] **P2-01 Azure environments.** Container Apps, Azure Database for PostgreSQL and Blob Storage for staging and production, defined as code and deployed from GitHub Actions. Secrets in Key Vault.
- [ ] **P2-02 Sign in with Lichess.** OAuth 2 with PKCE against Lichess (D-09). `User` with Off Book's own id, handle and status; `Identity` links a Lichess account id to it. Off Book issues its own session, and the Lichess token is discarded once the account id is read. A development-only sign-in for the seed's test users (P2-20), refused outside the local stack, so one person can play both sides. *Needs D-17.*

**Rules**

- [ ] **P2-03 Shared rules package.** Wraps chess.js: any starting FEN, legal moves, mate, stalemate, threefold repetition, 50-move rule, insufficient material. The same build runs in client and server.
- [ ] **P2-04 Custom-start tests.** Repetition counts from the given FEN, castling and en passant rights come from the FEN, and Black-to-move starts work if the ply depth ever goes odd.

**Game service**

- [ ] **P2-05 Server skeleton.** One Node.js process with HTTP API, WebSocket endpoint, and module boundaries for game, pairing, lobby, rating and fair play.
- [ ] **P2-06 Authoritative moves.** The server validates every proposed move and rejects illegal or out-of-turn ones. Each intent carries its move number, so a resend is harmless.
- [ ] **P2-07 Server clocks.** Timed on server receipt, lag compensation capped per move, flags detected on the server. A flag against insufficient material is a draw.
- [ ] **P2-08 Write-through persistence.** Each move and transition commits to PostgreSQL with the state change. Done when killing the process mid-game resumes every game and credits the lost time to both players.
- [ ] **P2-09 Reconnect.** The client rebuilds from the server's move list, never its own.
- [ ] **P2-10 Abandonment.** The disconnected player's clock runs; after the grace period the opponent may claim a win or a draw.
- [ ] **P2-11 Outbox.** Outbox table and in-process dispatcher emitting `game.started`, `game.finished` and `game.aborted`. Delivery is at-least-once, so every consumer is idempotent.
- [ ] **P2-12 Game record.** On completion, the `Game` row with starting FEN, players, time control, result and termination; PGN to Blob Storage. Later phases add the pool, band, pairing, calibration and match fields.
- [ ] **P2-13 Challenge links.** A private link carrying time control and starting FEN, the standard position by default, so games can be played before any pairing exists (D-04). Decide whether it survives as a feature.

**Client**

- [ ] **P2-14 PWA shell.** React and TypeScript, installable, usable at phone width.
- [ ] **P2-15 Board.** chessground from any FEN, promotion picker, move list, sounds; decide on premoves.
- [ ] **P2-16 Clock display.** Counts down locally and corrects to every server message.
- [ ] **P2-17 Result screen.** Result, termination reason, PGN download, link to analysis.

**PGN and analysis**

- [ ] **P2-18 PGN export.** `SetUp` and `FEN` tags on every game. Done when exports open at the right position in Lichess's analysis board and two desktop tools.
- [ ] **P2-19 Analysis board.** Stockfish WebAssembly in the browser, starting from the game's FEN.

**Development data**

- [ ] **P2-20 Development seed.** One command loads a few test users and a fixture of starting FENs into the local database, so games can be played locally before any pool is published; once P3-04 publishes pool v1, it loads that too. *Needs P0-04, P2-02.*

## Phase 3 — Off Book play

Exit test: every band intended for launch still clears D-06 after rarity, and pool v1 is published. You play both sides of an unrated 10+0 game from a pool position, through a challenge link with band and side, with reveal, redraw and abort, and the pairing survives a server restart.

**Pool v1**

- [ ] **P3-01 Lichess database ingestion.** Streaming parser for the monthly PGN dumps. Counts canonical-FEN frequency by rating band at the starting ply and the later check plies; the months used go into the filter settings. *Needs D-16.*
- [ ] **P3-02 Look-ahead rarity.** Decide which continuations the check a few plies on follows (engine lines or the database's own moves) and how far. Implement it against P3-01's frequency table.
- [ ] **P3-03 Rarity filter.** Rarity at the starting ply and the look-ahead plies, added to P1-06's filters, with its thresholds in the filter settings and its removals in the run's report.
- [ ] **P3-04 Publish pool v1.** The pipeline writes pool v1 as a file plus manifest (engine build, search and filter settings, checksum) and attaches it to a GitHub release, which is its record; an existing version's release is never replaced. A loader verifies the checksum and writes `PoolVersion` and its positions to PostgreSQL in one transaction, refusing a version already present. Done when a reset database is rebuilt from the release alone.
- [ ] **P3-05 Pool exit test.** P1-07's report rerun after rarity, pass or fail per band against D-06. A failing band is dropped from launch, or a filter is relaxed and the pool republished as v2.

**Pairing state machine**

- [ ] **P3-06 Pairing schema.** Players, band, positions drawn, redraw used per player, state and timer deadlines; consecutive aborts on `User`. *Needs D-03.*
- [ ] **P3-07 Transition function.** The twelve transitions as a pure function from state and event to new state and effects. Clients send intents only.
- [ ] **P3-08 Transition tests.** One test per row of the table, plus property tests: every pairing ends Finished or Aborted, never more than three positions, and redraws never add to the abort count.
- [ ] **P3-09 First-move timers.** White's, then Black's, restarted on every redraw; deadlines persisted so a restart resumes them. Expiry counts an abort against the player who did not move.
- [ ] **P3-10 Abort limit.** At three consecutive aborts the abort control is disabled, but an unused redraw still works. Any finished game resets both players' counters.
- [ ] **P3-11 Position draw.** Sample from the band in the current pool version, excluding positions either player has had within the exclusion window. *Needs D-13 for Level colours.*
- [ ] **P3-12 Band challenges.** Challenge links (P2-13) carry band and side and open a pairing, so pool games are playable before the lobby exists (D-04).
- [ ] **P3-13 Pool fields on games.** `Game` records the position, pool version, each player's band and the pairing id.

**Client**

- [ ] **P3-14 Reveal screen.** Position, eval, the player's side, redraw and abort with the allowance left, first-move countdown.

## Phase 4 — Calibration and ratings

Exit test: on Lichess 10+0 games, actual score tracks predicted score in every eval bucket and rating tier closely enough that no tier is an obvious farm. Every rated game shows the offset, calibration version and expected score it was rated with, and rebuilding from `RatingEvent` reproduces the `Rating` table exactly. "Closely enough" needs a number (D-07), and the Lichess data is weaker evidence than it looks (D-08): the decisive check is P6-02 on Off Book's own games.

**Calibration v1**

- [ ] **P4-01 Offset function.** Centipawns to rating points (about 0.64 × centipawns), signed by side, then to Glicko-2's internal scale (÷ 173.7178). Unit tests: +1.00 gives about 64 points and 59%; −1.40 gives about 90 points and 37%.
- [ ] **P4-02 Clamp.** Offset capped at the eval ceiling of 3 pawns, about 192 points.
- [ ] **P4-03 Validation dataset.** Lichess 10+0 rated games with both ratings, the result, and the comparison position re-evaluated with the pinned engine settings. The dumps' `%eval` comments come from other engine versions and depths, so are not reused. *Needs P1-01, P1-03, P3-01, D-08.*
- [ ] **P4-04 Calibration report.** Actual against predicted score by eval bucket and rating tier, with sample sizes and confidence intervals. Built to be rerun: the monthly check (P6-02) is the same table on Off Book's own games.
- [ ] **P4-05 Publish calibration v1.** One constant, 64 points per pawn, as calibration v1: a file committed to the repository (`calibration/v1.json`), which is its record and is never edited, loaded into `CalibrationVersion` the same way as a pool. Each game pins the version current when it starts. Done when a reset database is rebuilt from the file alone.
- [ ] **P4-06 Calibration exit decision.** Pass, or launch with per-tier constants as v1.

**Ratings**

- [ ] **P4-07 Glicko-2 core.** Pure function of prior ratings, result, offset and calibration version, with no I/O. Tested against Glickman's published worked example. *Needs D-10, D-11.*
- [ ] **P4-08 Offset in the expected score.** P4-01's offset, clamped by P4-02, enters only the expected-score term.
- [ ] **P4-09 New-player defaults.** Initial rating, deviation and volatility, and the system constant τ.
- [ ] **P4-10 Rating events.** Append-only `RatingEvent`, unique on game and player, so a redelivered event cannot rate a game twice.
- [ ] **P4-11 Rating projection.** `Rating` rebuilt from events, with a command that rebuilds and compares against the live table.
- [ ] **P4-12 Rating consumer.** Consumes `game.finished` with the calibration version pinned on the game; ignores `game.aborted`.
- [ ] **P4-13 Separate pools.** Ratings keyed by player and time control; nothing imported from other sites.
- [ ] **P4-14 High-deviation restriction.** Players above a deviation threshold can only take the bands nearest Level, enforced in pairing.
- [ ] **P4-15 Rating explanation.** On the reveal screen and game page: side, eval, points and expected score. It must show the number Glicko-2 actually used (D-11).
- [ ] **P4-16 History and breakdown.** Rating chart over time; per game, rating and deviation before and after, offset and calibration version.
- [ ] **P4-17 Void and replay.** Voids a game and re-folds the affected events, each with its own pinned calibration. *Needs D-12.*

## Phase 5 — Lobby and integrity basics

Exit test: players find games through the lobby alone, and a collusion case can be flagged, reviewed and voided end to end. Launch sits after this phase, since Phase 6 holds what the architecture defers until after launch.

**Lobby**

- [ ] **P5-01 Seeks.** Post, cancel and expire seeks carrying time control, band, side and an inert opponent range.
- [ ] **P5-02 Live lobby.** What is actually available, by band and side, pushed over WebSocket.
- [ ] **P5-03 Matching.** Worse side pairs with better side in the same band, Level with Level; exact matches first.
- [ ] **P5-04 Widening.** After the wait, pair with any waiting seek: the requested band if compatible, otherwise Level. Respects P4-14.
- [ ] **P5-05 Opponent range, switched off.** Built and tested behind a flag.
- [ ] **P5-06 Pair throttling.** Rate-limit repeat pairings between the same two accounts.
- [ ] **P5-07 Back to the lobby.** After an abort or a finish. Whether the seek re-posts itself depends on D-15.
- [ ] **P5-08 Mini-match field.** `match_id` on `Game`, with no interface.

**Integrity**

- [ ] **P5-09 Flags and review queue.** `Flag` on a player, pair or game, with a status workflow and an admin screen to review evidence and decide.
- [ ] **P5-10 Collusion signals.** Repeat pairings; the better side resigning, flagging or blundering early; account age; device signals. *Needs X-05 for device signals.*
- [ ] **P5-11 Void action.** From the review screen, runs P4-17 and records who voided what and why.
- [ ] **P5-12 Abort-shopping report.** Abort and redraw patterns per player, set against the positions they declined.
- [ ] **P5-13 Fair-play policy.** Public page: what is checked, what happens, how to appeal.

## Phase 6 — Scale and refine

These follow launch, in whatever order liquidity and the monthly calibration check dictate. P6-08 arguably belongs before launch (D-14).

- [ ] **P6-01 Engine-assistance analysis.** Asynchronous job over stored PGNs comparing accuracy with rating, raising flags. Runs outside the live process.
- [ ] **P6-02 Monthly calibration check.** P4-04's report on Off Book's own games, with an alert when a gap persists.
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

These run alongside Phases 2 to 5 and must be done before launch.

- [ ] **X-01 Observability.** Structured logs; metrics for active games, move latency, WebSocket connections and outbox lag; alerts that reach you.
- [ ] **X-02 Backups.** PostgreSQL point-in-time restore, proven by actually restoring; soft delete on Blob Storage.
- [ ] **X-03 Load test.** Simulated players against one process, to find its ceiling in concurrent games.
- [ ] **X-04 Rate limits.** API and WebSocket message limits per connection and per account.
- [ ] **X-05 Privacy.** UK GDPR privacy notice, lawful basis for device signals, data export and account deletion. Deletion anonymises the user but keeps games and rating events, because opponents' histories depend on them.
- [ ] **X-06 Terms and cookies.** Terms of service and cookie consent.
- [ ] **X-07 Licence compliance.** The deployed app links to the exact source commit it is running, as the AGPL requires for network users. It serves a third-party notices page generated from the shipped client bundle, not kept by hand; chess.js's BSD licence requires this. The analysis board links to the exact source of the Stockfish build it serves, with Stockfish's licence and acknowledgements. Done when all three can be followed from production. Due before anyone other than the developer uses a deployed build, which is assumed to be launch.
- [ ] **X-08 Security.** Dependency scanning in CI, secrets out of the repository, session and CSRF protection.
- [ ] **X-09 Accessibility.** Keyboard move entry, and screen-reader announcements of moves and clocks.
- [ ] **X-10 Contributing guide.** Following Lichess, there is no contributor licence agreement: contributors keep their copyright and their work is licensed under AGPL-3.0-or-later when submitted. The guide says so, and covers what a good pull request looks like; setting up and running the checks are in the README (P0-06).

## Decisions and spikes

Settle D-01, D-02 and the outbox half of D-03 at the start of Phase 2 (P2-00); each of the rest is needed by the item that cites it.

**Contradictions in the architecture**

- [ ] **D-01 Live game state.** The game service section keeps it in Redis; the tech stack keeps it in memory with write-through to PostgreSQL, and Redis only for several instances. The second fits one developer.
- [ ] **D-02 When `Game` is written.** The data model says once, at completion; write-through means every move is written during play. Either `Game` is mutable while live, or moves get their own table.
- [ ] **D-03 Missing entities.** The state machine persists pairings and timers on every transition, but the data model has no `Pairing`. The outbox table is missing too. The outbox is settled in P2-00, `Pairing` by P3-06.
- [x] **D-04 Pairing before the lobby.** Decided 29 October 2026: challenge links pair players until the lobby exists, first with a starting FEN (P2-13), then with band and side (P3-12).

**Numbers to set**

- [ ] **D-05 Live parameters.** First-move timer, disconnection grace, seek wait before widening (the doc's open question 1), recent-position exclusion window, pair-throttle limit, lag-compensation cap, high-deviation threshold.
- [ ] **D-06 Pool depth.** Minimum positions per band and colour for the Phase 1 and Phase 3 exit tests.
- [ ] **D-07 Calibration tolerance.** Largest acceptable gap between actual and predicted score, and minimum games per cell.

**Design questions**

- [ ] **D-08 Calibration test data.** In a Lichess game, a +2 position was reached by someone outplaying their opponent, so the advantage is confounded with form beyond rating. Real positions at ply 4 are near level and common, the opposite of the pool. Decide what the test uses and which bias you accept.
- [x] **D-09 Accounts.** Decided 29 October 2026: sign in with Lichess, since most players will have an account there. Off Book keeps its own user ids and sessions, and only `Identity` refers to Lichess, so another sign-in method can be added later without touching games or ratings (P2-02).
- [ ] **D-10 Update timing.** Rate after every game, as Lichess does, or batch into Glicko-2 rating periods.
- [ ] **D-11 Where the offset sits.** Glicko-2 scales the rating difference by the opponent's deviation. If the offset sits inside that scaling, an uncertain opponent shrinks it, and the expected score shown before play is not the one used.
- [ ] **D-12 Void replay scope.** Removing a voided game changes the player's rating before their later games. Do those later opponents keep their ratings, and which pre-game ratings does the re-fold use for them?
- [ ] **D-13 Level band colours.** Level has no choice of side, but someone plays White and someone gets the +0.4. How are colours assigned?
- [ ] **D-14 Concentrating players.** The doc's open question 2. With one time control and no engine opponents, this may be a launch requirement rather than Phase 6.
- [ ] **D-15 Band persistence.** The doc's open question 3: does a chosen band re-post after a return to the lobby?
- [ ] **D-16 Rarity definition.** Which Lichess rating bands and months define "common" for P3-01.
- [ ] **D-17 Contact details.** Whether sign-in also asks Lichess for the player's email address (the `email:read` scope). With it, accounts can be recovered if Lichess sign-in stops working suddenly, at the cost of holding personal data under X-05 and a wider permission prompt. Without it, Off Book holds nothing personal beyond the Lichess account id, but a player who has not linked another sign-in method by then is locked out. Needed by P2-02.
