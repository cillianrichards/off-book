"""Rare positions from games (P1-02): candidates are where real games leave commonly played positions.

Every position a game passes through is counted once for that game, wherever it occurs, so a position's
count is the number of games that reach it by any move order. A position is common when at least
`rare_below_percent` of games reach it, and rare otherwise. A candidate is a rare position reached by at
least `min_games` games that at least one game enters straight from a common position, at ply `min_ply`
or later (decided 1 November 2026). It therefore sits where a line leaves common play: a rare position
further down a line that has already left common play is not a candidate, and nor is anything on a line
that leaves common play too early, such as 1.Na3.

A position is identified as FIDE's repetition rule identifies it: the pieces, the side to move, castling
rights, and an en passant square only when a capture is legal. Move order and move counters play no part.
Positions are keyed by a 64-bit hash, so two positions sharing a key would be counted together; among the
tens of millions of positions in a collection, the chance of that happening at all is about one in ten
thousand.

Counting runs in two stages so that collections of millions of games fit in memory. Reading the games
writes each game's positions, as hashes, to a cache on disk; numpy then counts them. Only the first
`count_plies` plies of each game are counted. Lines leave common play long before that, and the run
refuses to finish if a common position appears so late that the limit could hide a candidate.

Only masters games count: both players must be rated at least `min_rating` (2200, as in Lichess's masters
database), and games without both ratings are skipped. A game recorded twice in the collection (same
players, date and moves) counts once. Games from a set-up position or another variant, games with an
illegal move and games with no moves are skipped.

Run with `python -m off_book_pipeline.collect OUTPUT PGN [PGN ...]`.
"""

import argparse
import bz2
import gzip
import hashlib
import io
import json
import lzma
import sys
import tempfile
import zipfile
from array import array
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from pathlib import Path
from typing import IO, Any, TextIO, cast

import chess
import chess.pgn
import numpy as np
import numpy.typing as npt

Int64Array = npt.NDArray[np.int64]


@dataclass(frozen=True)
class CollectSettings:
    """The filter settings that decide which positions are candidates. Recorded with every run."""

    min_games: int = 2
    rare_below_percent: str = "0.05"
    """A position is rare when fewer than this percentage of games reach it. A string, so it is exact."""
    min_ply: int = 4
    count_plies: int = 60
    min_rating: int | None = 2200
    """Both players must be rated at least this; None counts every game, rated or not."""

    def __post_init__(self) -> None:
        try:
            percent = Decimal(self.rare_below_percent)
        except InvalidOperation as error:
            raise ValueError(f"{self.rare_below_percent!r} is not a percentage.") from error
        if not 0 < percent <= 100:
            raise ValueError("The rarity threshold must be above 0% and at most 100%.")
        if self.min_games < 1:
            raise ValueError("A candidate must be reached by at least one game.")
        if self.min_ply < 1:
            raise ValueError("The minimum ply must be at least 1.")
        if self.count_plies <= self.min_ply:
            raise ValueError("Positions must be counted beyond the minimum ply.")
        if self.count_plies > 255:
            raise ValueError("At most 255 plies per game can be counted.")
        if self.min_rating is not None and self.min_rating < 1:
            raise ValueError("The minimum rating must be positive, or None to count every game.")

    def common_from(self, games: int) -> int:
        """The fewest games that make a position common, out of `games`: rare is anything below it."""
        threshold = Decimal(self.rare_below_percent) * games / 100
        return max(1, int(threshold.to_integral_value(rounding=ROUND_CEILING)))

    def as_dict(self) -> dict[str, int | str | None]:
        return asdict(self)


@dataclass(frozen=True)
class Candidate:
    fen: str
    ply: int
    """The earliest ply at which any game reached the position."""
    games: int
    share: float
    """The share of games reaching the position: its rarity score."""

    def to_line(self) -> str:
        return f"{self.fen}\t{self.ply}\t{self.games}\t{self.share!r}"


class CollectRefused(Exception):
    """The collection cannot give a trustworthy set of candidates with these settings."""


def position_key(board: chess.Board) -> int:
    """A 64-bit key for the position as FIDE's repetition rule sees it."""
    en_passant = board.ep_square if board.ep_square is not None and board.has_legal_en_passant() else -1
    return hash(
        (
            board.pawns,
            board.knights,
            board.bishops,
            board.rooks,
            board.queens,
            board.kings,
            board.occupied_co[chess.WHITE],
            board.turn,
            board.clean_castling_rights(),
            en_passant,
        )
    )


