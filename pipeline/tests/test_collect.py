"""P1-02: candidates are rare positions where games leave commonly played positions.

The done test runs against a small hand-made collection whose counts were worked out by hand. It has 20
usable games, and the threshold is 20%, so a position is common when at least 4 games reach it.
"""

import bz2
import gzip
import json
import zipfile
from pathlib import Path

import chess
import pytest

from off_book_pipeline.analyse import read_candidates
from off_book_pipeline.collect import (
    Collection,
    CollectRefused,
    CollectSettings,
    collect,
    main,
)

# The hand-made games carry no ratings, so the masters filter is off for them.
SETTINGS = CollectSettings(min_games=2, rare_below_percent="20", min_ply=4, count_plies=60, min_rating=None)

GAMES = [
    # The Spanish trunk: common to move 3, then 3.Bb5 stays common and 3...a6 / 3...Nf6 leave common play.
    ("A1", "B1", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6"),
    ("A2", "B2", "e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6"),
    ("A3", "B3", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4"),
    ("A4", "B4", "e4 e5 Nf3 Nc6 Bb5 Nf6 d3 Bc5"),
    # 3.a3 leaves common play in two games, and a third game transposes into the same position.
    ("A5", "B5", "e4 e5 Nf3 Nc6 a3 a6 b3"),
    ("A6", "B6", "e4 e5 Nf3 Nc6 a3 h6"),
    ("A8", "B8", "e4 e5 a3 Nc6 Nf3 Nf6"),
    # 3.Na3 in one game, which also appears as a duplicate below.
    ("A7", "B7", "e4 e5 Nf3 Nc6 Na3 Nf6"),
    # 1.Na3 leaves common play at ply 1, too early; the line's later positions give nothing.
    ("A9", "B9", "Na3 e5 Nf3 Nc6 c3"),
    ("A10", "B10", "Na3 e5 Nf3 Nc6 d4"),
    # 1.f3 e5 2.g4 is common here: 2...Qh4# finishes the game, 2...d5 leaves common play.
    ("A11", "B11", "f3 e5 g4 Qh4#"),
    ("A12", "B12", "f3 e5 g4 Qh4#"),
    ("A13", "B13", "f3 e5 g4 d5 h3 Nc6"),
    ("A14", "B14", "f3 e5 g4 d5 h3 Nf6"),
    # 1.d4 is common; its second moves leave common play at ply 2, too early.
    ("A15", "B15", "d4 d5 c4 e6"),
    ("A16", "B16", "d4 d5 c4 c6"),
    ("A17", "B17", "d4 Nf6 c4 e6"),
    ("A18", "B18", "d4 Nf6 c4 g6"),
    # Knights out and back: the starting position again at ply 4, then 1.e4 e5 three moves late.
    ("A19", "B19", "Nf3 Nf6 Ng1 Ng8 e4 e5"),
    ("A20", "B20", "c4 e5"),
]


def pgn_game(white: str, black: str, moves: str, *, headers: str = "", result: str = "*") -> str:
    numbered = []
    for index, move in enumerate(moves.split()):
        numbered.append(f"{index // 2 + 1}. {move}" if index % 2 == 0 else move)
    return (
        f'[Event "Test"]\n[White "{white}"]\n[Black "{black}"]\n[Date "2026.01.01"]\n{headers}'
        f'[Result "{result}"]\n\n{" ".join(numbered)} {result}\n\n'
    )


def collection_text() -> str:
    text = "".join(pgn_game(white, black, moves) for white, black, moves in GAMES)
    text += pgn_game("A7", "B7", "e4 e5 Nf3 Nc6 Na3 Nf6")  # the same game, recorded twice
    text += pgn_game("S", "S", "e5", headers='[SetUp "1"]\n[FEN "8/8/8/8/4P3/8/8/K6k b - - 0 1"]\n')
    text += pgn_game("I", "I", "e4 e4")  # illegal: Black cannot play e4
    text += pgn_game("F", "F", "", result="1-0")  # a forfeit: no moves
    return text


@pytest.fixture(scope="module")
def pgn_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("collection") / "masters.pgn"
    path.write_text(collection_text(), encoding="utf-8")
    return path


@pytest.fixture(scope="module")
def collection(pgn_path: Path) -> Collection:
    return collect([pgn_path], SETTINGS, keep_single_keys=True)


def board_after(moves: str) -> chess.Board:
    board = chess.Board()
    for move in moves.split():
        board.push_san(move)
    return board


def fen_after(moves: str) -> str:
    board = board_after(moves)
    return f"{board.epd(en_passant='legal')} 0 {board.fullmove_number}"


def test_the_candidates_match_the_hand_count(collection: Collection) -> None:
    found = {(c.fen, c.ply, c.games) for c in collection.candidates}
    assert found == {
        (fen_after("e4 e5 Nf3 Nc6 Bb5 a6"), 6, 2),
        (fen_after("e4 e5 Nf3 Nc6 Bb5 Nf6"), 6, 2),
        (fen_after("e4 e5 Nf3 Nc6 a3"), 5, 3),
        (fen_after("f3 e5 g4 d5"), 4, 2),
    }
    assert fen_after("f3 e5 g4 d5") == "rnbqkbnr/ppp2ppp/8/3pp3/6P1/5P2/PPPPP2P/RNBQKBNR w KQkq - 0 3"
    assert [c.fen for c in collection.candidates] == sorted(c.fen for c in collection.candidates)
    assert all(c.share == c.games / 20 for c in collection.candidates)


def test_the_report_accounts_for_every_game_and_position(collection: Collection) -> None:
    report = collection.report
    assert report["games"] == {
        "read": 24,
        "accepted": 20,
        "duplicates": 1,
        "set_up_or_variant": 1,
        "unrated": 0,
        "below_min_rating": 0,
        "unreadable": 1,
        "no_moves": 1,
    }
    assert report["common_from_games"] == 4
    assert report["common_positions"] == 10
    assert report["deepest_common_ply"] == 6  # the knight-shuffle game reaches 1.e4 e5 at ply 6
    assert report["entered_from_common"] == 21
    assert report["removed"] == {
        "still_common": 9,
        "below_min_games": 4,
        "before_min_ply": 3,
        "no_legal_moves": 1,
    }
    assert report["candidates"] == 4


def test_a_transposition_counts_every_game_that_reaches_the_position(collection: Collection) -> None:
    # Two games play 3.a3; a third reaches the same position by 2.a3 Nc6 3.Nf3.
    assert collection.games_reaching(board_after("e4 e5 Nf3 Nc6 a3")) == 3
    assert collection.games_reaching(board_after("e4 e5 a3 Nc6 Nf3")) == 3
    # The knight-shuffle game reaches the position after 1.e4 at ply 5, and is counted there too.
    assert collection.games_reaching(board_after("e4")) == 9


def test_a_game_counts_once_however_often_it_repeats_a_position(collection: Collection) -> None:
    # The knight-shuffle game visits the starting position twice.
    assert collection.games_reaching(chess.Board()) == 20


def test_a_duplicate_game_counts_once(collection: Collection) -> None:
    # Counted twice, 3.Na3 would reach the 2-game floor and become a candidate.
    assert collection.games_reaching(board_after("e4 e5 Nf3 Nc6 Na3")) == 1
    assert fen_after("e4 e5 Nf3 Nc6 Na3") not in {c.fen for c in collection.candidates}


def test_the_starting_position_is_never_a_candidate(collection: Collection) -> None:
    fens = {c.fen for c in collection.candidates}
    assert fen_after("") not in fens
    assert fen_after("Nf3 Nf6 Ng1 Ng8").split()[:4] == fen_after("").split()[:4]
    assert not any(fen.split()[:4] == fen_after("").split()[:4] for fen in fens)


def test_a_rare_position_further_down_a_line_already_off_book_is_not_a_candidate(
    collection: Collection,
) -> None:
    # Two games reach 3.h3 after 2...d5, but 2...d5 had already left common play.
    deeper = board_after("f3 e5 g4 d5 h3")
    assert collection.games_reaching(deeper) == 2
    assert fen_after("f3 e5 g4 d5 h3") not in {c.fen for c in collection.candidates}


def test_a_line_leaving_common_play_before_the_minimum_ply_gives_no_candidate(collection: Collection) -> None:
    fens = {c.fen for c in collection.candidates}
    # 1.Na3 is rare and reached by two games, but at ply 1; so is everything after it.
    assert collection.games_reaching(board_after("Na3")) == 2
    assert collection.games_reaching(board_after("Na3 e5 Nf3 Nc6")) == 2
    assert fen_after("Na3") not in fens
    assert fen_after("Na3 e5 Nf3 Nc6") not in fens


def test_a_finished_position_is_not_a_candidate(collection: Collection) -> None:
    assert collection.games_reaching(board_after("f3 e5 g4 Qh4#")) == 2
    assert fen_after("f3 e5 g4 Qh4#") not in {c.fen for c in collection.candidates}


def test_a_position_no_game_reached_counts_zero(collection: Collection) -> None:
    assert collection.games_reaching(board_after("h4 h5")) == 0


def test_the_counting_limit_is_enforced(pgn_path: Path) -> None:
    # 1.e4 e5 is common, and the knight-shuffle game reaches it at ply 6:
    # counting only 6 plies could hide a candidate after it.
    with pytest.raises(CollectRefused, match="ply 6, at the counting limit of 6"):
        collect([pgn_path], CollectSettings(rare_below_percent="20", count_plies=6, min_rating=None))


def test_compressed_and_zipped_collections_give_the_same_candidates(
    tmp_path: Path, collection: Collection
) -> None:
    text = collection_text()
    gz, bz, zipped = tmp_path / "games.pgn.gz", tmp_path / "games.pgn.bz2", tmp_path / "games.zip"
    gz.write_bytes(gzip.compress(text.encode()))
    bz.write_bytes(bz2.compress(text.encode()))
    with zipfile.ZipFile(zipped, "w") as archive:
        archive.writestr("b.pgn", text[text.index('[Event "Test"]\n[White "A11"') :])
        archive.writestr("a.pgn", text[: text.index('[Event "Test"]\n[White "A11"')])
        archive.writestr("readme.txt", "not a game")
    for source in (gz, bz, zipped):
        assert collect([source], SETTINGS).candidates == collection.candidates


def test_games_from_several_files_count_together(tmp_path: Path, collection: Collection) -> None:
    text = collection_text()
    split = text.index('[Event "Test"]\n[White "A11"')
    first, second = tmp_path / "first.pgn", tmp_path / "second.pgn"
    first.write_text(text[:split], encoding="utf-8")
    second.write_text(text[split:], encoding="utf-8")
    assert collect([first, second], SETTINGS).candidates == collection.candidates


def test_a_collection_without_usable_games_is_refused(tmp_path: Path) -> None:
    empty = tmp_path / "empty.pgn"
    empty.write_text(pgn_game("F", "F", "", result="1-0"), encoding="utf-8")
    with pytest.raises(CollectRefused, match="No usable games"):
        collect([empty], SETTINGS)


def test_the_common_threshold_is_exact() -> None:
    settings = CollectSettings()
    assert settings.common_from(4000) == 2  # exactly 0.05%: 2 games are common, 1 is rare
    assert settings.common_from(4001) == 3
    assert settings.common_from(2_519_908) == 1260
    assert settings.as_dict() == {
        "min_games": 2,
        "rare_below_percent": "0.05",
        "min_ply": 4,
        "count_plies": 60,
        "min_rating": 2200,
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"rare_below_percent": "half"}, "not a percentage"),
        ({"rare_below_percent": "0"}, "above 0%"),
        ({"min_games": 0}, "at least one game"),
        ({"min_ply": 0}, "at least 1"),
        ({"min_ply": 10, "count_plies": 10}, "beyond the minimum ply"),
        ({"count_plies": 300}, "At most 255"),
        ({"min_rating": 0}, "must be positive"),
    ],
)
def test_bad_settings_are_rejected(kwargs: dict[str, object], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        CollectSettings(**kwargs)  # type: ignore[arg-type]


def test_main_writes_candidates_the_analysis_runner_reads(
    pgn_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "candidates.tsv"
    assert main([str(output), str(pgn_path), "--rare-below", "20", "--min-rating", "0"]) == 0
    lines = output.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 4
    _, ply, games, share = lines[0].split("\t")
    assert (int(ply), int(games), float(share)) in {(6, 2, 0.1), (5, 3, 0.15), (4, 2, 0.1)}
    fens, _ = read_candidates(output)
    assert fens == [line.split("\t")[0] for line in lines]
    report = json.loads((tmp_path / "candidates.tsv.report.json").read_text(encoding="utf-8"))
    assert report["settings"]["rare_below_percent"] == "20"
    assert report["sources"][0]["name"] == "masters.pgn"
    assert len(report["sources"][0]["sha256"]) == 64
    assert "4 candidates written" in capsys.readouterr().out


def test_main_rejects_bad_settings(pgn_path: Path, tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main([str(tmp_path / "out.tsv"), str(pgn_path), "--min-ply", "0"])
    assert exit_info.value.code == 2


def test_only_games_between_two_players_rated_2200_or_more_count(tmp_path: Path) -> None:
    def rated(white: str, black: str) -> str:
        return f'[WhiteElo "{white}"]\n[BlackElo "{black}"]\n'

    path = tmp_path / "rated.pgn"
    path.write_text(
        pgn_game("M1", "M2", "e4 e5", headers=rated("2650", "2200"))
        + pgn_game("M3", "M4", "d4 d5", headers=rated("2701", "2310"))
        + pgn_game("C1", "M5", "c4 e5", headers=rated("2199", "2600"))
        + pgn_game("U1", "M6", "Nf3 d5", headers=rated("?", "2500"))
        + pgn_game("U2", "U3", "g3 d5", headers=rated("0", "-"))
        + pgn_game("U4", "M7", "b3 e5"),
        encoding="utf-8",
    )
    games = collect([path], CollectSettings(rare_below_percent="50")).report["games"]
    assert (games["accepted"], games["below_min_rating"], games["unrated"]) == (2, 1, 3)


def test_main_reports_a_collection_with_no_masters_games(
    pgn_path: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # The hand-made games have no ratings, so with the default filter none of them count.
    assert main([str(tmp_path / "out.tsv"), str(pgn_path)]) == 1
    assert "No usable games" in capsys.readouterr().err
