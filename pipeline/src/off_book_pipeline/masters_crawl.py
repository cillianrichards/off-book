"""Lichess masters crawl (P1-10): reads Lichess's masters database once, through its opening explorer API.

This is the pipeline's only code that touches the network, and nothing else in the pipeline imports it
(a test enforces both). Its only output is the store, whose format lives in `masters`; once the full crawl
has run, the store is all the pool needs (decided 4 November 2026).

`crawl` walks out from the starting position. It looks up every position it reaches and expands (looks up
every move played from) each one reached by at least the crawl threshold of the database's games. Only
counts are kept: the position, its games and their results, and the games and results for each move.
Player names, game ids, ratings and opening names in Lichess's answers are discarded. Lookups go one at a
time, as Lichess asks; a 429 answer waits a minute, then longer if it repeats. Every answer is appended to
the store straight away, so an interrupted crawl resumes where it stopped, and crawling the same store
again at a lower threshold only looks up what is new. Each run ends by recording its threshold, lookups,
whether it finished, and the commit of the code that ran it.

Run with `python -m off_book_pipeline.masters_crawl STORE --crawl-threshold PERCENT`, with a Lichess
personal API token in `LICHESS_TOKEN`.
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from off_book_pipeline.collect import CollectSettings
from off_book_pipeline.masters import (
    START,
    MoveCount,
    PositionCount,
    Store,
    StoreDamaged,
    board_at,
    child,
)

MAX_PLY = 60
"""No position deeper than this is expanded: far beyond where any line leaves common play."""

USER_AGENT = "Off Book pipeline (https://github.com/cillianrichards/off-book)"


class CrawlRefused(Exception):
    """The crawl cannot continue: Lichess refused it, or its answers are not what the crawl expects."""


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


def common_from(percent: str, games: int) -> int:
    return CollectSettings(rare_below_percent=percent, min_rating=None).common_from(games)


def code_version() -> str:
    """The commit of the code running the crawl, marked dirty if it has uncommitted changes."""
    here = Path(__file__).parent

    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=here, capture_output=True, text=True, check=True, timeout=10
        ).stdout.strip()

    try:
        commit = git("rev-parse", "HEAD")
        dirty = bool(git("status", "--porcelain", "--", "."))
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return f"{commit}-dirty" if dirty else commit


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
    code: str | None = None,
) -> CrawlSummary:
    """Look up every position the crawl threshold needs and is not yet in the store, then stop."""
    store = Store(store_path)
    code = code_version() if code is None else code
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
    summary = CrawlSummary(
        total, threshold, len(store.counts), looked_up, expanded, len(queue), deepest, clock() - started
    )
    store.add_run(
        {
            "crawl_threshold": crawl_threshold_percent,
            "looked_up": looked_up,
            "complete": summary.complete,
            "code": code,
        }
    )
    return summary


# Command line


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.masters_crawl",
        description="Look up positions in Lichess's masters database, resuming STORE if it exists.",
    )
    parser.add_argument("store", type=Path, help="the crawl's store (JSON Lines); keep it out of git")
    parser.add_argument(
        "--crawl-threshold",
        default=CollectSettings().rare_below_percent,
        help="expand positions reached by at least this percentage of games (default %(default)s)",
    )
    parser.add_argument("--max-lookups", type=int, help="stop after this many lookups (resume later)")
    parser.add_argument("--max-minutes", type=float, help="stop after this many minutes (resume later)")
    parser.add_argument("--token-env", default="LICHESS_TOKEN", help="variable holding a Lichess API token")
    args = parser.parse_args(argv)
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
    except (CrawlRefused, StoreDamaged) as error:
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
