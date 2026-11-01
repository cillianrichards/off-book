"""Lichess masters crawl (P1-10): candidates from Lichess's masters database, read once through its API.

The opening explorer's masters endpoint answers, for one position, how many master games reached it and
how many played each move from it. Lichess counts a game once per position, by any move order, with an en
passant square only when the capture is legal: P1-02's definition, checked in lila-openingexplorer's
masters indexer. One difference: Lichess keeps a single move per position per game, the last one played
from it, so a move made from a position the game later returns to is not offered. That changes nothing
in practice, and on the same games the crawl and P1-02 select the same candidates.

`crawl` walks out from the starting position. It looks up every position it reaches and expands (looks up
every move played from) each one reached by at least the crawl threshold of the database's games. Only
counts are kept: the position, its games and their results, and the games and results for each move.
Player names, game ids, ratings and opening names in Lichess's answers are discarded. Lookups go one at a
time, as Lichess asks; a 429 answer waits a minute, then longer if it repeats. Every answer is appended to
a store file straight away, so an interrupted crawl resumes where it stopped, and crawling the same store
again at a lower threshold only looks up what is new.

`candidates` applies P1-02's rule to a store without touching the network. Any rarity threshold at or
above the crawl threshold works, as do any floor and minimum ply; a threshold the store cannot support is
refused rather than guessed at.

Run with `python -m off_book_pipeline.masters crawl STORE` and `... candidates STORE OUTPUT`.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import chess

from off_book_pipeline.collect import Candidate, CollectSettings, write_candidates

START = chess.Board().epd(en_passant="legal")
MAX_PLY = 60
"""No position deeper than this is expanded: far beyond where any line leaves common play."""

USER_AGENT = "Off Book pipeline (https://github.com/cillianrichards/off-book)"


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


class CrawlRefused(Exception):
    """The crawl cannot continue: Lichess refused it, or its answers are not what the crawl expects."""


class CrawlIncomplete(Exception):
    """The store lacks positions that these thresholds need: crawl it at a lower threshold first."""


def keep_counts(answer: dict[str, Any]) -> PositionCount:
    """Keep only the counts from a Lichess answer, discarding names, game ids, ratings and opening names."""
    try:
        moves = tuple(
            MoveCount(str(m["uci"]), str(m["san"]), int(m["white"]), int(m["draws"]), int(m["black"]))
            for m in answer["moves"]
        )
        return PositionCount(int(answer["white"]), int(answer["draws"]), int(answer["black"]), moves)
    except (KeyError, TypeError, ValueError) as error:
        raise CrawlRefused(f"Lichess's answer did not have the expected counts: {error!r}") from error


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


def common_from(percent: str, games: int) -> int:
    return CollectSettings(rare_below_percent=percent, min_rating=None).common_from(games)


# The store


class Store:
    """JSON Lines: a header, then one line of counts per position looked up, appended as each arrives."""

    def __init__(self, path: Path, *, create: bool = True) -> None:
        self.path = path
        self.counts: dict[str, PositionCount] = {}
        self.header: dict[str, Any] = {}
        data = path.read_bytes() if path.exists() else b""
        complete = len(data) - len(data.split(b"\n")[-1])
        if complete == 0:
            if not create:
                raise CrawlIncomplete(f"{path} holds no crawl.")
            self.header = {"source": "https://explorer.lichess.org/masters", "started": _now(), "format": 1}
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
                moves = tuple(MoveCount(*move) for move in record["moves"])
                self.counts[record["fen"]] = PositionCount(
                    record["white"], record["draws"], record["black"], moves
                )
        except (KeyError, TypeError, ValueError, IndexError) as error:
            raise CrawlRefused(f"{path} is damaged ({error!r}); start a new store.") from error

    def add(self, epd: str, count: PositionCount) -> None:
        record = {
            "fen": epd,
            "date": _now()[:10],
            "white": count.white,
            "draws": count.draws,
            "black": count.black,
            "moves": [[m.uci, m.san, m.white, m.draws, m.black] for m in count.moves],
        }
        with self.path.open("a", encoding="utf-8", newline="\n") as file:
            file.write(json.dumps(record, separators=(",", ":")) + "\n")
        self.counts[epd] = count


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# Talking to Lichess


class Explorer(Protocol):
    def lookup(self, epd: str) -> dict[str, Any]: ...


class LichessExplorer:
    """The masters endpoint, one request at a time, waiting whenever Lichess says it is asked too often."""

    URL = "https://explorer.lichess.org/masters"

    def __init__(
        self,
        token: str,
        *,
        url: str = URL,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = 30.0,
    ) -> None:
        self.token, self.url, self.sleep, self.timeout = token, url, sleep, timeout

    def lookup(self, epd: str) -> dict[str, Any]:
        # Every move played (the endpoint truncates only to the number asked for), and no top games.
        query = urllib.parse.urlencode({"fen": f"{epd} 0 1", "moves": 256, "topGames": 0})
        request = urllib.request.Request(
            f"{self.url}?{query}",
            headers={
                "Authorization": f"Bearer {self.token}",
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
        )
        rate_limited = failures = 0
        while True:
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    answer: dict[str, Any] = json.loads(response.read())
                    return answer
            except urllib.error.HTTPError as error:
                if error.code == 429 and rate_limited < 10:
                    # Lichess: "waiting one minute before retrying will be sufficient, but some limits may
                    # require longer". Honour Retry-After if given, and wait longer each time it repeats.
                    retry_after = error.headers.get("Retry-After", "")
                    wait = float(retry_after) if retry_after.isdigit() else 60.0 * 2**rate_limited
                    rate_limited += 1
                    self.sleep(min(wait, 900.0))
                    continue
                if error.code in (401, 403):
                    raise CrawlRefused(f"Lichess refused the token (HTTP {error.code}).") from error
                if error.code >= 500 and failures < 4:
                    failures += 1
                    self.sleep(10.0 * 2**failures)
                    continue
                raise CrawlRefused(f"Lichess answered HTTP {error.code} for {epd}.") from error
            except (urllib.error.URLError, TimeoutError) as error:
                if failures < 4:
                    failures += 1
                    self.sleep(10.0 * 2**failures)
                    continue
                raise CrawlRefused(f"Cannot reach Lichess: {error}") from error


# Crawling


@dataclass(frozen=True)
class CrawlSummary:
    total_games: int
    threshold_games: int
    positions_saved: int
    looked_up: int
    expanded: int
    still_queued: int
    """Positions known to need looking up when the crawl stopped; more will follow from them."""
    deepest_expanded_ply: int
    seconds: float

    @property
    def complete(self) -> bool:
        return self.still_queued == 0


def crawl(
    store_path: Path,
    explorer: Explorer,
    crawl_threshold_percent: str,
    *,
    max_lookups: int | None = None,
    max_seconds: float | None = None,
    progress: Callable[[int, int, int], None] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> CrawlSummary:
    """Look up every position the crawl threshold needs and is not yet in the store, then stop."""
    store = Store(store_path)
    started = clock()
    queue: deque[tuple[str, int]] = deque([(START, 0)])
    seen = {START}
    looked_up = expanded = deepest = 0
    beyond_limit = False
    threshold = 0
    total = 0
    while queue:
        epd, ply = queue.popleft()
        count = store.counts.get(epd)
        if count is None:
            out_of_lookups = max_lookups is not None and looked_up >= max_lookups
            out_of_time = max_seconds is not None and clock() - started >= max_seconds
            if out_of_lookups or out_of_time:
                queue.appendleft((epd, ply))
                break
            count = keep_counts(explorer.lookup(epd))
            store.add(epd, count)
            looked_up += 1
            if progress is not None:
                progress(looked_up, len(store.counts), len(queue))
        if epd == START:
            total = count.games
            threshold = common_from(crawl_threshold_percent, total)
        if count.games >= threshold and ply >= MAX_PLY:
            beyond_limit = True
        elif count.games >= threshold:
            expanded += 1
            deepest = max(deepest, ply)
            board = board_at(epd)
            for move in count.moves:
                following = child(board, move)
                if following not in seen:
                    seen.add(following)
                    queue.append((following, ply + 1))
    if beyond_limit:
        raise CrawlRefused(
            f"A position beyond ply {MAX_PLY} needed expanding; the crawl does not go that deep."
        )
    return CrawlSummary(
        total, threshold, len(store.counts), looked_up, expanded, len(queue), deepest, clock() - started
    )


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
        "source": {"store": store_path.name, **store.header, "positions_saved": len(counts)},
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
        prog="python -m off_book_pipeline.masters", description=__doc__.split("\n")[0]
    )
    commands = parser.add_subparsers(dest="command", required=True)

    crawl_command = commands.add_parser(
        "crawl", help="look up positions from Lichess, resuming STORE if it exists"
    )
    crawl_command.add_argument("store", type=Path, help="the crawl's store (JSON Lines)")
    crawl_command.add_argument(
        "--crawl-threshold",
        default=defaults.rare_below_percent,
        help="percentage of games (default %(default)s)",
    )
    crawl_command.add_argument("--max-lookups", type=int, help="stop after this many lookups (resume later)")
    crawl_command.add_argument(
        "--max-minutes", type=float, help="stop after this many minutes (resume later)"
    )
    crawl_command.add_argument(
        "--token-env", default="LICHESS_TOKEN", help="variable holding a Lichess API token"
    )

    derive = commands.add_parser("candidates", help="apply the rarity rule to a store, offline")
    derive.add_argument("store", type=Path)
    derive.add_argument("output", type=Path, help="candidates file: FEN, ply, games and share, tab-separated")
    derive.add_argument("--min-games", type=int, default=defaults.min_games)
    derive.add_argument("--rare-below", default=defaults.rare_below_percent, help="percentage of games")
    derive.add_argument("--min-ply", type=int, default=defaults.min_ply)

    args = parser.parse_args(argv)
    if args.command == "crawl":
        return _crawl_command(parser, args)
    try:
        settings = CollectSettings(args.min_games, args.rare_below, args.min_ply, min_rating=None)
    except ValueError as error:
        parser.error(str(error))
    try:
        candidates, report = candidates_from_store(args.store, settings)
    except (CrawlIncomplete, CrawlRefused) as error:
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


def _crawl_command(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    token = os.environ.get(args.token_env, "")
    if not token:
        parser.error(
            f"set {args.token_env} to a Lichess personal API token (lichess.org/account/oauth/token)"
        )
    try:
        common_from(args.crawl_threshold, 1)
    except ValueError as error:
        parser.error(str(error))

    started = time.monotonic()

    def report(looked_up: int, saved: int, queued: int) -> None:
        if looked_up % 100 == 0:
            rate = looked_up / max(time.monotonic() - started, 1e-9)
            print(
                f"{looked_up:,} looked up, {saved:,} saved, {queued:,} queued, {rate:.1f}/s", file=sys.stderr
            )

    try:
        summary = crawl(
            args.store,
            LichessExplorer(token),
            args.crawl_threshold,
            max_lookups=args.max_lookups,
            max_seconds=None if args.max_minutes is None else args.max_minutes * 60,
            progress=report,
        )
    except CrawlRefused as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    rate = summary.looked_up / summary.seconds if summary.seconds else 0.0
    status = (
        "complete" if summary.complete else f"stopped with at least {summary.still_queued:,} still to look up"
    )
    print(
        f"Crawl at {args.crawl_threshold}% ({summary.threshold_games:,} of {summary.total_games:,} games): "
        f"{summary.looked_up:,} looked up in {summary.seconds / 60:.1f} minutes ({rate:.2f}/s), "
        f"{summary.positions_saved:,} saved, {summary.expanded:,} expanded; {status}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
