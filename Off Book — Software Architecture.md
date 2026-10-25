# Off Book — Software Architecture

Oct 25, 2026 · @Cillian

## Summary and assumptions

Off Book splits into a thin real-time play layer and an offline pipeline that produces the two things the product's credibility rests on: the position pool and the rating calibration. Both are immutable and versioned, and every game records which versions it used, so any rating can be recomputed, audited or reversed.

Where the product is still undecided, this design assumes the following. Each is revisited under Open architectural questions.

- Web-first progressive web app; native apps later as thin wrappers.
- Real-time rated games at 10+0 only at launch. Time control is a field on seeks, games and ratings, so more can be added without a schema change.
- Players choose an eval band and whether they take the better or worse side (opponent rating ranges come after launch), see the position and its eval before play, and may abort before the first move.
- Open source, so GPL components are usable and the server is published.
- One developer. At launch everything live runs as a single Node.js process with PostgreSQL as the only store; the services below are module boundaries inside it, split out only when load demands it.

## System overview

&#91;embedded content: system architecture · online services, data, offline pipeline\]

Matchmaking draws a position from the catalogue and hands the pairing to the game service; when a game ends, the rating and fair-play services consume the event. Everything the rating maths depends on is produced offline and pinned by version.

## Position pipeline

The pool is built offline and published as an immutable version; nothing in live play ever calls Stockfish. An eval is a property of three things together: the position, the engine build and the search settings. Upgrading Stockfish therefore means a new pool version, never an in-place edit.

1. **Generate.** Enumerate candidate positions at a configurable ply depth (four plies is a parameter, not a constant). Deduplicate by FEN so transpositions collapse into one position.
2. **Analyse.** Run a pinned Stockfish build at a fixed node count with MultiPV 3. Store the eval, the eval at a shallower search, and the gap between the best and second-best move.
3. **Filter.**
   - Eval ceiling: drop positions beyond an absolute eval of 3, and all mate scores.
   - Stability: drop positions whose eval moves materially between the two search depths.
   - Rarity: drop positions that are common in the Lichess open database for the target rating bands. Check at the starting ply and again a few plies on, to catch lines that transpose back into theory.
   - Sharpness: record the best-move gap so the monthly check can show whether sharp positions are mispriced.
4. **Publish.** Write pool vN to PostgreSQL and load it into the position catalogue. Old versions stay readable forever, because finished games reference them.

This is batch numerical work with no latency requirement, so it can be written in whatever you analyse data fastest in (Julia or Python), independently of the live stack.

## Game service

The game service is the sole authority on board state and clocks; clients only propose moves.

- **Connection:** one WebSocket per player. On reconnect the client resyncs from the server's move list, never its own.
- **Validation:** server-side legality check using the same rules library as the client, shared as one TypeScript package.
- **Clocks:** timed on server receipt, with lag compensation capped per move so a player cannot gain time by faking latency.
- **Live state:** move list, clocks and position id held in Redis, so a process restart loses no games. On completion the game goes to PostgreSQL and the PGN to blob storage.
- **Custom start:** every game begins from a FEN, not the standard position. PGN export, the analysis board and any third-party import must use the PGN `SetUp` and `FEN` tags, and this needs testing early because many tools handle it badly.
- **Events:** emits `game.started` and `game.finished` (result, termination reason, move count, clock data, position id).

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
- **Event-sourced for voids only.** A rating is a fold over `game.finished` events, each replayed with its own pinned calibration. Voiding a game for collusion is a replay without it; it never re-prices other games.
- **Aborts are invisible to ratings.** An aborted game emits `game.aborted`, which the rating service ignores.
- **Separate pools** per time control, and never mixed with a player's standard-chess rating elsewhere.
- **Guard rails.** Clamp the offset at the eval ceiling. Players with high rating deviation are limited to the bands nearest level until their rating settles, since a big offset on an uncertain rating is mostly noise.

**Calibration loop**

1. Launch with one constant, 64 points per pawn, as calibration v1. Before launch, check it against Lichess 10+0 games by eval bucket and rating tier.
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
| Playing | Mate, resignation, flag, stalemate, draw by agreement, repetition, 50-move rule, insufficient material, or abandonment | — | Finished | Emit `game.finished`; rate; reset both players' abort counters |
| Aborted | — | — | Seeking | Emit `game.aborted`; both players return to the lobby |
| Finished | — | — | Seeking | Both players return to the lobby |

**Rules the table relies on**

- **Abort limit.** A player at three consecutive aborts may still use an unused redraw, but the abort control is disabled; they must play that game.
- **Who may abort.** Only a player who has not yet made their first move. Once Black has moved, the game can only end by a chess result.
- **Disconnection.** Before Black's first move, a disconnected player simply runs out their first-move timer. During play, their clock keeps running; after a grace period the opponent may claim a win or a draw (abandonment). A flag still loses unless the opponent has insufficient material, in which case it is a draw.
- **Server restarts.** States and timers are written to PostgreSQL on every transition, so a restarted process resumes each pairing where it was. Clock time lost to the restart is credited back to both players.
- **Parameters to set:** first-move timer length, disconnection grace period, and how long a seek waits before widening.