def _encode(move: chess.Move) -> int:
    return move.from_square | move.to_square << 6 | (move.promotion or 0) << 12


def _decode(code: int) -> chess.Move:
    return chess.Move(code & 63, code >> 6 & 63, (code >> 12) or None)


# Reading games


@dataclass
class _Game:
    headers: dict[str, str] = field(default_factory=dict)
    tokens: list[str] = field(default_factory=list)
    keys: list[int] = field(default_factory=list)
    moves: list[int] = field(default_factory=list)
    unreadable: bool = False
    set_up: bool = False
    rating: str = ""
    """Why the ratings exclude the game: "unrated", "below", or empty if they do not."""


class _GameReader(chess.pgn.BaseVisitor[_Game]):
    """Reads the headers and main line of one game, keying each position up to `count_plies`.

    Moves after that are not parsed, only noted for spotting duplicate games, which keeps reading fast.
    """

    def __init__(self, count_plies: int, min_rating: int | None) -> None:
        self.count_plies = count_plies
        self.min_rating = min_rating
        self.game = _Game()

    def begin_game(self) -> None:
        self.game = _Game()

    def visit_header(self, tagname: str, tagvalue: str) -> None:
        self.game.headers[tagname] = tagvalue

    def end_headers(self) -> chess.pgn.SkipType | None:
        headers = self.game.headers
        variant = headers.get("Variant", "").strip().lower()
        if "FEN" in headers or headers.get("SetUp") == "1" or variant not in ("", "standard", "chess"):
            self.game.set_up = True
            return chess.pgn.SKIP
        if self.min_rating is not None:
            ratings = [_rating(headers.get("WhiteElo")), _rating(headers.get("BlackElo"))]
            if None in ratings:
                self.game.rating = "unrated"
            elif min(r for r in ratings if r is not None) < self.min_rating:
                self.game.rating = "below"
            if self.game.rating:
                return chess.pgn.SKIP  # moves are not parsed for a game that will not count
        return None

    def begin_variation(self) -> chess.pgn.SkipType | None:
        return chess.pgn.SKIP

    def begin_parse_san(self, board: chess.Board, san: str) -> chess.pgn.SkipType | None:
        self.game.tokens.append(san.rstrip("+#!?"))
        return chess.pgn.SKIP if len(self.game.moves) >= self.count_plies else None

    def visit_move(self, board: chess.Board, move: chess.Move) -> None:
        self.game.moves.append(_encode(move))

    def visit_board(self, board: chess.Board) -> None:
        # Called for the start and after every move token, including those not parsed.
        if len(self.game.keys) == len(self.game.moves):
            self.game.keys.append(position_key(board))

    def handle_error(self, error: Exception) -> None:
        self.game.unreadable = True

    def result(self) -> _Game:
        return self.game


def _rating(value: str | None) -> int | None:
    """A rating header as a number, or None when it is missing, unknown ("?" or "-") or zero."""
    try:
        rating = int((value or "").strip())
    except ValueError:
        return None
    return rating if rating > 0 else None


def _texts(path: Path) -> Iterator[TextIO]:
    """The PGN text in a file: plain, gzip, bzip2, xz, or every .pgn in a zip."""
    name = path.name.lower()
    if name.endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            for member in sorted(archive.namelist()):
                if member.lower().endswith(".pgn"):
                    with archive.open(member) as raw:
                        yield io.TextIOWrapper(raw, encoding="utf-8", errors="replace")
        return
    opener: Callable[..., IO[str]]
    if name.endswith(".gz"):
        opener = gzip.open
    elif name.endswith(".bz2"):
        opener = bz2.open
    elif name.endswith(".xz"):
        opener = lzma.open
    else:
        opener = open
    with opener(path, "rt", encoding="utf-8", errors="replace") as text:
        yield cast(TextIO, text)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


