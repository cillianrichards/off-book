"""Filters (P1-06): drop analysed positions whose eval is too large or too unstable to price a game.

Two filters run in order, and the report says how many positions each removed:

- Eval ceiling: a position is dropped when its deep eval is a mate score, or its absolute eval is above
  the ceiling (3 pawns by default).
- Stability: a position is dropped when its eval moves by more than the stability threshold (100
  centipawns, about 64 rating points, by default) between the shallow and deep searches, or when the shallow
  search found a mate the deep one did not. The threshold is loose on purpose: it removes only the most
  extreme swings (decided 24 November 2026). A position whose two evals fall either side of a band edge is
  kept, since its band is decided by the deep eval alone.

The best-move gap is kept with every position, unfiltered, for the monthly check to use.

Filtering needs the whole analysis: the candidates file is read again, and the run refuses if it is not the
file the analysis was run on or if any candidate has not been analysed. Every threshold is a filter
setting, written with the output.

The output is JSON Lines: a header recording the analysis run and the filter settings, then the positions
kept, in candidate order. A report beside it, `OUTPUT.report.json`, gives the counts.

Run with `python -m off_book_pipeline.filters CANDIDATES ANALYSIS OUTPUT`.
"""

import argparse
import json
import sys
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from off_book_pipeline.analyse import Analysis, read_candidates, read_results


@dataclass(frozen=True)
class FilterSettings:
    eval_ceiling_cp: int = 300
    """Positions with an absolute eval above this are dropped; one exactly at it is kept."""

    max_swing_cp: int = 100
    """Positions whose eval moves by more than this between the shallow and deep searches are dropped."""

    def __post_init__(self) -> None:
        if self.eval_ceiling_cp < 0 or self.max_swing_cp < 0:
            raise ValueError("Filter thresholds cannot be negative.")

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class FilterReport:
    analysed: int
    removed_by_eval_ceiling: int
    removed_by_stability: int
    kept: int

    def as_dict(self) -> dict[str, int]:
        return asdict(self)


class FilterRefused(Exception):
    """The analysis does not cover the candidates, so filtering it would understate the pool."""


def exceeds_ceiling(analysis: Analysis, settings: FilterSettings) -> bool:
    if analysis.eval_cp is None:
        return True  # a mate score
    return abs(analysis.eval_cp) > settings.eval_ceiling_cp


def is_unstable(analysis: Analysis, settings: FilterSettings) -> bool:
    """Whether the eval moves too far between searches. Call only on positions within the ceiling."""
    if analysis.eval_cp is None:
        raise ValueError(f"{analysis.fen} has a mate score; the eval ceiling removes it first.")
    if analysis.shallow_eval_cp is None:
        return True  # the shallow search saw a mate the deep search did not
    return abs(analysis.eval_cp - analysis.shallow_eval_cp) > settings.max_swing_cp


def apply_filters(
    analyses: Sequence[Analysis], settings: FilterSettings
) -> tuple[list[Analysis], FilterReport]:
    """The positions that pass both filters, in the order given, and how many each filter removed."""
    within_ceiling = [analysis for analysis in analyses if not exceeds_ceiling(analysis, settings)]
    kept = [analysis for analysis in within_ceiling if not is_unstable(analysis, settings)]
    report = FilterReport(
        analysed=len(analyses),
        removed_by_eval_ceiling=len(analyses) - len(within_ceiling),
        removed_by_stability=len(within_ceiling) - len(kept),
        kept=len(kept),
    )
    return kept, report


def read_complete_analysis(
    candidates_path: Path, analysis_path: Path
) -> tuple[dict[str, Any], list[Analysis]]:
    """The analysis run's header and every candidate's result, in candidate order.

    Refuses when the analysis was run on another candidates file or has not finished.
    """
    fens, candidates_sha256 = read_candidates(candidates_path)
    run, results = read_results(analysis_path)
    if run.get("candidates_sha256") != candidates_sha256:
        raise FilterRefused(f"{analysis_path} was not run on {candidates_path}.")
    missing = [fen for fen in fens if fen not in results]
    if missing:
        raise FilterRefused(
            f"{len(missing)} of {len(fens)} candidates are not yet analysed; finish the analysis first."
        )
    return run, [results[fen] for fen in fens]


def write_filtered(
    path: Path, run: dict[str, Any], settings: FilterSettings, kept: Iterable[Analysis], report: FilterReport
) -> Path:
    """Write the kept positions and the report beside them. Returns the report's path."""
    header = {"run": run, "filters": settings.as_dict()}
    with path.open("w", encoding="utf-8", newline="\n") as output:
        output.write(json.dumps(header, separators=(",", ":"), sort_keys=True) + "\n")
        for analysis in kept:
            output.write(analysis.to_json() + "\n")
    report_path = path.with_name(path.name + ".report.json")
    report_path.write_text(
        json.dumps({"filters": settings.as_dict(), **report.as_dict()}, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return report_path


def read_filtered(path: Path) -> tuple[dict[str, Any], list[Analysis]]:
    """A filtered file's header and its positions."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError(f"{path} has no header.")
    header: dict[str, Any] = json.loads(lines[0])
    if "filters" not in header:
        raise ValueError(f"{path} is not a filtered file from off_book_pipeline.filters.")
    return header, [Analysis.from_json(json.loads(line)) for line in lines[1:] if line]


def main(argv: Iterable[str] | None = None) -> int:
    defaults = FilterSettings()
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.filters",
        description="Apply the eval ceiling and stability filters to a finished analysis.",
    )
    parser.add_argument("candidates", type=Path, help="the candidates file the analysis was run on")
    parser.add_argument("analysis", type=Path, help="results from off_book_pipeline.analyse")
    parser.add_argument("output", type=Path, help="positions kept (JSON Lines), with a report beside it")
    parser.add_argument(
        "--eval-ceiling-cp", type=int, default=defaults.eval_ceiling_cp, help="largest absolute eval kept"
    )
    parser.add_argument(
        "--max-swing-cp", type=int, default=defaults.max_swing_cp, help="largest shallow-to-deep move kept"
    )
    args = parser.parse_args(None if argv is None else list(argv))
    try:
        settings = FilterSettings(args.eval_ceiling_cp, args.max_swing_cp)
    except ValueError as error:
        parser.error(str(error))
    try:
        run, analyses = read_complete_analysis(args.candidates, args.analysis)
    except FilterRefused as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    kept, report = apply_filters(analyses, settings)
    report_path = write_filtered(args.output, run, settings, kept, report)
    print(
        f"{report.analysed} analysed: {report.removed_by_eval_ceiling} removed by the eval ceiling, "
        f"{report.removed_by_stability} by stability, {report.kept} kept in {args.output}; "
        f"report in {report_path}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