## Integrity

The rating model pays more for winning bad positions, so it also pays more for collusion. Integrity is a core service from launch, not a later add-on.

- **Targeted pairing:** once opponent ranges are enabled, a narrow range plus a chosen band lets two friends find each other almost on demand. Flag pairs that meet repeatedly, especially where the side with the advantage resigns, flags or blunders early. Add account age and device signals.
- **Abort shopping:** aborting until a familiar or engine-pessimistic position appears brings opening preparation back. The limit is three consecutive aborts; the counter resets only after a completed game, so resetting it costs a rated result.
- **Engine assistance:** asynchronous post-game analysis comparing accuracy with rating, run from the stored PGNs.
- **Position farming:** if a position's actual results drift from the calibrated prediction, pull it from the pool in the next version.
- **Remedy:** confirmed cases void the games and replay the affected ratings.

## Data model

Every game points at an exact pool version and calibration version; versions and rating events are append-only.

| Entity | Key fields | Mutability |
| --- | --- | --- |
| PoolVersion | version, engine build, search settings, filter settings, published at | Immutable |
| Position | id, pool version, FEN, ply, eval, shallow eval, best-move gap, rarity score | Immutable |
| CalibrationVersion | version, points per pawn (per rating tier once split), published at | Immutable |
| Seek | id, player, time control, eval band, opponent rating range, created at, status | Short-lived |
| Game | id, white, black, position id, pool version, calibration version, each player's band, time control, result, termination (including aborted), PGN reference, match id, pairing id (links redraws) | Written once at completion |
| RatingEvent | game id, player, time control, rating before and after, deviation before and after, offset applied | Append-only |
| Rating | player, time control, rating, deviation, volatility | Projection, rebuildable from events |
| User | id, handle, created at, status, consecutive aborts | Mutable |
| Flag | id, subject (player, pair or game), reason, status | Mutable |

## Tech stack and deployment

TypeScript end to end for everything live, so client and server share one rules package; the offline pipeline is free to differ.

| Layer | Choice | Reason |
| --- | --- | --- |
| Licence | AGPL-3.0 | Server code stays open even when run as a service, the same choice Lichess made |
| Client | TypeScript, React, PWA | One codebase for web and later native wrappers |
| Board | chessground (GPL-3.0) | The strongest open board, compatible now that the project is open source |
| Post-game analysis | Stockfish compiled to WebAssembly, in the browser | Analysis costs no server CPU |
| Rules | chess.js (BSD) in a shared package | Identical move validation on client and server |
| Live server | One Node.js process: API, WebSocket games, lobby, rating | One thing to deploy, monitor and debug |
| Live state | In memory, every move written through to PostgreSQL | A restart reloads games in progress; Redis only once there are several instances |
| Store | PostgreSQL | Relational integrity across versions and games |
| Events | Transactional outbox table in PostgreSQL | No broker to run |
| Pipeline | Julia or Python with the Stockfish CLI | Batch analysis, off the critical path |
| Hosting | Azure Container Apps, Azure Database for PostgreSQL, Blob Storage | Managed services; pipelines and boards in Azure DevOps |

## Build phases

Build the riskiest part first: the concept fails if eval cannot predict results by rating band, and no amount of UI fixes that.

1. **Pool v1.** Pipeline end to end. Exit test: every band you intend to offer holds enough positions to make memorisation impractical.
2. **Calibration v1** at 64 points per pawn. Exit test: Lichess 10+0 results match the predicted score closely enough across eval buckets and rating tiers that no tier is an obvious farm.
3. **Playable core.** Client, game service, reveal-and-abort, unrated games from the pool, PGN export with custom start.
4. **Ratings.** Event-sourced Glicko-2 with the offset, rating history and per-game rating breakdown.
5. **Lobby and integrity basics.** Seeks with bands and sides, abort limit, pair throttling, collusion flags, void-and-replay.
6. **Scale and refine.** Engine-assistance analysis, recalibration on own data, opponent rating ranges, quick-pair, native wrappers.

## Open architectural questions

**Decided (25 October 2026):** no re-rating on recalibration; absolute-eval bands with a chosen side, capped at 3; eval shown before play; one redraw per player per pairing, not counted as an abort, then aborts return both to the lobby, with at most three consecutive aborts; 10+0 only at launch; the rating offset is 64 points per pawn of the position's exact eval; a human opponent takes priority over the exact band, and there are no engine opponents; opponent rating ranges built but disabled at launch; open source; sole developer. Liquidity is the largest risk and is accepted for now.

1. **How long before a seek widens?** Too short and nobody gets the band they asked for; too long and the second player online leaves before the first is matched.
2. **How do you concentrate players in time?** With one time control and no engine opponents, the number of people online at the same moment decides everything. Scheduled sessions, arenas or notifications when someone is seeking are the usual levers.
3. **Should a player's chosen band persist across pairings?** Re-posting the seek automatically after a return to the lobby saves a step, but may keep someone in a band they have just shown they dislike.
