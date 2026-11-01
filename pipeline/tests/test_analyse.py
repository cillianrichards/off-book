"""P1-03: the analysis runner records evals reproducibly, in parallel, and resumes after interruption.

Orchestration and resuming are tested with a fake analyser. Searches are tested against a real Stockfish 19
when `OFF_BOOK_STOCKFISH` names one (CI builds it), including the done test: re-running a sample gives
identical evals.
"""

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import ClassVar

import chess
import chess.engine
import pytest

from off_book_pipeline.analyse import (
    Analysis,
    RunRefused,
    RunSummary,
    SearchSettings,
    StockfishAnalyser,
    analysis_from_searches,
    main,
    read_candidates,
    read_results,
    run_analysis,
)
from off_book_pipeline.engine import STOCKFISH_19, EnginePin

SETTINGS = SearchSettings(nodes=20_000, shallow_nodes=2_000)


def line(score: chess.engine.Score, turn: chess.Color = chess.WHITE) -> chess.engine.InfoDict:
    return {"score": chess.engine.PovScore(score, turn)}


# Searches -> Analysis


def test_evals_are_from_whites_point_of_view() -> None:
    # Black to move and 40 centipawns better: -40 for White.
    deep = [line(chess.engine.Cp(40), chess.BLACK), line(chess.engine.Cp(15), chess.BLACK)]
    shallow = [line(chess.engine.Cp(35), chess.BLACK)]
    analysis = analysis_from_searches("fen", deep, shallow)
    assert (analysis.eval_cp, analysis.eval_mate) == (-40, None)
    assert (analysis.shallow_eval_cp, analysis.shallow_eval_mate) == (-35, None)
    # The gap is from the mover's point of view, so always the best line's lead.
    assert analysis.best_move_gap_cp == 25


def test_a_mate_score_sets_the_mate_flag_instead_of_centipawns() -> None:
    deep = [line(chess.engine.Mate(2), chess.BLACK), line(chess.engine.Cp(-50), chess.BLACK)]
    shallow = [line(chess.engine.Cp(900), chess.BLACK)]
    analysis = analysis_from_searches("fen", deep, shallow)
    assert (analysis.eval_cp, analysis.eval_mate) == (None, -2)
    assert (analysis.shallow_eval_cp, analysis.shallow_eval_mate) == (-900, None)
    assert analysis.best_move_gap_cp is None


def test_a_mated_second_line_leaves_the_gap_unset() -> None:
    deep = [line(chess.engine.Cp(10)), line(chess.engine.Mate(-3))]
    assert analysis_from_searches("fen", deep, [line(chess.engine.Cp(5))]).best_move_gap_cp is None


def test_one_line_leaves_the_gap_unset() -> None:
    analysis = analysis_from_searches("fen", [line(chess.engine.Cp(0))], [line(chess.engine.Cp(0))])
    assert analysis.best_move_gap_cp is None


def test_a_search_without_lines_is_an_error() -> None:
    with pytest.raises(ValueError, match="returned no lines"):
        analysis_from_searches("fen", [], [line(chess.engine.Cp(0))])


def test_analysis_round_trips_through_json() -> None:
    analysis = Analysis("fen", 12, None, 10, None, 4)
    assert Analysis.from_json(json.loads(analysis.to_json())) == analysis


# Settings


