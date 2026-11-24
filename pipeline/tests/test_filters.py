"""P1-06: the eval ceiling and stability filters, with every threshold a setting and counts reported."""

import hashlib
import json
from pathlib import Path

import pytest

from off_book_pipeline.analyse import Analysis
from off_book_pipeline.filters import (
    FilterRefused,
    FilterSettings,
    apply_filters,
    exceeds_ceiling,
    is_unstable,
    main,
    read_complete_analysis,
    read_filtered,
)

DEFAULTS = FilterSettings()


def position(
    eval_cp: int | None,
    shallow_cp: int | None,
    *,
    fen: str = "fen",
    eval_mate: int | None = None,
    shallow_mate: int | None = None,
) -> Analysis:
    return Analysis(fen, eval_cp, eval_mate, shallow_cp, shallow_mate, 10)


def test_the_defaults_are_a_three_pawn_ceiling_and_a_one_pawn_swing() -> None:
    assert DEFAULTS.as_dict() == {"eval_ceiling_cp": 300, "max_swing_cp": 100}


# Eval ceiling


@pytest.mark.parametrize("eval_cp", [0, 299, 300, -300])
def test_an_eval_up_to_the_ceiling_is_kept(eval_cp: int) -> None:
    assert not exceeds_ceiling(position(eval_cp, eval_cp), DEFAULTS)


@pytest.mark.parametrize("eval_cp", [301, -301, 900])
def test_an_eval_beyond_the_ceiling_is_dropped(eval_cp: int) -> None:
    assert exceeds_ceiling(position(eval_cp, eval_cp), DEFAULTS)


@pytest.mark.parametrize("mate", [3, -1])
def test_every_mate_score_is_dropped(mate: int) -> None:
    assert exceeds_ceiling(position(None, 40, eval_mate=mate), DEFAULTS)


def test_the_ceiling_is_a_setting() -> None:
    assert exceeds_ceiling(position(250, 250), FilterSettings(eval_ceiling_cp=200))


# Stability


@pytest.mark.parametrize(("deep", "shallow"), [(50, 50), (50, 150), (50, -50), (-120, -20)])
def test_a_swing_up_to_the_threshold_is_kept(deep: int, shallow: int) -> None:
    assert not is_unstable(position(deep, shallow), DEFAULTS)


@pytest.mark.parametrize(("deep", "shallow"), [(50, 151), (50, -51), (280, 20)])
def test_a_swing_beyond_the_threshold_is_dropped(deep: int, shallow: int) -> None:
    assert is_unstable(position(deep, shallow), DEFAULTS)


def test_a_mate_only_the_shallow_search_saw_is_unstable() -> None:
    assert is_unstable(position(40, None, shallow_mate=2), DEFAULTS)


def test_crossing_a_band_edge_alone_does_not_drop_a_position() -> None:
    # 0.95 shallow and 1.05 deep fall either side of the 1-pawn edge; the deep eval decides the band.
    assert not is_unstable(position(105, 95), DEFAULTS)


def test_the_stability_threshold_is_a_setting() -> None:
    assert is_unstable(position(50, 90), FilterSettings(max_swing_cp=30))


def test_stability_refuses_a_mate_score() -> None:
    with pytest.raises(ValueError, match="eval ceiling"):
        is_unstable(position(None, 40, eval_mate=3), DEFAULTS)


# Both filters


def test_filters_run_in_order_and_report_what_each_removed() -> None:
    analyses = [
        position(30, 20, fen="a"),
        position(None, 50, fen="b", eval_mate=4),  # ceiling
        position(-350, -340, fen="c"),  # ceiling, though stable
        position(400, 100, fen="d"),  # ceiling, though also unstable: counted once, by the first filter
        position(150, 10, fen="e"),  # stability
        position(-200, -210, fen="f"),
    ]
    kept, report = apply_filters(analyses, DEFAULTS)
    assert [analysis.fen for analysis in kept] == ["a", "f"]
    assert report.as_dict() == {
        "analysed": 6,
        "removed_by_eval_ceiling": 3,
        "removed_by_stability": 1,
        "kept": 2,
    }


# Files


def write_run(directory: Path, candidates: list[str], analyses: list[Analysis]) -> tuple[Path, Path]:
    candidates_path = directory / "candidates.tsv"
    candidates_path.write_text("".join(f"{fen}\t4\t2\t0.0001\n" for fen in candidates), encoding="utf-8")
    sha = hashlib.sha256(candidates_path.read_bytes()).hexdigest()
    analysis_path = directory / "analysis.jsonl"
    run = {"candidates_sha256": sha, "engine": {"engine_bench": 1}, "search": {"nodes": 100}}
    lines = [json.dumps({"run": run})] + [analysis.to_json() for analysis in analyses]
    analysis_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return candidates_path, analysis_path


def test_the_analysis_is_read_in_candidate_order(tmp_path: Path) -> None:
    candidates, analysis = write_run(tmp_path, ["b", "a"], [position(1, 1, fen="a"), position(2, 2, fen="b")])
    _, analyses = read_complete_analysis(candidates, analysis)
    assert [result.fen for result in analyses] == ["b", "a"]


def test_an_unfinished_analysis_is_refused(tmp_path: Path) -> None:
    candidates, analysis = write_run(tmp_path, ["a", "b"], [position(1, 1, fen="a")])
    with pytest.raises(FilterRefused, match="1 of 2 candidates are not yet analysed"):
        read_complete_analysis(candidates, analysis)


def test_an_analysis_of_other_candidates_is_refused(tmp_path: Path) -> None:
    candidates, analysis = write_run(tmp_path, ["a"], [position(1, 1, fen="a")])
    candidates.write_text("a\t4\t3\t0.0002\n", encoding="utf-8")
    with pytest.raises(FilterRefused, match="was not run on"):
        read_complete_analysis(candidates, analysis)


def test_the_command_writes_the_kept_positions_settings_and_report(tmp_path: Path) -> None:
    analyses = [position(30, 20, fen="a"), position(500, 500, fen="b"), position(80, -40, fen="c")]
    candidates, analysis = write_run(tmp_path, ["a", "b", "c"], analyses)
    output = tmp_path / "filtered.jsonl"
    assert main([str(candidates), str(analysis), str(output), "--max-swing-cp", "150"]) == 0
    header, kept = read_filtered(output)
    assert header["filters"] == {"eval_ceiling_cp": 300, "max_swing_cp": 150}
    assert header["run"]["engine"] == {"engine_bench": 1}
    assert kept == [analyses[0], analyses[2]]
    report = json.loads((tmp_path / "filtered.jsonl.report.json").read_text(encoding="utf-8"))
    assert report == {
        "filters": {"eval_ceiling_cp": 300, "max_swing_cp": 150},
        "analysed": 3,
        "removed_by_eval_ceiling": 1,
        "removed_by_stability": 0,
        "kept": 2,
    }


def test_the_command_refuses_an_unfinished_analysis(tmp_path: Path) -> None:
    candidates, analysis = write_run(tmp_path, ["a", "b"], [position(1, 1, fen="a")])
    assert main([str(candidates), str(analysis), str(tmp_path / "out.jsonl")]) == 1
    assert not (tmp_path / "out.jsonl").exists()


def test_reading_an_analysis_as_a_filtered_file_is_refused(tmp_path: Path) -> None:
    _, analysis = write_run(tmp_path, ["a"], [position(1, 1, fen="a")])
    with pytest.raises(ValueError, match="not a filtered file"):
        read_filtered(analysis)