class _Cache:
    """Per-position arrays on disk: key, ply, whether it is the game's first visit, and the move to it."""

    FLUSH_AT = 1 << 20

    def __init__(self, directory: Path) -> None:
        self.paths = {name: directory / f"{name}.bin" for name in ("keys", "plies", "first", "moves")}
        self.buffers: dict[str, array[int]] = {}
        self._reset()
        self.size = 0
        self.game_starts: array[int] = array("q")

    def _reset(self) -> None:
        self.buffers = {"keys": array("q"), "plies": array("B"), "first": array("B"), "moves": array("H")}

    def add(self, game: _Game) -> None:
        self.game_starts.append(self.size)
        seen: set[int] = set()
        for ply, key in enumerate(game.keys):
            self.buffers["keys"].append(key)
            self.buffers["plies"].append(ply)
            self.buffers["first"].append(key not in seen)
            self.buffers["moves"].append(game.moves[ply - 1] if ply else 0)
            seen.add(key)
        self.size += len(game.keys)
        if len(self.buffers["keys"]) >= self.FLUSH_AT:
            self.flush()

    def flush(self) -> None:
        for name, buffer in self.buffers.items():
            with self.paths[name].open("ab") as file:
                buffer.tofile(file)
        self._reset()

    def arrays(self) -> dict[str, np.ndarray[Any, Any]]:
        self.flush()
        dtypes = {"keys": np.int64, "plies": np.uint8, "first": np.uint8, "moves": np.uint16}
        return {name: np.memmap(self.paths[name], dtype=dtypes[name], mode="r") for name in dtypes}


@dataclass
class _GameTally:
    read: int = 0
    accepted: int = 0
    duplicates: int = 0
    set_up_or_variant: int = 0
    unrated: int = 0
    below_min_rating: int = 0
    unreadable: int = 0
    no_moves: int = 0


def _read_games(
    sources: Sequence[Path], cache: _Cache, settings: CollectSettings, progress: Callable[[int], None] | None
) -> _GameTally:
    tally = _GameTally()
    identities: set[int] = set()
    for source in sources:
        for text in _texts(source):
            while (
                game := chess.pgn.read_game(
                    text, Visitor=lambda: _GameReader(settings.count_plies, settings.min_rating)
                )
            ) is not None:
                tally.read += 1
                if progress is not None and tally.read % 100_000 == 0:
                    progress(tally.read)
                if game.set_up:
                    tally.set_up_or_variant += 1
                    continue
                if game.rating == "unrated":
                    tally.unrated += 1
                    continue
                if game.rating == "below":
                    tally.below_min_rating += 1
                    continue
                if game.unreadable:
                    tally.unreadable += 1
                    continue
                if not game.tokens:
                    tally.no_moves += 1
                    continue
                headers = game.headers
                players_date = (headers.get("White"), headers.get("Black"), headers.get("Date"))
                identity = hash((*players_date, tuple(game.tokens)))
                if identity in identities:
                    tally.duplicates += 1
                    continue
                identities.add(identity)
                cache.add(game)
                tally.accepted += 1
    return tally


# Counting and selecting


def _count_games(keys: Int64Array, first: np.ndarray[Any, Any]) -> tuple[Int64Array, Int64Array]:
    """Keys reached by at least two games, sorted, and how many games reach each."""
    chunk = 8_000_000
    partitions = 1 + len(keys) // 40_000_000
    found_keys, found_counts = [], []
    for partition in range(partitions):
        selected = []
        for start in range(0, len(keys), chunk):
            block = np.asarray(keys[start : start + chunk])
            mask = np.asarray(first[start : start + chunk]).astype(bool)
            if partitions > 1:
                mask &= block.view(np.uint64) % np.uint64(partitions) == partition
            selected.append(block[mask])
        unique, counts = np.unique(np.concatenate(selected), return_counts=True)
        repeated = counts >= 2
        found_keys.append(unique[repeated])
        found_counts.append(counts[repeated].astype(np.int64))
    all_keys, all_counts = np.concatenate(found_keys), np.concatenate(found_counts)
    order = np.argsort(all_keys)
    return all_keys[order], all_counts[order]


def _lookup(sorted_keys: Int64Array, counts: Int64Array, keys: Int64Array) -> Int64Array:
    """How many games reach each key: keys missing from the table were reached by exactly one."""
    if len(sorted_keys) == 0:
        return np.ones(len(keys), dtype=np.int64)
    index = np.minimum(np.searchsorted(sorted_keys, keys), len(sorted_keys) - 1)
    return np.where(sorted_keys[index] == keys, counts[index], 1)


