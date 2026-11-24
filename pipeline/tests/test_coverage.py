"""P1-07: positions per band, split by which colour is better, banded on the deep eval alone."""

import json
from pathlib import Path

import pytest

from off_book_pipeline.analyse import Analysis
from off_book_pipeline.coverage import Band, BandCoverage, band_coverage, band_of, main
from off_book_pipeline.filters import FilterReport, FilterSettings, write_filtered


def position(eval_cp: int | None, shallow_cp: int = 0, fen: str = "fen") -> Analysis:
    return Analysis(fen, eval_cp, None if eval_cp is not None else 2, shallow_cp, None, 5)


@pytest.mark.parametrize("eval_cp", [0, 99, -99, 50])
def test_under_a_pawn_is_balanced(eval_cp: int) -> None:
    assert band_of(position(eval_cp)) is Band.BALANCED


@pytest.mark.parametrize("eval_cp", [100, -100, 250, 300, -300])
def test_a_pawn_or_more_is_winning_and_losing(eval_cp: int) -> None:
    assert band_of(position(eval_cp)) is Band.WINNING_LOSING


def test_the_deep_eval_alone_decides_the_band() -> None:
    assert band_of(position(105, shallow_cp=95)) is Band.WINNING_LOSING
    assert band_of(position(95, shallow_cp=105)) is Band.BALANCED


def test_a_mate_score_is_refused() -> None:
    with pytest.raises(ValueError, match="filter the positions first"):
        band_of(position(None))


def test_coverage_splits_each_band_by_the_better_colour() -> None:
    evals = [40, -30, 0, 99, 100, 180, -250, 300]
    coverage = band_coverage([position(eval_cp) for eval_cp in evals])
    assert coverage == {
        Band.BALANCED: BandCoverage(4, white_better=2, black_better=1, level=1),
        Band.WINNING_LOSING: BandCoverage(4, white_better=3, black_better=1, level=0),
    }


def test_an_empty_band_is_still_reported() -> None:
    coverage = band_coverage([position(20)])
    assert coverage[Band.WINNING_LOSING] == BandCoverage(0, 0, 0, 0)


def test_the_command_writes_a_report_beside_the_filtered_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    filtered = tmp_path / "filtered.jsonl"
    kept = [position(20, fen="a"), position(-150, fen="b"), position(120, fen="c")]
    write_filtered(filtered, {"engine": {}}, FilterSettings(), kept, FilterReport(3, 0, 0, 3))
    assert main([str(filtered)]) == 0
    report = json.loads((tmp_path / "filtered.jsonl.coverage.json").read_text(encoding="utf-8"))
    assert report["filters"] == {"eval_ceiling_cp": 300, "max_swing_cp": 100}
    assert report["bands"] == {
        "Balanced": {"positions": 1, "white_better": 1, "black_better": 0, "level": 0},
        "Winning and Losing": {"positions": 2, "white_better": 1, "black_better": 1, "level": 0},
    }
    assert "Winning and Losing: 2 positions; White better in 1 (50%)" in capsys.readouterr().out
