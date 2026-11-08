# Off Book — Software Architecture

Oct 25, 2026 · @Cillian

## Summary and assumptions

Off Book splits into a thin real-time play layer and an offline pipeline that produces the two things the product's credibility rests on: the position pool and the rating calibration. Both are immutable and versioned, and every game records which versions it used, so any rating can be recomputed, audited or reversed.

Where the product is still undecided, this design assumes the following. Each is revisited under Open architectural questions.

- Web-first progressive web app; native apps later as thin wrappers.
- Real-time rated games at 10+0 only at launch. Time control is a field on seeks, games and ratings, so more can be added without a schema change.
- Players choose an eval band and whether they take the better or worse side (opponent rating ranges come after launch), see the position and its eval before play, and may abort before the first move.
- Open source, so GPL components are usable and the server is published.
- Until launch, deployed builds are used by the developer alone, so obligations owed to users, such as licence notices and source offers (X-07), fall due at launch.
- One developer. At launch everything live runs as a single Node.js process with PostgreSQL as the only store; the services below are module boundaries inside it, split out only when load demands it.

## System overview

&#91;embedded content: system architecture · online services, data, offline pipeline\]

Matchmaking draws a position from the catalogue and hands the pairing to the game service; when a game ends, the game service saves the result, has the rating service rate it, then announces the finish, which fair play listens for. Everything the rating maths depends on is produced offline and pinned by version.

## Position pipeline

The pool is built offline and published as an immutable version; nothing in live play ever calls Stockfish. An eval is a property of three things together: the position, the engine build and the search settings. Upgrading Stockfish therefore means a new pool version, never an in-place edit.

1. **Collect.** Take a collection of real games, to begin with Lichess's masters database (over-the-board games by players rated 2200 or more, from 1952), read once through its opening explorer API (D-16, P1-10), and find for every position how many games pass through it at any point. A game counts once however often it repeats a position, and a game recorded twice counts once. A position is its placement, side to move, castling rights and en passant square (only when a capture is legal, as FIDE's repetition rule counts it), so move order and move counters do not matter. A position is a candidate when at least 2 games reach it and fewer than 0.05% of them do; both thresholds are filter settings. Counting at any point means a position every game passes through, such as the starting position reached again by 1.Nf3 Nf6 2.Ng1 Ng8, is never rare. A candidate must also be entered straight from a common position (one reached by 0.05% of games or more) by at least one game, at ply 4 or later, so it sits where a line leaves commonly played positions. That is a few moves in for some lines and close to a middlegame for others; there is no upper bound on depth, positions further down a line that has already left common play are not candidates, and a line that leaves common play before ply 4 gives none. Positions with no legal moves are dropped. Positions are counted in each game's first 60 plies, far beyond where lines leave common play, and the run refuses to finish if a common position appears at that limit.
2. **Analyse.** Run a pinned Stockfish build at a fixed node count with MultiPV 3. Store the eval, the eval at a shallower search, and the gap between the best and second-best move. The shallower search is the same search at fewer nodes: 100,000 and 10,000 by default, recorded with the run. Against 1,000,000 nodes, 100,000 moved a sample's evals by 8 centipawns typically and 20 at the 90th percentile, about 5 and 13 rating points, for a tenth of the time. Each search runs on one thread straight after `ucinewgame`, which clears the hash, so a result depends only on the position and the settings. That makes a run reproducible, parallel across positions and resumable after interruption; a resumed run refuses a different engine, search settings or candidates file.
3. **Filter.**
   - Eval ceiling: drop positions beyond an absolute eval of 3, and all mate scores.
   - Stability: drop positions whose eval moves materially between the deep and shallow searches.
   - Sharpness: record the best-move gap so the monthly check can show whether sharp positions are mispriced.
