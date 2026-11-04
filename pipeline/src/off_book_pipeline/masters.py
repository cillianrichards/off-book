"""Lichess masters counts (P1-10): the crawl's store, and candidates derived from it offline.

The store is the one thing the crawl (`masters_crawl`) hands on: a JSON Lines file holding, for every
position looked up, the master games reaching it and their results, and the games and results for each
move played from it. This module reads and writes that format and never touches the network, so it is the
part that keeps working after the crawl has been run for the last time (decided 4 November 2026).

Lichess counts a game once per position, by any move order, with an en passant square only when the
capture is legal: P1-02's definition, checked in lila-openingexplorer's masters indexer. One difference:
Lichess keeps a single move per position per game, the last one played from it, so a move made from a
position the game later returns to is not offered. That changes nothing in practice, and on the same games
the crawl and P1-02 select the same candidates.

`candidates_from_store` applies P1-02's rule to a store. Any rarity threshold at or above the lowest one the
store was crawled at works, as do any floor and minimum ply; a threshold the store cannot support is
refused rather than guessed at.

Run with `python -m off_book_pipeline.masters STORE OUTPUT [--rare-below PERCENT]`.
"""

import argparse
import json
import sys
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import chess

from off_book_pipeline.collect import Candidate, CollectSettings, write_candidates

START = chess.Board().epd(en_passant="legal")


@dataclass(frozen=True)
class MoveCount:
    uci: str
    san: str
    white: int
    draws: int
    black: int

    @property
    def games(self) -> int:
        return self.white + self.draws + self.black


@dataclass(frozen=True)
class PositionCount:
    """What the store keeps for one position: its games and results, and the same for each move from it."""

    white: int
    draws: int
    black: int
    moves: tuple[MoveCount, ...]

    @property
    def games(self) -> int:
        return self.white + self.draws + self.black


class StoreDamaged(Exception):
    """The store cannot be read: start a new one."""


class CrawlIncomplete(Exception):
    """The store lacks positions that these thresholds need: crawl it at a lower threshold first."""


def board_at(epd: str) -> chess.Board:
    return chess.Board(f"{epd} 0 1")


def child(board: chess.Board, move: MoveCount) -> str:
    """The position after `move`. Lichess may write castling as king takes rook (e1h1); both forms work."""
    try:
        parsed = board.parse_uci(move.uci)
    except ValueError:
        parsed = board.parse_san(move.san)
    board.push(parsed)
    try:
        return board.epd(en_passant="legal")
    finally:
        board.pop()


# The store


class Store:
    """JSON Lines: a header, a line of counts per position looked up, and a line per crawl run.

    Position lines are appended as each answer arrives, so a crawl cut off at any moment loses at most the
    line being written, which is discarded on the next open. A run line records how a crawl run ended:
    its threshold, lookups, whether it finished, and the commit of the code that ran it.
    """

    def __init__(self, path: Path, *, create: bool = True) -> None:
        self.path = path
        self.counts: dict[str, PositionCount] = {}
        self.runs: list[dict[str, Any]] = []
        self.header: dict[str, Any] = {}
        data = path.read_bytes() if path.exists() else b""
        complete = len(data) - len(data.split(b"\n")[-1])
        if complete == 0:
            if not create:
                raise CrawlIncomplete(f"{path} holds no crawl.")
            self.header = {"source": "https://explorer.lichess.org/masters", "started": _now(), "format": 1}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"crawl": self.header}) + "\n", encoding="utf-8", newline="\n")
            return
        if complete < len(data):
            with path.open("r+b") as file:  # drop a line cut off by an interruption
                file.truncate(complete)
        lines = data[:complete].split(b"\n")[:-1]
        try:
            self.header = json.loads(lines[0])["crawl"]
            for line in lines[1:]:
                record = json.loads(line)
                if "run" in record:
                    self.runs.append(record["run"])
                    continue
                moves = tuple(MoveCount(*move) for move in record["moves"])
                self.counts[record["fen"]] = PositionCount(
                    record["white"], record["draws"], record["black"], moves
                )
        except (KeyError, TypeError, ValueError, IndexError) as error:
            raise StoreDamaged(f"{path} is damaged ({error!r}); start a new store.") from error

    def add(self, epd: str, count: PositionCount) -> None:
        self._append(
            {
                "fen": epd,
                "date": _now()[:10],
                "white": count.white,
                "draws": count.draws,
                "black": count.black,
                "moves": [[m.uci, m.san, m.white, m.draws, m.black] for m in count.moves],
            }
        )
        self.counts[epd] = count

    def add_run(self, run: dict[str, Any]) -> None:
        """Record how a crawl run ended, stamped with the time."""
        stamped = {"ended": _now(), **run}
        self._append({"run": stamped})
        self.runs.append(stamped)

    def _append(self, record: dict[str, Any]) -> None:
        with self.path.open("a", encoding="utf-8", newline="\n") as file:
            file.write(json.dumps(record, separators=(",", ":")) + "\n")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# Candidates, offline