def test_settings_are_recorded_in_full() -> None:
    assert SearchSettings().as_dict() == {
        "nodes": 100_000,
        "shallow_nodes": 10_000,
        "multipv": 3,
        "hash_mb": 16,
        "threads": 1,
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"threads": 2}, "one thread"),
        ({"nodes": 1000, "shallow_nodes": 1000}, "must be under 1000"),
        ({"multipv": 0}, "must all be positive"),
    ],
)
def test_bad_settings_are_rejected(kwargs: dict[str, int], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        SearchSettings(**kwargs)


# Orchestration, with a fake analyser


class FakeAnalyser:
    """Deterministic results derived from the FEN; optionally fails after a number of positions."""

    created: ClassVar[list["FakeAnalyser"]] = []
    lock: ClassVar[threading.Lock] = threading.Lock()

    def __init__(self, fail_after: int | None = None) -> None:
        self.fail_after = fail_after
        self.analysed: list[str] = []
        self.closed = False
        with FakeAnalyser.lock:
            FakeAnalyser.created.append(self)

    def analyse(self, fen: str) -> Analysis:
        if self.fail_after is not None and len(self.analysed) >= self.fail_after:
            raise RuntimeError("engine died")
        self.analysed.append(fen)
        digest = int(hashlib.sha256(fen.encode()).hexdigest(), 16)
        return Analysis(fen, digest % 600 - 300, None, digest % 500 - 250, None, digest % 97)

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def reset_fakes() -> None:
    FakeAnalyser.created = []


def positions_after_one_move_each() -> list[str]:
    """The 400 positions after White's and Black's first moves: a ready-made set of distinct FENs."""
    board, fens = chess.Board(), []
    for first in list(board.legal_moves):
        board.push(first)
        for reply in list(board.legal_moves):
            board.push(reply)
            fens.append(board.fen())
            board.pop()
        board.pop()
    return sorted(fens)


@pytest.fixture
def candidates(tmp_path: Path) -> Path:
    path = tmp_path / "candidates.txt"
    path.write_text("".join(f"{fen}\n" for fen in positions_after_one_move_each()), encoding="utf-8")
    return path


def run(
    candidates: Path,
    output: Path,
    *,
    workers: int = 1,
    fail_after: int | None = None,
    settings: SearchSettings = SETTINGS,
    pin: EnginePin = STOCKFISH_19,
) -> RunSummary:
    return run_analysis(
        candidates,
        output,
        analyser_factory=lambda: FakeAnalyser(fail_after),
        pin=pin,
        settings=settings,
        workers=workers,
    )


def analysed_fens() -> list[str]:
    return [fen for analyser in FakeAnalyser.created for fen in analyser.analysed]


def test_the_candidates_file_may_carry_extra_columns(tmp_path: Path) -> None:
    path = tmp_path / "candidates.tsv"
    path.write_text(
        "fen one w - - 0 3\t4\t2\t0.1\nfen two b - - 0 3\t5\t3\t0.15\n\nfen one w - - 0 3\n", encoding="utf-8"
    )
    fens, checksum = read_candidates(path)
    assert fens == ["fen one w - - 0 3", "fen two b - - 0 3"]
    assert checksum == hashlib.sha256(path.read_bytes()).hexdigest()


def test_every_candidate_is_analysed_once_and_recorded(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    summary = run(candidates, output, workers=3)
    assert (summary.candidates, summary.already_done, summary.analysed) == (400, 0, 400)
    header, results = read_results(output)
    assert header == {
        "engine": STOCKFISH_19.pool_version_fields(),
        "search": SETTINGS.as_dict(),
        "candidates_sha256": hashlib.sha256(candidates.read_bytes()).hexdigest(),
    }
    assert set(results) == set(candidates.read_text().split("\n")) - {""}
    assert sorted(analysed_fens()) == sorted(results)
    assert all(analyser.closed for analyser in FakeAnalyser.created)


def test_results_do_not_depend_on_the_number_of_workers(candidates: Path, tmp_path: Path) -> None:
    run(candidates, tmp_path / "one.jsonl", workers=1)
    run(candidates, tmp_path / "four.jsonl", workers=4)
    assert read_results(tmp_path / "one.jsonl") == read_results(tmp_path / "four.jsonl")


def test_an_interrupted_run_resumes_where_it_stopped(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    with pytest.raises(RuntimeError, match="engine died"):
        run(candidates, output, fail_after=150)
    _, partial = read_results(output)
    assert len(partial) == 150
    assert all(analyser.closed for analyser in FakeAnalyser.created)

    FakeAnalyser.created = []
    summary = run(candidates, output, workers=2)
    assert (summary.already_done, summary.analysed) == (150, 250)
    assert not set(analysed_fens()) & set(partial)
    run(candidates, tmp_path / "uninterrupted.jsonl")
    assert read_results(output) == read_results(tmp_path / "uninterrupted.jsonl")
    assert len(output.read_text().splitlines()) == 401


def test_a_failure_loses_no_finished_result(candidates: Path, tmp_path: Path) -> None:
    # Three engines that each fail after 40 positions: every position one of them finished is recorded.
    output = tmp_path / "out.jsonl"
    with pytest.raises(RuntimeError, match="engine died"):
        run(candidates, output, workers=3, fail_after=40)
    _, partial = read_results(output)
    assert sorted(partial) == sorted(analysed_fens())
    assert len(partial) >= 40


def test_a_line_cut_off_by_the_interruption_is_discarded(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    with pytest.raises(RuntimeError):
        run(candidates, output, fail_after=10)
    with output.open("a", encoding="utf-8") as file:
        file.write('{"fen":"rnbqkbnr/pp')  # killed mid-write
    summary = run(candidates, output)
    assert (summary.already_done, summary.analysed) == (10, 390)
    _, results = read_results(output)
    assert len(results) == 400
    assert output.read_text().endswith("}\n")


def test_a_header_cut_off_starts_the_run_again(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    output.write_text('{"run":{"cand', encoding="utf-8")
    assert run(candidates, output).analysed == 400


def test_a_finished_run_has_nothing_left_to_do(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    run(candidates, output)
    FakeAnalyser.created = []
    assert run(candidates, output).analysed == 0
    assert analysed_fens() == []


def test_resuming_with_other_settings_is_refused(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    with pytest.raises(RuntimeError):
        run(candidates, output, fail_after=5)
    before = output.read_bytes()
    with pytest.raises(RunRefused, match="different search"):
        run(candidates, output, settings=SearchSettings(nodes=30_000, shallow_nodes=2_000))
    assert output.read_bytes() == before


def test_resuming_with_another_engine_is_refused(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    run(candidates, output)
    other = EnginePin(release="Stockfish 20", source_commit="0" * 40, bench=1, network="nn-other.nnue")
    with pytest.raises(RunRefused, match="different engine"):
        run(candidates, output, pin=other)


def test_resuming_with_other_candidates_is_refused(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    run(candidates, output)
    candidates.write_text(candidates.read_text() + "8/8/8/8/8/8/8/K6k w - - 0 1\n", encoding="utf-8")
    with pytest.raises(RunRefused, match="different candidates_sha256"):
        run(candidates, output)


def test_a_damaged_output_is_refused(candidates: Path, tmp_path: Path) -> None:
    output = tmp_path / "out.jsonl"
    run(candidates, output)
    lines = output.read_text().splitlines(keepends=True)
    lines[5] = "not json\n"
    output.write_text("".join(lines), encoding="utf-8")
    with pytest.raises(RunRefused, match=r"Line 6 .* is damaged"):
        run(candidates, output)


def test_main_needs_an_engine(candidates: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OFF_BOOK_STOCKFISH", raising=False)
    with pytest.raises(SystemExit) as exit_info:
        main([str(candidates), str(tmp_path / "out.jsonl")])
    assert exit_info.value.code == 2


def test_main_refuses_an_engine_that_is_not_the_pinned_build(
    candidates: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "out.jsonl"
    assert main([str(candidates), str(output), "--engine", str(tmp_path / "no-such-stockfish")]) == 1
    assert capsys.readouterr().err.startswith("Refused: Cannot start the engine")
    assert not output.exists()


# Real Stockfish 19

REAL_STOCKFISH = os.environ.get("OFF_BOOK_STOCKFISH")
needs_stockfish = pytest.mark.skipif(not REAL_STOCKFISH, reason="OFF_BOOK_STOCKFISH does not name a build")

SAMPLE = [
    "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3",
    "rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3",
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3",
    "1nbqkbnr/1ppppppp/r7/p7/P7/R7/1PPPPPPP/1NBQKBNR w Kk - 0 3",
    "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
]


def real_analyser() -> StockfishAnalyser:
    assert REAL_STOCKFISH is not None
    return StockfishAnalyser([REAL_STOCKFISH], SETTINGS)


@needs_stockfish
def test_rerunning_a_sample_gives_identical_evals(tmp_path: Path) -> None:
    candidates = tmp_path / "sample.txt"
    candidates.write_text("".join(f"{fen}\n" for fen in SAMPLE), encoding="utf-8")
    first, second = tmp_path / "first.jsonl", tmp_path / "second.jsonl"
    run_analysis(candidates, first, analyser_factory=real_analyser, settings=SETTINGS, workers=1)
    run_analysis(candidates, second, analyser_factory=real_analyser, settings=SETTINGS, workers=2)
    assert read_results(first) == read_results(second)
    assert len(read_results(first)[1]) == len(SAMPLE)


@needs_stockfish
def test_each_search_starts_from_a_fresh_hash() -> None:
    # Without `ucinewgame` before each search, the second look at a position would reuse the first's hash.
    analyser = real_analyser()
    try:
        first = analyser.analyse(SAMPLE[0])
        analyser.analyse(SAMPLE[1])
        assert analyser.analyse(SAMPLE[0]) == first
    finally:
        analyser.close()


@needs_stockfish
def test_a_real_search_fills_every_field() -> None:
    analyser = real_analyser()
    try:
        # 1.f3 e5 2.g4: Black mates in one, so the eval is mate in 1 for Black.
        mate = analyser.analyse(SAMPLE[4])
        assert (mate.eval_cp, mate.eval_mate) == (None, -1)
        assert mate.best_move_gap_cp is None
        # 1.e4 Nf6 2.e5 d5?? 3.exf6 wins a knight: White is clearly better, and exf6 beats exd6 by a distance.
        piece_up = analyser.analyse(SAMPLE[1])
        assert piece_up.eval_cp is not None and piece_up.eval_cp > 300
        assert piece_up.shallow_eval_cp is not None and piece_up.shallow_eval_cp > 300
        assert piece_up.best_move_gap_cp is not None and piece_up.best_move_gap_cp > 200
        # Only Kxb2 is legal, leaving bare kings: a dead draw with no second line.
        only_move = analyser.analyse("k7/8/8/8/8/8/1q6/K7 w - - 0 1")
        assert (only_move.eval_cp, only_move.best_move_gap_cp) == (0, None)
    finally:
        analyser.close()