@dataclass(frozen=True)
class Collection:
    settings: CollectSettings
    candidates: list[Candidate]
    report: dict[str, Any]
    _sorted_keys: Int64Array
    _counts: Int64Array
    _single_keys: frozenset[int] | None

    def games_reaching(self, board: chess.Board) -> int:
        """How many games pass through the board's position, wherever in the game."""
        key = position_key(board)
        index = int(np.searchsorted(self._sorted_keys, key))
        if index < len(self._sorted_keys) and int(self._sorted_keys[index]) == key:
            return int(self._counts[index])
        if self._single_keys is None:
            raise RuntimeError("Collect with keep_single_keys=True to tell one game from none.")
        return int(key in self._single_keys)


def collect(
    sources: Sequence[Path],
    settings: CollectSettings,
    *,
    work_dir: Path | None = None,
    progress: Callable[[int], None] | None = None,
    keep_single_keys: bool = False,
) -> Collection:
    """Count positions across the games in `sources` and return the candidates for P1-03 to analyse."""
    with tempfile.TemporaryDirectory(dir=work_dir, prefix="off-book-collect-") as directory:
        cache = _Cache(Path(directory))
        tally = _read_games(sources, cache, settings, progress)
        if tally.accepted == 0:
            raise CollectRefused("No usable games were found.")
        arrays = cache.arrays()
        keys, plies, first, moves = arrays["keys"], arrays["plies"], arrays["first"], arrays["moves"]
        game_starts = np.frombuffer(cache.game_starts, dtype=np.int64)
        sorted_keys, counts = _count_games(keys, first)
        common_from = settings.common_from(tally.accepted)

        entered: list[Int64Array] = []
        entered_late: list[Int64Array] = []
        deepest_common = -1
        chunk = 8_000_000
        for start in range(0, len(keys), chunk):
            stop = min(start + chunk, len(keys))
            block = np.asarray(keys[start:stop])
            block_plies = np.asarray(plies[start:stop]).astype(np.int64)
            block_counts = _lookup(sorted_keys, counts, block)
            common = block_counts >= common_from
            if common.any():
                deepest_common = max(deepest_common, int(block_plies[common].max()))
            # A position's parent is the one before it in the same game; ply 0 starts a new game.
            parent_counts = np.empty(stop - start, dtype=np.int64)
            parent_counts[1:] = block_counts[:-1]
            previous = np.asarray(keys[max(start - 1, 0) : start], dtype=np.int64)
            parent_counts[0] = _lookup(sorted_keys, counts, previous)[0] if start else 0
            from_common = (block_plies > 0) & (parent_counts >= common_from)
            entered.append(block[from_common])
            entered_late.append(block[from_common & (block_plies >= settings.min_ply)])

        if deepest_common >= settings.count_plies:
            raise CollectRefused(
                f"A common position appears at ply {deepest_common}, at the counting limit of "
                f"{settings.count_plies}, so candidates beyond it could be missed. Raise count_plies."
            )

        entered_keys = np.unique(np.concatenate(entered))
        late_keys = np.unique(np.concatenate(entered_late))
        entered_counts = _lookup(sorted_keys, counts, entered_keys)
        still_common = entered_counts >= common_from
        below_floor = ~still_common & (entered_counts < settings.min_games)
        too_early = ~still_common & ~below_floor & ~np.isin(entered_keys, late_keys)
        survivors = entered_keys[~still_common & ~below_floor & ~too_early]

        candidates, no_legal_moves = _recover(
            survivors, keys, plies, moves, game_starts, sorted_keys, counts, tally.accepted
        )
        report = {
            "settings": settings.as_dict(),
            "sources": [{"name": s.name, "bytes": s.stat().st_size, "sha256": _sha256(s)} for s in sources],
            "games": asdict(tally),
            "positions_counted": len(keys),
            "positions_reached_by_two_or_more_games": len(sorted_keys),
            "common_from_games": common_from,
            "common_positions": int(np.count_nonzero(counts >= common_from)),
            "deepest_common_ply": deepest_common,
            "entered_from_common": len(entered_keys),
            "removed": {
                "still_common": int(np.count_nonzero(still_common)),
                "below_min_games": int(np.count_nonzero(below_floor)),
                "before_min_ply": int(np.count_nonzero(too_early)),
                "no_legal_moves": no_legal_moves,
            },
            "candidates": len(candidates),
        }
        single_keys = None
        if keep_single_keys:  # memory grows with the collection, so only for small ones
            visited = np.asarray(keys)[np.asarray(first).astype(bool)]
            single_keys = frozenset(int(k) for k in np.setdiff1d(visited, sorted_keys))
        return Collection(settings, candidates, report, sorted_keys.copy(), counts.copy(), single_keys)


