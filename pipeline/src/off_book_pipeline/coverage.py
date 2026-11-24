"""Band coverage (P1-07) and the Phase 1 exit test (P1-09) over the filtered positions.

Positions fall into two bands by the size of their deep eval (decided 24 November 2026):

- Balanced: absolute eval under 1 pawn. Players take no side, and colour is a fair coin.
- Winning and Losing: absolute eval from 1 pawn to the ceiling. Both options draw from the same positions,
  so they are one band here.

The report counts each band's positions and how many favour White, favour Black or are exactly level. The
colour split is reported, not tested: no colour balancing depends on it (D-13).

Run with `python -m off_book_pipeline.coverage FILTERED`, on the output of `off_book_pipeline.filters`.
"""

import argparse
import json
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path

from off_book_pipeline.analyse import Analysis
from off_book_pipeline.filters import read_filtered

BALANCED_BELOW_CP = 100
"""The edge between the bands: a position at exactly 1 pawn is in Winning and Losing."""


class Band(StrEnum):
    BALANCED = "Balanced"
    WINNING_LOSING = "Winning and Losing"


def band_of(analysis: Analysis) -> Band:
    if analysis.eval_cp is None:
        raise ValueError(f"{analysis.fen} has a mate score; filter the positions first.")
    return Band.BALANCED if abs(analysis.eval_cp) < BALANCED_BELOW_CP else Band.WINNING_LOSING


@dataclass(frozen=True)
class BandCoverage:
    positions: int
    white_better: int
    black_better: int
    level: int


def band_coverage(analyses: Sequence[Analysis]) -> dict[Band, BandCoverage]:
    """Positions in each band, split by which colour is better. Every band appears, even when empty."""
    counts = {band: [0, 0, 0] for band in Band}
    for analysis in analyses:
        row = counts[band_of(analysis)]
        assert analysis.eval_cp is not None  # band_of refuses mate scores
        row[0 if analysis.eval_cp > 0 else 1 if analysis.eval_cp < 0 else 2] += 1
    return {
        band: BandCoverage(sum(row), white_better=row[0], black_better=row[1], level=row[2])
        for band, row in counts.items()
    }


def coverage_report(coverage: dict[Band, BandCoverage]) -> dict[str, dict[str, int]]:
    return {band.value: asdict(row) for band, row in coverage.items()}


def format_coverage(coverage: dict[Band, BandCoverage]) -> str:
    lines = []
    for band, row in coverage.items():
        white_share = f"{row.white_better / row.positions:.0%}" if row.positions else "n/a"
        lines.append(
            f"{band.value}: {row.positions} positions; White better in {row.white_better} ({white_share}), "
            f"Black in {row.black_better}, level in {row.level}."
        )
    return "\n".join(lines)


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.coverage",
        description="Count filtered positions per band, split by which colour is better.",
    )
    parser.add_argument("filtered", type=Path, help="output of off_book_pipeline.filters")
    args = parser.parse_args(None if argv is None else list(argv))
    header, analyses = read_filtered(args.filtered)
    coverage = band_coverage(analyses)
    report_path = args.filtered.with_name(args.filtered.name + ".coverage.json")
    report = {"filters": header["filters"], "bands": coverage_report(coverage)}
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(format_coverage(coverage))
    print(f"Report in {report_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