4. **Publish.** Write pool vN as a versioned file: the positions plus a manifest of engine build, search settings, filter settings and checksum. That file, attached to a GitHub release, is the pool's record; it is never replaced, and a release for an existing version is never edited. Loading it into PostgreSQL, local or Azure, is a separate step that checks the checksum and refuses a version already present, so any database can be rebuilt from the published files and none of them is the only copy. Old versions stay readable forever, because finished games reference them.

This is batch numerical work with no latency requirement, so it is written in Python, independently of the live stack.

## Game service

The game service is the sole authority on board state and clocks; clients only propose moves.

- **Connection:** one WebSocket per player, at `/play/:id`, as lila's round socket; a game's public view is also served at `GET /api/games/:id`. Every connection starts with the whole game, and the client rebuilds from the server's move list, never its own. Each move sent carries its ply, so a client that misses one can tell and ask for the game again.
- **Validation:** server-side legality check using the same rules library as the client, shared as one TypeScript package.
- **Rules:** as scalachess, Lichess's rules library. Checkmate, stalemate, insufficient material, the fifty-move rule at 100 half-moves and fivefold repetition end a game automatically, checkmate first, so mate on the hundredth half-move still wins. Threefold repetition only lets a player claim a draw, for the position on the board. A starting FEN passes the checks Lichess applies to a friend challenge from a position (one king a side, no pawn on the first or last rank, the side not to move not in check, the game not already over), and is cleaned as scalachess reads it: a castling right the pieces cannot use, and an en passant square with no legal capture, are dropped. Repetition counts from the starting FEN, which is the first occurrence.
- **Clocks:** as scalachess's Clock and LagTracker. Timed on server receipt; the clock starts once each side has moved. Lag compensation gives back the lag a client reports only up to a quota per player, so a player cannot gain time by faking latency: the quota starts at three moves' worth of gain, grows by the gain each move less what was given back, and never exceeds seven moves' worth; the gain is a second per move from three minutes up, 10+0 included. A move that arrives after its player's time ran out, even with compensation, is not played and loses on time. The server sets its own timer for the side to move's flag, allowing their quota, at most two seconds, as grace for a move on its way.
- **Live state:** held in memory by the one server process, as lila (Lichess's server) holds it; there is no Redis. A game is saved to PostgreSQL as soon as its status changes, which includes every pairing transition and each side's first move, and otherwise within 30 seconds of the first move not yet saved. A clean shutdown saves every game first and gives the side to move 20 seconds and the other side 10. A crash loses at most the last 30 seconds of moves, and lost clock time is not given back. As in lila, a game whose clock runs out within two minutes of the server starting, with its last move made before the start, is aborted rather than lost on time, since its clock ran out while the server was down. Off Book promises nothing stronger than Lichess does here, except that lila restarts its 30-second wait at every move, so a fast game there can go unsaved for longer.
- **Storage:** one `Game` row per game, created when the game starts and updated while it is live. Its moves are an array of SAN and each side's clock history is an array of centiseconds on the same row, as lila keeps them on its game document, but without lila's compression, which is not worth it at Off Book's size. No PGN file is stored: PGN is built from the row when asked for, as lila's export does.
- **Custom start:** every game begins from a FEN, not the standard position. PGN export, the analysis board and any third-party import must use the PGN `SetUp` and `FEN` tags, and this needs testing early because many tools handle it badly.
- **Events:** emits `game.started`, `game.finished` (result, termination reason, move count, clock data, position id) and `game.aborted` within the process, after the change is saved. There is no outbox, as in lila. When a game finishes, the result is saved, then the game is rated, then `game.finished` is announced, so a crash in between can leave a finished game unrated, as it can on Lichess.

## Rating engine

Ratings use Glicko-2 with the starting position's exact eval added to the rating gap: each pawn of disadvantage counts as 64 rating points. The constant comes straight from Lichess's published win-percentage formula ([source](https://www.lichess.org/page/accuracy)), so there is no model to fit:

```latex
\delta = \frac{400}{\ln 10} \times 0.00368208 \times \text{centipawns} \approx 0.64 \times \text{centipawns}
```

Both Lichess's curve and Elo's expected score are logistic, so the conversion is a straight line: +1.00 gives about 59% on Lichess's curve and a 64-point gap gives about 59% under Elo. The offset enters the expected score in place of a rating difference (converted to Glicko-2's internal scale), and the rest of Glicko-2 is unchanged.

The player sees it in plain terms: "Worse side of −1.4, so treated as 90 points weaker. Expected score 37%."

The known weakness is that one curve covers every player, while strong players convert advantages better than weak ones. Left unchecked, the worse side becomes a rating sink at high ratings and a rating farm at low ratings. The monitoring below catches this.

**Design rules**

- **Pure and versioned.** The update is a function of prior ratings, result, position features and calibration vN, with no I/O. It can be unit-tested and replayed.
- **No re-rating on recalibration.** A new calibration applies to new games only. Each game stores the calibration version and offset it was rated with, and the game page shows them with the expected score.
- **Event-sourced for voids only.** A rating is a fold over `RatingEvent` rows, one per player per rated game, each replayed with its own pinned calibration. Voiding a game for collusion is a replay without it; it never re-prices other games.
- **Aborts are invisible to ratings.** An aborted game is never rated.
- **Separate pools** per time control, and never mixed with a player's standard-chess rating elsewhere.
- **Guard rails.** Clamp the offset at the eval ceiling. Players with high rating deviation are limited to the bands nearest level until their rating settles, since a big offset on an uncertain rating is mostly noise.

**Calibration loop**

1. Launch with one constant, 64 points per pawn, as calibration v1. Each calibration version's record is a small file committed to the repository and never edited; like a pool, it is loaded into PostgreSQL rather than kept only there. Before launch, check it against Lichess 10+0 games by eval bucket and rating tier.
2. Each month, compare actual with predicted score in a table by band and rating tier. A persistent gap is a farmable edge.
3. If a tier drifts, give it its own constant and publish calibration vN+1. It applies to new games only and is still one explainable number per tier.

## Matchmaking and position allocation

Players post seeks to a lobby (time control, eval band, opponent rating range) and others accept them; matchmaking then draws the position from that band. The game service never chooses the position or colours.

- **Eval bands** are defined on the size of the eval, and the player picks a side:

| Band | Absolute eval (pawns) | Sides |
| --- | --- | --- |
| Level | \[0, 0.5) | Shared; no choice of side |
| Slight | \[0.5, 1) | Better or worse |
| Clear | \[1, 2) | Better or worse |
| Large | \[2, 3\] | Better or worse |

- **Mirroring:** a seek for the worse side of a band matches a seek for the better side of the same band. Because bands use absolute eval, a position always falls in the same band for both players.
- **Opponent range:** disabled at launch to protect liquidity. When enabled, a seek is visible only to players inside its range.
- **Lobby before queue:** a seek lobby shows what is actually available. A player's band and side are a preference, not a filter: the priority is a game against a human. Pair exact matches first; once a seek has waited, pair it with any other waiting seek, using the requested band when the two are compatible and the Level band when they are not. Reveal, redraw and abort let either player decline the result.
- **Reveal and abort:** once paired, both players see the position and its eval. Either may abort before making their first move; the game is then unrated and recorded as aborted. Each player has one redraw per pairing: their first abort keeps the same opponent and draws a new position from the same band. Any abort after both redraws are used, or a player's second abort, returns both players to the lobby. After three consecutive aborts a player must play their next game; redraws do not count towards this limit.
- **Draw:** sample from the band, excluding positions either player has had recently, so the pool cannot be memorised quickly.
- **Mini-matches:** an optional `match_id` groups two games from the same position with colours reversed. The schema supports it even if the product does not yet.
- **Pair throttling:** repeated pairings between the same two accounts are rate-limited.

## Pairing and game state machine

A pairing is two players and up to three positions: the original, plus one redraw each. The server owns every transition; clients only send intents (seek, abort, move) and render the state they are told.

&#91;embedded content: pairing and game state machine · 6 states\]

A redraw is a player's first abort in a pairing and loops back to a new position; a second abort, or a missed first move, ends the pairing and both players return to the lobby.

| From | Event | Guard | To | Effects |
| --- | --- | --- | --- | --- |
| Seeking | Compatible seek found, or wait elapsed | — | Position revealed | Create pairing and game; draw position; start White's first-move timer |
| Position revealed | Either player aborts | That player's redraw unused | Position revealed | New game, same pairing and band; redraw marked used; not counted as an abort |
| Position revealed | Either player aborts | Redraw used; player below abort limit | Aborted | Abort counted for that player |
| Position revealed | White's first-move timer expires | — | Aborted | Abort counted for White |
| Position revealed | White moves | — | White has moved | Start Black's first-move timer |
| White has moved | Black aborts | Black's redraw unused | Position revealed | As the redraw above |
| White has moved | Black aborts | Redraw used; Black below abort limit | Aborted | Abort counted for Black |
| White has moved | Black's first-move timer expires | — | Aborted | Abort counted for Black |
| White has moved | Black moves | — | Playing | Both clocks start |
| Playing | Mate, resignation, flag, stalemate, draw by agreement, repetition, 50-move rule, insufficient material, or abandonment | — | Finished | Save the result; rate; reset both players' abort counters; emit `game.finished` |
| Aborted | — | — | Seeking | Emit `game.aborted`; both players return to the lobby |
| Finished | — | — | Seeking | Both players return to the lobby |

**Rules the table relies on**

- **Abort limit.** A player at three consecutive aborts may still use an unused redraw, but the abort control is disabled; they must play that game.
- **Who may abort.** Only a player who has not yet made their first move. Once Black has moved, the game can only end by a chess result.
- **Disconnection.** Before Black's first move, a disconnected player simply runs out their first-move timer. During play, their clock keeps running; after a grace period the opponent may claim a win or a draw (abandonment). As in lila, the grace is 30 seconds times 1 for bullet, 2 for blitz, 4 for rapid (two minutes at 10+0) and 10 for classical, halved when the player who left is four points of material down and never under 10 seconds; a claim needs both sides to have moved, and is allowed only while it is the gone player's turn. A claimed win is a draw if the claimer could never have mated. A flag still loses unless the opponent has insufficient material, in which case it is a draw.
- **Server restarts.** Every transition is a status change, so states and timer deadlines are saved to PostgreSQL as soon as it happens, and a restarted process resumes each pairing where it was. A first move is never lost to a crash, so the first-move timer cannot charge an abort the player did not earn. As on Lichess, a clean shutdown gives the side to move 20 seconds and the other side 10, and clock time lost to a crash is not given back.
- **Parameters to set:** first-move timer length, and how long a seek waits before widening. The disconnection grace is lila's (D-05).

## Integrity

The rating model pays more for winning bad positions, so it also pays more for collusion. Integrity is a core service from launch, not a later add-on.

- **Targeted pairing:** once opponent ranges are enabled, a narrow range plus a chosen band lets two friends find each other almost on demand. Flag pairs that meet repeatedly, especially where the side with the advantage resigns, flags or blunders early. Add account age and device signals.
- **Abort shopping:** aborting until a familiar or engine-pessimistic position appears brings opening preparation back. The limit is three consecutive aborts; the counter resets only after a completed game, so resetting it costs a rated result.
- **Engine assistance:** asynchronous post-game analysis comparing accuracy with rating, run from the stored games.
- **Position farming:** if a position's actual results drift from the calibrated prediction, pull it from the pool in the next version.
- **Remedy:** confirmed cases void the games and replay the affected ratings.

## Data model

Every game points at an exact pool version and calibration version; versions and rating events are append-only.

| Entity | Key fields | Mutability |
| --- | --- | --- |
| PoolVersion | version, engine build (source commit, bench signature, network), search settings, filter settings, published at | Immutable |
| Position | id, pool version, FEN, ply (the earliest any game reached it at), eval, shallow eval, best-move gap, rarity score (share of games reaching it) | Immutable |
| CalibrationVersion | version, points per pawn (per rating tier once split), published at | Immutable |
| Seek | id, player, time control, eval band, opponent rating range, created at, status | Short-lived |
| Game | id, white, black, starting FEN, position id, pool version, calibration version, each player's band, time control, status, moves (SAN), each side's clock history, result, termination (including aborted), match id, pairing id (links redraws) | Created when the game starts; updated while it is live |
| RatingEvent | game id, player, time control, rating before and after, deviation before and after, offset applied | Append-only |
| Rating | player, time control, rating, deviation, volatility | Projection, rebuildable from events |
| User | id, handle, created at, status, consecutive aborts | Mutable |
| Identity | user id, provider (Lichess), the provider's account id, linked at | Mutable; the only entity that refers to Lichess |
| Flag | id, subject (player, pair or game), reason, status | Mutable |

## Tech stack and deployment

TypeScript end to end for everything live, so client and server share one rules package; the offline pipeline is free to differ.

| Layer | Choice | Reason |
| --- | --- | --- |
| Licence | AGPL-3.0-or-later; third-party licences in `THIRD_PARTY_LICENCES.md` | Server code stays open even when run as a service, the same choice Lichess made |
| Repository | pnpm workspaces (`packages/rules`, `apps/server`, `apps/client`, `tools/`) plus `pipeline/` managed by uv | One repository, one shared rules package, pipeline kept independent |
| Client | TypeScript, React, PWA, assembled from Lichess's open-source components: chessground, Stockfish compiled to WebAssembly, and logic ported from lila's TypeScript front end | One codebase for web and later native wrappers; Lichess has already solved most of what a chess client needs |
| Board | chessground, npm `@lichess-org/chessground` (GPL-3.0-or-later) | The strongest open board, compatible now that the project is open source |
| Post-game analysis | Stockfish compiled to WebAssembly (GPL-3.0), in the browser | Analysis costs no server CPU |
| Rules | chess.js (BSD-2-Clause) in a shared package | Identical move validation on client and server |
| Live server | Off Book's own: one Node.js process for API, WebSocket games, lobby and rating; lila is not forked | One thing to deploy, monitor and debug. The server is where Off Book differs from Lichess, and lila is Scala with MongoDB and Redis |
| Live state | In memory, saved to PostgreSQL on every status change and otherwise within 30 seconds of a move, as lila does | A restart reloads games in progress, losing at most 30 seconds of moves after a crash; Redis only once there are several instances |
| Accounts | Sign in with Lichess (OAuth 2 with PKCE); Off Book's own user ids and sessions, with each Lichess account linked through `Identity` and its token discarded after sign-in | Most players will already have a Lichess account, and no passwords are held. Because nothing but `Identity` refers to Lichess, another sign-in method can be added later without touching games or ratings |
| Store | PostgreSQL | Relational integrity across versions and games |
| Events | In process, published after the change is saved; no outbox, as lila | No broker or outbox to run. A crash between saving a result and rating it can leave a game unrated, which Lichess accepts too |
| Pipeline | Python with the Stockfish CLI | Batch analysis, off the critical path |
| Published pools | Versioned files attached to GitHub releases, loaded into PostgreSQL | The record survives any database being reset or replaced, and costs nothing to host. Pools stay out of git |
| Migrations | dbmate (MIT), plain SQL files run in order and recorded in the database; forward-only | Two languages share the database, so the schema belongs to neither: SQL reads the same from TypeScript and Python, and dbmate runs as a container inside the local stack |
| Local stack | Docker Compose running PostgreSQL 18, the version Azure will run; the same file in CI | One command to start, following Lichess's `lila-docker`; local and CI cannot drift apart |
| Hosting | Azure Container Apps, Azure Database for PostgreSQL | Managed services; code, CI and backlog on GitHub. No Blob Storage, since no PGN file is stored |
| Checks | GitHub Actions on every push to `main`, on Linux, with the TypeScript and licence jobs also on Windows, where development happens. TypeScript: oxlint with type-aware rules, oxfmt, `tsc` and Node's built-in test runner. Pipeline: Ruff, mypy (strict) and pytest. A licence check holds every installed package to an AGPL-compatible allowlist and every direct dependency to `THIRD_PARTY_LICENCES.md` | Lichess's TypeScript toolchain; Node runs the tests directly with no test framework to maintain |

## Build phases

Build the riskiest part first. Whether a pool exists at all is the one question that can stop the project, and a single analysis run answers it, so it comes first. The real-time core is the largest engineering risk for one developer, so it follows. Calibration can only be tested fully on Off Book's own games, because Lichess games are confounded as test data (D-08), so its Lichess check comes before launch rather than before any interface.

1. **Pool feasibility.** Collect rare positions from masters games, analyse them with the pinned engine, apply the eval ceiling and stability filters, and count positions per band and colour. Exit test: every band you intend to offer holds enough positions to make memorisation impractical.
2. **Playable chess.** Client, server-authoritative game service, challenge links, PGN export with custom start, analysis board; unrated games from any FEN. A milestone, not a product: only the developer plays it, and nothing is built that only standard-position play needs.
3. **Off Book play.** Pool v1 published; the pairing state machine with reveal, redraw and abort; games drawn from the pool.
4. **Calibration and ratings.** Calibration v1 at 64 points per pawn, checked against Lichess 10+0 results across eval buckets and rating tiers; event-sourced Glicko-2 with the offset, rating history and per-game rating breakdown.
5. **Lobby and integrity basics.** Seeks with bands and sides, pair throttling, collusion flags, void-and-replay. Launch follows.
6. **Scale and refine.** Engine-assistance analysis, recalibration on own data, opponent rating ranges, quick-pair, native wrappers.

## Open architectural questions

**Decided (25 October 2026):** no re-rating on recalibration; absolute-eval bands with a chosen side, capped at 3; eval shown before play; one redraw per player per pairing, not counted as an abort, then aborts return both to the lobby, with at most three consecutive aborts; 10+0 only at launch; the rating offset is 64 points per pawn of the position's exact eval; a human opponent takes priority over the exact band, and there are no engine opponents; opponent rating ranges built but disabled at launch; open source under AGPL-3.0-or-later, as Lichess; not a commercial venture; where a choice is in doubt, Lichess's precedent decides; no contributor licence agreement, as Lichess: contributors keep their copyright and license their work under AGPL-3.0-or-later by submitting it; sole developer; code, CI (GitHub Actions) and backlog on GitHub, with the repository as the source of truth and commits straight to `main`; offline pipeline in Python; TypeScript checks follow Lichess (oxlint, oxfmt, Node's test runner) and the pipeline uses Ruff, mypy and pytest; the licence check applies the allowlist to every installed package, direct or transitive, but requires only direct dependencies in `THIRD_PARTY_LICENCES.md`, since that register is kept by hand and the shipped notices are generated (X-07). Liquidity is the largest risk and is accepted for now.

**Decided (26 October 2026):** a published pool's record is a versioned file attached to a GitHub release, not a database; loading it into PostgreSQL is separate, so every database, local or Azure, is disposable and rebuilt from the files. The local stack is Docker Compose with PostgreSQL 18, matching Azure, and CI uses the same compose file. Nothing reads the database before Phase 2, so seeding a development database waits for it (P2-20).

**Decided (29 October 2026):** the schema is changed only through migrations, run by dbmate as plain SQL, so neither the TypeScript server nor the Python pipeline owns it. Migrations are forward-only: a mistake is fixed by a new migration. A calibration version's record is a file committed to the repository, loaded into PostgreSQL like a pool. CI also runs the TypeScript and licence checks on Windows. The build order changes, still riskiest first: pool feasibility (generate, analyse, apply the ceiling and stability filters, count by band and colour) comes first, because it is the only question that can stop the project; plain chess follows, because the real-time core is the largest engineering risk; then Off Book's own play, calibration and ratings, and the lobby and integrity. Rarity filtering and publishing the pool move after plain chess, because they trim and ship a pool rather than decide whether one exists. (Rarity has since moved back into pool feasibility, because it now selects the candidates: see 1 November.) Plain chess is a milestone, not a product: only the developer plays it, nothing is built that only standard-position play needs, and every game starts from a FEN. Challenge links pair players until the lobby exists (D-04). D-01, D-02 and the outbox half of D-03 are resolved at the start of Phase 2 (P2-00); the `Pairing` half waits for the pairing schema (P3-06). The client is assembled from Lichess's open-source components (chessground, Stockfish compiled to WebAssembly, and logic ported from lila's TypeScript front end, which is AGPL-3.0-or-later like Off Book); the server is Off Book's own, and lila is not forked. Code ported from lila keeps its copyright notices and is recorded in `THIRD_PARTY_LICENCES.md`. Players sign in with Lichess (D-09), but Off Book's own user id is the key everywhere: each Lichess account is linked through an `Identity` row, Off Book issues its own sessions, and the Lichess token is discarded once the account id is read. Leaving Lichess later means adding another sign-in method and letting players link it, with no change to games or ratings. Whether to also hold an email address as a recovery path is D-17.

**Decided (30 October 2026):** the pipeline pins Stockfish 19 by its source commit, bench signature and network, not by its binary's checksum. Before any analysis it runs `bench` and refuses to start if the node count differs from the pinned signature, which is the check Stockfish's own CI uses to confirm that builds for different platforms behave identically. Any build of the pinned release passes, on any operating system or CPU, so a different checksum never stops a run, and `PoolVersion` keeps no binary checksum. Stockfish 19 has a single full-size network, embedded in the binary, so the pool is analysed with the big net alone and no small net; the pipeline never sets `EvalFile`. Evals need not match outside the pipeline: the browser analysis board (P2-19) may show a different number from the pool, and only the pool's eval is used for ratings.

**Decided (1 November 2026):** a position's eval must be transparent, not precise. Players are being compensated for playing at an eval disadvantage, so what matters is that they see the eval the offset is based on, not that it is calculated to the last centipawn; the analysis node count is chosen for cost, not to chase accuracy.

**Decided (1 November 2026):** candidates come from real games, not from enumerating every legal line, which offered positions no player would want, such as the starting position again after 1.Nf3 Nf6 2.Ng1 Ng8. A position is a candidate when at least 2 games reach it and fewer than 0.05% of games do, counting each game once wherever in it the position occurs. The first collection is masters games. There is no fixed starting ply: four plies was only ever an example. Rarity is the share of games through the position itself, with no look-ahead. Because every candidate has been reached in real games, this replaces the 31 October decision not to filter out positions a sensible player would not reach. The enumerating generator built for P1-02 is retired.

**Decided (1 November 2026):** off book means the position is rare, and a game starts at the point in the opening where it leaves commonly played positions: a candidate is a rare position that at least one game reaches straight from a common one. How deep that is varies by line, so some candidates are closer to a middlegame than others, and there is no upper ply bound (D-18).

**Decided (1 November 2026):** a candidate is at least four plies in, and a line that leaves common play before then gives no candidate, so an offbeat start such as 1.Na3 never does. "Common" is measured among masters games for now; widening the collection later means a new pool version.

**Decided (1 November 2026):** the masters games are Lichess's masters database (over-the-board games by players rated 2200 or more, from 1952), read once through the opening explorer API and kept, so the pool does not depend on Lichess afterwards; the point is independence, not exclusivity, and later changes to Lichess's database are deliberately ignored. "Common" is therefore measured across master play since 1952. The 0.05% threshold is a starting value, not final. TWIC, chosen earlier the same day to keep computation down, was dropped: it is free for personal use only.

**Decided (4 November 2026):** the masters crawl is kept apart within the pipeline, not in a separate codebase. Its module is the pipeline's only network code and nothing else imports it, which a test enforces; its only output is the store of counts, and everything after it, including deriving candidates at a new threshold, reads the store alone, so the rest of the pipeline works with the crawler deleted. Each crawl run records its threshold, outcome and the commit of the code that ran it in the store, and the commit that runs the full crawl is tagged. The store is kept on the developer's machine, outside git and unpublished: it is the only copy, so backing it up is the developer's job, and losing it means crawling again.

**Decided (5 November 2026):** the crawl threshold is 0.05%, the same as the rarity threshold, so the crawl takes no more of Lichess's data than the current rule needs. A higher rarity threshold can be applied later from the store; a lower one means a top-up crawl, which extends the same store and looks up only positions it lacks.

**Decided (8 November 2026):** live play follows lila, Lichess's server, and promises nothing stronger than Lichess does. Live games are held in memory by the one server process, with no Redis (D-01). A game is saved to PostgreSQL as soon as its status changes and otherwise within 30 seconds of a move, as lila's `GameProxy` does. Off Book's pairing transitions, including each side's first move, are status changes, because the first-move timer charges aborts. A clean shutdown saves every game and gives the side to move 20 seconds and the other side 10, as lila does when it stops. A crash loses at most the last 30 seconds of moves, and lost clock time is not given back. Write-through on every move was dropped because it promised more than Lichess does. Each game is one `Game` row, created when the game starts and updated while it is live, with its moves as SAN and each side's clock history on the row, as lila keeps them on its game document, rather than in a table of moves (D-02). No PGN file is stored, so there is no Blob Storage: PGN is built from the row when asked for, as lila's export does. There is no outbox (D-03). As in lila's finisher, when a game finishes the result is saved, the game is rated, and then `game.finished` is announced within the process, so a crash in between can leave a finished game unrated. A crash may be likelier for Off Book than for Lichess, but an unrated game costs it no more, so Lichess's precedent stands. A rating is a fold over `RatingEvent` rows, not over events.

**Decided (8 November 2026):** two of D-05's numbers follow lila, under the rule above that live play rebuilds what Lichess does: the lag-compensation cap is lila's per-player quota (a second's gain a move from three minutes up, starting at three moves' worth and capped at seven), and the disconnection grace is lila's, two minutes at 10+0. Off Book measures no frame lag, so the quota's gain stays at lila's maximum; lila lowers it to the frame lag its WebSocket server measures. A move's ply travels with it, so a resent move is acknowledged rather than played twice. As in lila's finisher, a game whose clock runs out within two minutes of the server starting, with its last move made before the start, is aborted rather than lost on time. Saving waits 30 seconds from the first unsaved move rather than restarting the wait at every move as lila does, so that a crash loses at most 30 seconds of moves, as promised above.

1. **How long before a seek widens?** Too short and nobody gets the band they asked for; too long and the second player online leaves before the first is matched.
2. **How do you concentrate players in time?** With one time control and no engine opponents, the number of people online at the same moment decides everything. Scheduled sessions, arenas or notifications when someone is seeking are the usual levers.
3. **Should a player's chosen band persist across pairings?** Re-posting the seek automatically after a return to the lobby saves a step, but may keep someone in a band they have just shown they dislike.