def candidates_from_store(
    store_path: Path, settings: CollectSettings
) -> tuple[list[Candidate], dict[str, Any]]:
    """Apply P1-02's rule to a store: rare positions entered straight from a common one, late enough."""
    store = Store(store_path, create=False)
    counts = store.counts
    if START not in counts:
        raise CrawlIncomplete(f"{store_path} has not looked up the starting position.")
    total = counts[START].games
    threshold = settings.common_from(total)

    def children_of(epd: str) -> list[str]:
        board = board_at(epd)
        found = []
        for move in counts[epd].moves:
            following = child(board, move)
            if following not in counts:
                raise CrawlIncomplete(
                    f"The store never looked up {following}, which a {settings.rare_below_percent}% "
                    "threshold needs: crawl it at that threshold or lower first."
                )
            found.append(following)
        return found

    # Earliest ply of every common position and of every position entered from one.
    earliest = {START: 0}
    common = [START]
    queue = deque([START])
    while queue:
        epd = queue.popleft()
        for following in children_of(epd):
            if following not in earliest:
                earliest[following] = earliest[epd] + 1
                if counts[following].games >= threshold:
                    common.append(following)
                    queue.append(following)

    # Positions entered from a common position whose ply there is at least min_ply - 1. Plies are capped,
    # so a common position reachable at several depths is visited at most min_ply times.
    cap = settings.min_ply - 1
    late: set[str] = set()
    visited = {(START, min(0, cap))}
    states = deque([(START, min(0, cap))])
    while states:
        epd, depth = states.popleft()
        for following in children_of(epd):
            if depth == cap:
                late.add(following)
            if counts[following].games >= threshold:
                state = (following, min(depth + 1, cap))
                if state not in visited:
                    visited.add(state)
                    states.append(state)

    entered = {following for epd in common for following in children_of(epd)}
    removed = {"still_common": 0, "below_min_games": 0, "before_min_ply": 0, "no_legal_moves": 0}
    candidates = []
    for epd in sorted(entered):
        games = counts[epd].games
        if games >= threshold:
            removed["still_common"] += 1
        elif games < settings.min_games:
            removed["below_min_games"] += 1
        elif epd not in late:
            removed["before_min_ply"] += 1
        elif not any(board_at(epd).legal_moves):
            removed["no_legal_moves"] += 1
        else:
            ply = earliest[epd]
            candidates.append(Candidate(f"{epd} 0 {ply // 2 + 1}", ply, games, games / total))
    candidates.sort(key=lambda candidate: candidate.fen)
    report = {
        "settings": {
            k: v for k, v in settings.as_dict().items() if k in ("min_games", "rare_below_percent", "min_ply")
        },
        "source": {
            "store": store_path.name,
            **store.header,
            "positions_saved": len(counts),
            "runs": store.runs,
        },
        "total_games": total,
        "common_from_games": threshold,
        "common_positions": len(common),
        "entered_from_common": len(entered),
        "removed": removed,
        "candidates": len(candidates),
    }
    return candidates, report


# Command line


def main(argv: Sequence[str] | None = None) -> int:
    defaults = CollectSettings()
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.masters",
        description="Apply the rarity rule to a masters crawl's store, offline.",
    )
    parser.add_argument("store", type=Path, help="the crawl's store (JSON Lines)")
    parser.add_argument("output", type=Path, help="candidates file: FEN, ply, games and share, tab-separated")
    parser.add_argument("--min-games", type=int, default=defaults.min_games)
    parser.add_argument("--rare-below", default=defaults.rare_below_percent, help="percentage of games")
    parser.add_argument("--min-ply", type=int, default=defaults.min_ply)
    args = parser.parse_args(argv)
    try:
        settings = CollectSettings(args.min_games, args.rare_below, args.min_ply, min_rating=None)
    except ValueError as error:
        parser.error(str(error))
    try:
        candidates, report = candidates_from_store(args.store, settings)
    except (CrawlIncomplete, StoreDamaged) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    report_path = write_candidates(args.output, candidates, report)
    removed = report["removed"]
    print(
        f"{report['total_games']:,} master games; "
        f"{report['entered_from_common']:,} positions entered from common ones: "
        f"{removed['still_common']:,} still common, {removed['below_min_games']:,} below "
        f"{settings.min_games} games, {removed['before_min_ply']:,} before ply {settings.min_ply}, "
        f"{removed['no_legal_moves']:,} finished; {len(candidates):,} candidates written to {args.output}, "
        f"report in {report_path}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
