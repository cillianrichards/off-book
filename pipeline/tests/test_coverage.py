"""P1-07 and P1-09: positions per band, split by the better colour, and the exit test against D-06."""

import json
from pathlib import Path

import pytest

from off_book_pipeline.analyse import Analysis
from off_book_pipeline.coverage import (
    MINIMUM_POSITIONS,
    Band,
    BandCoverage,
    band_coverage,
    band_of,
    exit_test,
    main,
)
from off_book_pipeline.filters import FilterReport, FilterSettings, write_filtered


def position(eval_cp: int | None, shallow_cp: int = 0, fen: str = "fen") -> Analysis:
    return Analysis(fen, eval_cp, None if eval_cp is not None else 2, shallow_cp, None, 5)


@pytest.mark.parametrize("eval_cp", [0, 74, -74, 50])
def test_under_three_quarters_of_a_pawn_is_balanced(eval_cp: int) -> None:
    assert band_of(position(eval_cp)) is Band.BALANCED


@pytest.mark.parametrize("eval_cp", [75, -75, 100, 250, 300, -300])
def test_three_quarters_of_a_pawn_or_more_is_better_and_worse(eval_cp: int) -> None:
    assert band_of(position(eval_cp)) is Band.BETTER_WORSE


def test_the_deep_eval_alone_decides_the_band() -> None:
    assert band_of(position(80, shallow_cp=70)) is Band.BETTER_WORSE
    assert band_of(position(70, shallow_cp=80)) is Band.BALANCED


def test_a_mate_score_is_refused() -> None:
    with pytest.raises(ValueError, match="filter the positions first"):
        band_of(position(None))


def test_coverage_splits_each_band_by_the_better_colour() -> None:
    evals = [40, -30, 0, 74, 75, 180, -250, 300]
    coverage = band_coverage([position(eval_cp) for eval_cp in evals])
    assert coverage == {
        Band.BALANCED: BandCoverage(4, white_better=2, black_better=1, level=1),
        Band.BETTER_WORSE: BandCoverage(4, white_better=3, black_better=1, level=0),
    }


def test_an_empty_band_is_still_reported() -> None:
    coverage = band_coverage([position(20)])
    assert coverage[Band.BETTER_WORSE] == BandCoverage(0, 0, 0, 0)


def test_the_command_writes_a_report_beside_the_filtered_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    filtered = tmp_path / "filtered.jsonl"
    kept = [position(20, fen="a"), position(-150, fen="b"), position(120, fen="c")]
    write_filtered(filtered, {"engine": {}}, FilterSettings(), kept, FilterReport(3, 0, 0, 3))
    assert main([str(filtered), "--minimum", "1"]) == 0
    report = json.loads((tmp_path / "filtered.jsonl.coverage.json").read_text(encoding="utf-8"))
    assert report["filters"] == {"eval_ceiling_cp": 300, "max_swing_cp": 100}
    assert report["bands"] == {
        "Balanced": {"positions": 1, "white_better": 1, "black_better": 0, "level": 0},
        "Better and Worse": {"positions": 2, "white_better": 1, "black_better": 1, "level": 0},
    }
    assert "Better and Worse: 2 positions; White better in 1 (50%)" in capsys.readouterr().out
    assert report["exit_test"] == {"minimum": 1, "passed": {"Balanced": True, "Better and Worse": True}}


# Exit test (P1-09)


def test_the_minimum_is_d06s_600() -> None:
    assert MINIMUM_POSITIONS == 600


def test_a_band_passes_at_exactly_the_minimum_and_fails_one_below() -> None:
    coverage = {
        Band.BALANCED: BandCoverage(600, 500, 100, 0),
        Band.BETTER_WORSE: BandCoverage(599, 580, 19, 0),
    }
    assert exit_test(coverage) == {Band.BALANCED: True, Band.BETTER_WORSE: False}


def test_the_command_fails_when_any_band_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    filtered = tmp_path / "filtered.jsonl"
    kept = [position(20, fen="a"), position(30, fen="b"), position(150, fen="c")]
    write_filtered(filtered, {"engine": {}}, FilterSettings(), kept, FilterReport(3, 0, 0, 3))
    assert main([str(filtered), "--minimum", "2"]) == 1
    out = capsys.readouterr().out
    assert "Exit test, Balanced: pass" in out
    assert "Exit test, Better and Worse: FAIL (at least 2 needed)" in out
