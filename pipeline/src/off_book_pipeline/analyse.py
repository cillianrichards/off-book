"""Analysis runner (P1-03): every candidate position searched twice by the pinned Stockfish.

A deep search at a fixed node count with MultiPV 3 gives the eval and the best-move gap. The same search at
a smaller node count gives the shallow eval, which the stability filter (P1-06) compares with the deep one.
Both are limited by nodes, not time, so results do not depend on the machine.

Each search runs on one thread straight after `ucinewgame`, which clears Stockfish's hash and history. A
position's result therefore depends only on the position and the settings, never on what the engine
searched before, which is what makes a run reproducible, lets positions run in parallel (one engine per
worker, in any order) and lets a run resume after interruption.

The output is JSON Lines: a header recording the engine, the search settings and the candidates file's
checksum, then one line per position, appended as each finishes, in no particular order. Running again
with the same output resumes it: recorded positions are skipped, and a line cut off by the interruption is
discarded. A run refuses to resume with a different engine, settings or candidates file, so every result in
one output comes from one configuration.

Run with `python -m off_book_pipeline.analyse CANDIDATES OUTPUT --engine PATH`.
"""

import argparse
import hashlib
import json
import os
import sys
import threading
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

import chess
import chess.engine

from off_book_pipeline.engine import PINNED, EnginePin, EngineRefused, verify_engine


@dataclass(frozen=True)
class SearchSettings:
    """Everything besides the engine that decides a search's result. Recorded with every run."""

    nodes: int = 1_000_000
    shallow_nodes: int = 100_000
    multipv: int = 3
    hash_mb: int = 16
    """Stockfish's default. Part of the settings because the hash size changes what a search finds."""

    threads: int = 1
    """Always 1: a multi-threaded search is not reproducible."""

    def __post_init__(self) -> None:
        if self.threads != 1:
            raise ValueError("Searches run on one thread, so that they are reproducible.")
        if min(self.nodes, self.shallow_nodes, self.multipv, self.hash_mb) < 1:
            raise ValueError("Node counts, MultiPV and hash size must all be positive.")
        if self.shallow_nodes >= self.nodes:
            raise ValueError(f"The shallow search ({self.shallow_nodes} nodes) must be under {self.nodes}.")

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class Analysis:
    """One position's result. Evals are from White's point of view, as Lichess reports them.

    Exactly one of `eval_cp` and `eval_mate` is set, and likewise for the shallow eval: a mate score is
    "mate in N", positive when White mates and negative when Black does. A mate score is the mate flag
    the eval ceiling (P1-06) removes.
    """

    fen: str
    eval_cp: int | None
    eval_mate: int | None
    shallow_eval_cp: int | None
    shallow_eval_mate: int | None
    best_move_gap_cp: int | None
    """The best line against the second best, from the mover's point of view. None when there is only one
    legal move, or when either line is a mate score, since a mate has no size in centipawns."""

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"))

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Analysis":
        return cls(**data)


def _pov_score(info: chess.engine.InfoDict) -> chess.engine.PovScore:
    score = info.get("score")
    if score is None:
        raise ValueError("The engine reported a line without a score.")
    return score


def _white_eval(score: chess.engine.PovScore) -> tuple[int | None, int | None]:
    white = score.white()
    return (None, white.mate()) if white.is_mate() else (white.score(), None)


def analysis_from_searches(
    fen: str, deep: Sequence[chess.engine.InfoDict], shallow: Sequence[chess.engine.InfoDict]
) -> Analysis:
    """Build a position's result from the MultiPV lines of its deep and shallow searches, best first."""
    if not deep or not shallow:
        raise ValueError(f"A search of {fen} returned no lines.")
    eval_cp, eval_mate = _white_eval(_pov_score(deep[0]))
    shallow_cp, shallow_mate = _white_eval(_pov_score(shallow[0]))
    gap = None
    if len(deep) >= 2:
        best, second = _pov_score(deep[0]).relative, _pov_score(deep[1]).relative
        if not best.is_mate() and not second.is_mate():
            gap = best.score() - second.score()  # type: ignore[operator]  # both are centipawns here
    return Analysis(fen, eval_cp, eval_mate, shallow_cp, shallow_mate, gap)


