"""Candidate positions (P1-02): every position reachable from the start in exactly N plies.

Lines are enumerated a ply at a time and collapsed to one canonical FEN per position, so the second half
of the tree is never walked twice: each position carries the number of lines that reach it, and those
counts add up to perft. Collapsing early changes nothing, because the canonical FEN keeps everything that
decides which moves are legal.

A canonical FEN is the FEN with three normalisations, so that transpositions compare equal:

- the en passant square only when an en passant capture is legal, as FIDE's repetition rule counts it;
- the halfmove clock set to 0: move orders reach the same position with different clocks;
- the fullmove number taken from the ply, which every line of the same length shares.

Positions with no legal moves (checkmate or stalemate) are dropped, since no game can start from one.

Run with `python -m off_book_pipeline.generate OUTPUT [--ply N]`.
"""

import argparse
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import chess

DEFAULT_PLY = 4


def canonical_fen(board: chess.Board, ply: int) -> str:
    """The position's FEN, normalised so that every line reaching it gives the same string."""
    return f"{board.epd(en_passant='legal')} 0 {ply // 2 + 1}"


@dataclass(frozen=True)
class Generation:
    """Every position at one ply, with the number of lines reaching each."""

    ply: int
    lines_by_fen: dict[str, int]
    """Canonical FEN to the number of move orders that reach it, finished positions included."""
    finished: frozenset[str]
    """Positions with no legal moves: in `lines_by_fen`, but never candidates."""

    @property
    def lines(self) -> int:
        """Legal lines of exactly `ply` moves from the start: perft(ply)."""
        return sum(self.lines_by_fen.values())

    @property
    def candidates(self) -> list[str]:
        """Canonical FENs a game could start from, sorted so that the output is reproducible."""
        return sorted(fen for fen in self.lines_by_fen if fen not in self.finished)


def generate(ply: int = DEFAULT_PLY) -> Generation:
    """Enumerate every legal line of `ply` moves from the start and collapse transpositions."""
    if ply < 1:
        raise ValueError(f"The ply depth must be at least 1, not {ply}.")
    level = {canonical_fen(chess.Board(), 0): 1}
    for depth in range(1, ply + 1):
        following: dict[str, int] = {}
        for fen, lines in level.items():
            # A canonical FEN rebuilds a board with exactly the original's legal moves.
            board = chess.Board(fen)
            for move in board.legal_moves:
                board.push(move)
                child = canonical_fen(board, depth)
                following[child] = following.get(child, 0) + lines
                board.pop()
        level = following
    finished = frozenset(fen for fen in level if not any(chess.Board(fen).legal_moves))
    return Generation(ply=ply, lines_by_fen=level, finished=finished)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.generate",
        description="Write every candidate position at one ply, one canonical FEN per line.",
    )
    parser.add_argument("output", type=Path, help="file to write; replaced if it exists")
    parser.add_argument("--ply", type=int, default=DEFAULT_PLY, help=f"ply depth (default {DEFAULT_PLY})")
    args = parser.parse_args(argv)
    if args.ply < 1:
        parser.error(f"--ply must be at least 1, not {args.ply}")

    generation = generate(args.ply)
    candidates = generation.candidates
    args.output.write_text("".join(f"{fen}\n" for fen in candidates), encoding="utf-8", newline="\n")
    print(
        f"Ply {generation.ply}: {generation.lines} lines, {len(generation.lines_by_fen)} positions, "
        f"{len(generation.finished)} finished and dropped; {len(candidates)} written to {args.output}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
