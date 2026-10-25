# Open Questions — Chess App

## Concept (as of 25 Oct 2026)

- Every game starts from a pre-played position rather than the standard opening position.
- Target audience: established chess players.
- Games are rated.
- Rating changes are adjusted for the Stockfish evaluation of the starting position: winning (or drawing) from a worse position earns a bigger rating gain.
- "Two moves each" was the starting idea but is **not fixed**.
- Working name: *Off Book* (under review).

## 1. Position selection

1. **Depth.** How many moves in should positions start? Now that imbalance is priced into the rating, depth matters less — what is the right range?
2. **Eval range.** What is the cap on imbalance? At −4, a "win" usually means the opponent blundered. Where does reward for skill turn into reward for luck?
3. **Transposition.** Will positions be filtered for whether they *stay* off book, rather than only for being rare at the start? Many unusual-looking positions transpose back into mainline theory within a few moves.
4. **Rarity.** Is "rare" measured against master games, or against the rating band of the players? Should it vary by player?
5. **Pool exposure.** Established players will study the pool. Is that acceptable, or must the pool be large or rotating enough that memorising it doesn't pay?

## 2. Rating system

6. **Eval-to-score conversion.** Stockfish evaluation is not a human's practical chance of winning. How will expected score be calibrated as a function of eval, rating band and sharpness of the position (for example, from Lichess game data, then the app's own results)?
7. **Engine stability.** Which Stockfish version and search depth will be fixed? Evals must be stored with each position so that engine updates don't silently change the rating maths.
8. **Draws.** How much should a draw from a clearly worse position be worth?
9. **Separate rating.** Will this rating be tracked separately from players' standard ratings, and will you publish how the two compare?

## 3. Matchmaking

10. **Side allocation.** Who gets the worse side?
    - Random allocation: higher variance and noisier ratings.
    - Handicap allocation (the weaker player gets the better position): any two players get a game with roughly 50/50 expected score.
    - Is the goal to *reward heroics* or to *equalise games*?
11. **Colour reversal.** Do players get the same position twice with colours swapped?

## 4. Integrity

12. **Collusion.** The eval adjustment makes a deliberately thrown winning position worth more than in standard Elo. What detection and safeguards are needed?
13. **Exploits.** How will you detect positions where the engine is systematically too pessimistic for humans before players farm rating from them?

## 5. Product and naming

14. **Core proposition.** Is the headline "no preparation" or "your rating reflects what you did with the position you were given"?
15. **Name.** Does the name convey the core proposition, or only a side effect of it?
16. **Clearance.** App-store, domain and trademark checks for the shortlisted names. "OffChess" (an offline puzzle app) exists, and "Offline Chess" titles crowd searches for "off".