class PositionAnalyser(Protocol):
    def analyse(self, fen: str) -> Analysis: ...

    def close(self) -> None: ...


class StockfishAnalyser:
    """One Stockfish process, searching one position at a time."""

    def __init__(self, command: Sequence[str], settings: SearchSettings) -> None:
        self._settings = settings
        self._engine = chess.engine.SimpleEngine.popen_uci(list(command))
        self._engine.configure({"Threads": settings.threads, "Hash": settings.hash_mb})

    def analyse(self, fen: str) -> Analysis:
        board = chess.Board(fen)
        deep = self._search(board, self._settings.nodes)
        shallow = self._search(board, self._settings.shallow_nodes)
        return analysis_from_searches(fen, deep, shallow)

    def _search(self, board: chess.Board, nodes: int) -> list[chess.engine.InfoDict]:
        # A new game object makes python-chess send `ucinewgame`, which clears the hash for this search.
        return self._engine.analyse(
            board, chess.engine.Limit(nodes=nodes), multipv=self._settings.multipv, game=object()
        )

    def close(self) -> None:
        self._engine.quit()


class RunRefused(Exception):
    """The output belongs to a different run, or is damaged, so this run must not write to it."""


@dataclass(frozen=True)
class RunHeader:
    engine: dict[str, str | int]
    search: dict[str, int]
    candidates_sha256: str

    def to_json(self) -> str:
        return json.dumps({"run": asdict(self)}, separators=(",", ":"), sort_keys=True)


@dataclass(frozen=True)
class RunSummary:
    candidates: int
    already_done: int
    analysed: int


def read_candidates(path: Path) -> tuple[list[str], str]:
    """The candidate FENs, one per line, in file order without repeats, and the file's SHA-256."""
    data = path.read_bytes()
    fens = [line.strip() for line in data.decode("utf-8").splitlines()]
    return list(dict.fromkeys(fen for fen in fens if fen)), hashlib.sha256(data).hexdigest()


def read_results(path: Path) -> tuple[dict[str, Any], dict[str, Analysis]]:
    """A run's header and its results by FEN, ignoring a final line cut off by an interruption."""
    lines = _complete_lines(path.read_bytes())
    if not lines:
        raise RunRefused(f"{path} has no header.")
    header = _parse(lines[0], path, 1)
    results = {}
    for number, line in enumerate(lines[1:], start=2):
        analysis = Analysis.from_json(_parse(line, path, number))
        results[analysis.fen] = analysis
    return header["run"], results


def _complete_lines(data: bytes) -> list[bytes]:
    lines = data.split(b"\n")
    return lines[:-1]  # the last piece is empty, or a line cut off before its newline


def _parse(line: bytes, path: Path, number: int) -> dict[str, Any]:
    try:
        parsed: dict[str, Any] = json.loads(line)
    except json.JSONDecodeError as error:
        raise RunRefused(f"Line {number} of {path} is damaged; start a new output.") from error
    return parsed


def _prepare_output(path: Path, header: RunHeader) -> set[str]:
    """Start the output, or check it belongs to this run and return the positions already done."""
    data = path.read_bytes() if path.exists() else b""
    complete = len(data) - len(data.split(b"\n")[-1])
    if complete == 0:
        path.write_text(header.to_json() + "\n", encoding="utf-8", newline="\n")
        return set()
    if complete < len(data):
        with path.open("r+b") as file:  # drop the line the interruption cut off
            file.truncate(complete)
    recorded, results = read_results(path)
    expected = json.loads(header.to_json())["run"]
    differences = [key for key in expected if recorded.get(key) != expected[key]]
    if differences:
        raise RunRefused(
            f"{path} was started with a different {', '.join(differences)}. "
            "A run only resumes with the engine, search settings and candidates it started with; "
            "use a new output file to analyse with these."
        )
    return set(results)


