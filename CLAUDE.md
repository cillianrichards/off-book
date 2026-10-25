# Off Book

Open-source chess app. Every game starts from a pre-played position, and ratings are adjusted for the Stockfish evaluation of that position. One developer (Cillian), building in phases.

## Source of truth

This repository is the source of truth for code and docs. Read the relevant doc before working; never rely on memory of an earlier version.

- `Off Book — Software Architecture.md`: the design and every decision made so far.
- `Off Book — Build Backlog.md`: phased work items (P0–P6, X, D) and their exit tests. This file is the board; there is no other tracker.

## Git

- Commit and push straight to `main`. No branches or pull requests unless asked.
- Pull before starting work and again before pushing.
- Small commits, each doing one thing. The message says what changed and why, prefixed with the backlog ID where there is one (`P1-02: …`).
- Once CI exists (P0-02), a red build on `main` is fixed before anything else.
- Never commit secrets, credentials, Lichess dumps, Stockfish binaries or network files, or generated pools. Large data stays out of git.
- Never merge or copy in an outside contribution until its author has signed the contributor licence agreement (X-10).

## Keeping the docs honest

- A decision made in conversation goes into the architecture doc in the same piece of work: add it to the "Decided" list with its date, and remove or rewrite anything it contradicts.
- A finished backlog item is ticked in the same commit as the work.
- If code and docs disagree, stop and raise it. Do not silently pick one.
- Docs, comments and commit messages use British English.

## Build order and scope

- Riskiest first. Phases 1 (pool) and 2 (calibration) can kill the project, so no interface work until Phase 2's exit test passes, unless told otherwise.
- No scope the backlog doesn't contain. If something is missing, propose it as a new backlog item and wait for agreement before building it.

## Technical constraints

- Live code is TypeScript end to end, with one shared rules package (chess.js) used by client and server.
- The offline pipeline (`pipeline/`) is Python, independent of the live stack.
- Licence is AGPL-3.0-or-later. Every new dependency must be licence-compatible; state its licence when adding it, and add it to `THIRD_PARTY_LICENCES.md` in the same commit.
- Nothing in live play calls Stockfish. Evals come only from a published, versioned pool.
- Pool and calibration versions are immutable. Never edit one in place; publish a new version.
- Rating and pairing logic are pure functions with no I/O, tested against worked examples.
- Every change comes with tests. Code that hasn't been run is not done.