def _recover(
    survivors: Int64Array,
    keys: np.ndarray[Any, Any],
    plies: np.ndarray[Any, Any],
    moves: np.ndarray[Any, Any],
    game_starts: Int64Array,
    sorted_keys: Int64Array,
    counts: Int64Array,
    games_counted: int,
) -> tuple[list[Candidate], int]:
    """Replay one earliest occurrence of each surviving key to give its FEN, dropping finished positions."""
    if len(survivors) == 0:
        return [], 0
    earliest: dict[int, tuple[int, int]] = {}  # key -> (ply, index of an occurrence at that ply)
    chunk = 8_000_000
    for start in range(0, len(keys), chunk):
        block = np.asarray(keys[start : start + chunk])
        hits = np.nonzero(np.isin(block, survivors))[0]
        for offset in hits:
            key, ply = int(block[offset]), int(plies[start + offset])
            if key not in earliest or ply < earliest[key][0]:
                earliest[key] = (ply, start + int(offset))
    candidates, no_legal_moves = [], 0
    for key, (ply, index) in earliest.items():
        game_start = int(game_starts[np.searchsorted(game_starts, index, side="right") - 1])
        board = chess.Board()
        for code in moves[game_start + 1 : index + 1]:
            board.push(_decode(int(code)))
        if not any(board.legal_moves):
            no_legal_moves += 1
            continue
        games = int(_lookup(sorted_keys, counts, np.array([key], dtype=np.int64))[0])
        fen = f"{board.epd(en_passant='legal')} 0 {ply // 2 + 1}"
        candidates.append(Candidate(fen, ply, games, games / games_counted))
    candidates.sort(key=lambda candidate: candidate.fen)
    return candidates, no_legal_moves


def main(argv: Sequence[str] | None = None) -> int:
    defaults = CollectSettings()
    parser = argparse.ArgumentParser(
        prog="python -m off_book_pipeline.collect",
        description="Find candidate positions where games leave commonly played positions.",
    )
    parser.add_argument("output", type=Path, help="candidates file: FEN, ply, games and share, tab-separated")
    parser.add_argument("sources", type=Path, nargs="+", help="PGN files: plain, .gz, .bz2, .xz or .zip")
    parser.add_argument("--min-games", type=int, default=defaults.min_games)
    parser.add_argument("--rare-below", default=defaults.rare_below_percent, help="percentage of games")
    parser.add_argument("--min-ply", type=int, default=defaults.min_ply)
    parser.add_argument("--count-plies", type=int, default=defaults.count_plies)
    parser.add_argument(
        "--min-rating", type=int, default=defaults.min_rating, help="both players; 0 counts every game"
    )
    parser.add_argument(
        "--work-dir", type=Path, help="where to keep the temporary cache (default: system temp)"
    )
    args = parser.parse_args(argv)
    try:
        min_rating = args.min_rating or None
        settings = CollectSettings(
            args.min_games, args.rare_below, args.min_ply, args.count_plies, min_rating
        )
    except ValueError as error:
        parser.error(str(error))

    def report_progress(games: int) -> None:
        print(f"{games:,} games read.", file=sys.stderr)

    try:
        collection = collect(args.sources, settings, work_dir=args.work_dir, progress=report_progress)
    except CollectRefused as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    args.output.write_text(
        "".join(f"{candidate.to_line()}\n" for candidate in collection.candidates),
        encoding="utf-8",
        newline="\n",
    )
    report_path = args.output.with_name(args.output.name + ".report.json")
    report_path.write_text(json.dumps(collection.report, indent=2) + "\n", encoding="utf-8", newline="\n")
    games, removed = collection.report["games"], collection.report["removed"]
    print(
        f"{games['accepted']:,} games counted ({games['duplicates']:,} duplicates skipped); "
        f"{collection.report['entered_from_common']:,} positions entered from common ones: "
        f"{removed['still_common']:,} still common, "
        f"{removed['below_min_games']:,} below {settings.min_games} games, "
        f"{removed['before_min_ply']:,} before ply {settings.min_ply}, "
        f"{removed['no_legal_moves']:,} finished; "
        f"{len(collection.candidates):,} candidates written to {args.output}, report in {report_path}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