def run_analysis(
    candidates_path: Path,
    output_path: Path,
    *,
    analyser_factory: Callable[[], PositionAnalyser],
    pin: EnginePin = PINNED,
    settings: SearchSettings,
    workers: int,
    progress: Callable[[int, int], None] | None = None,
) -> RunSummary:
    """Analyse every candidate not yet in the output, `workers` positions at a time.

    The engine must already have passed `verify_engine`; `pin` is the pin it passed against.
    """
    if workers < 1:
        raise ValueError("At least one worker is needed.")
    fens, candidates_sha256 = read_candidates(candidates_path)
    header = RunHeader(pin.pool_version_fields(), settings.as_dict(), candidates_sha256)
    done = _prepare_output(output_path, header)
    todo = [fen for fen in fens if fen not in done]

    local = threading.local()
    analysers: list[PositionAnalyser] = []
    lock = threading.Lock()

    def analyse(fen: str) -> Analysis:
        analyser: PositionAnalyser | None = getattr(local, "analyser", None)
        if analyser is None:
            analyser = analyser_factory()
            local.analyser = analyser
            with lock:
                analysers.append(analyser)
        return analyser.analyse(fen)

    analysed = 0
    failure: BaseException | None = None
    pool = ThreadPoolExecutor(max_workers=workers)
    try:
        futures = [pool.submit(analyse, fen) for fen in todo]
        with output_path.open("a", encoding="utf-8", newline="\n") as output:
            # as_completed yields futures that had already finished in no particular order, so a failure can
            # arrive before results that finished earlier. On a failure, start no more positions but keep
            # writing every result that finishes, so that resuming repeats no work.
            for future in as_completed(futures):
                if future.cancelled():
                    continue
                error = future.exception()
                if error is not None:
                    if failure is None:
                        failure = error
                        for pending in futures:
                            pending.cancel()
                    continue
                output.write(future.result().to_json() + "\n")
                output.flush()
                analysed += 1
                if progress is not None:
                    progress(len(done) + analysed, len(fens))
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
        for analyser in analysers:
            analyser.close()
    if failure is not None:
        raise failure
    return RunSummary(candidates=len(fens), already_done=len(done), analysed=analysed)


def _report_progress(every: int) -> Callable[[int, int], None]:
    def report(finished: int, total: int) -> None:
        if finished % every == 0 or finished == total:
            print(f"{finished} of {total} positions analysed ({finished / total:.1%}).", file=sys.stderr)

    return report


def main(argv: Iterable[str] | None = None) -> int:
    defaults = SearchSettings()
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.analyse",
        description="Analyse candidate positions with the pinned Stockfish, resuming OUTPUT if it exists.",
    )
    parser.add_argument("candidates", type=Path, help="candidate positions, one FEN per line")
    parser.add_argument("output", type=Path, help="results file (JSON Lines); resumed if it exists")
    parser.add_argument("--engine", default=os.environ.get("OFF_BOOK_STOCKFISH"), help="Stockfish 19 binary")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 1, help="engines run in parallel")
    parser.add_argument("--nodes", type=int, default=defaults.nodes, help="deep search node count")
    parser.add_argument("--shallow-nodes", type=int, default=defaults.shallow_nodes, help="shallow search")
    args = parser.parse_args(None if argv is None else list(argv))
    if not args.engine:
        parser.error("name the engine with --engine or OFF_BOOK_STOCKFISH")
    try:
        settings = SearchSettings(nodes=args.nodes, shallow_nodes=args.shallow_nodes)
    except ValueError as error:
        parser.error(str(error))
    if args.workers < 1:
        parser.error("--workers must be at least 1")

    command = [args.engine]
    try:
        engine = verify_engine(command)
        summary = run_analysis(
            args.candidates,
            args.output,
            analyser_factory=lambda: StockfishAnalyser(command, settings),
            pin=engine.pin,
            settings=settings,
            workers=args.workers,
            progress=_report_progress(every=100),
        )
    except (EngineRefused, RunRefused) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(
        f"{summary.analysed} positions analysed, {summary.already_done} already done, "
        f"{summary.candidates} in all, in {args.output}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
