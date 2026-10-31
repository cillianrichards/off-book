"""P1-02: line counts match perft at plies 1 to 4, and transpositions collapse to one canonical FEN."""

from pathlib import Path

import chess
import pytest

from off_book_pipeline.generate import DEFAULT_PLY, Generation, canonical_fen, generate, main

# Legal lines from the start: perft, as published by the Chess Programming Wiki.
PERFT = {1: 20, 2: 400, 3: 8902, 4: 197281}

# Distinct positions, counting castling rights and legal en passant captures as part of the position:
# OEIS A083276. An independent check that the canonical FEN collapses exactly the right lines.
DISTINCT_POSITIONS = {1: 20, 2: 400, 3: 5362, 4: 72078}


@pytest.fixture(scope="module")
def generations() -> dict[int, Generation]:
    return {ply: generate(ply) for ply in PERFT}


def after(*moves: str) -> str:
    """The canonical FEN after playing `moves` (SAN) from the start."""
    board = chess.Board()
    for move in moves:
        board.push_san(move)
    return canonical_fen(board, len(moves))


@pytest.mark.parametrize("ply", PERFT)
def test_line_counts_match_perft(generations: dict[int, Generation], ply: int) -> None:
    assert generations[ply].lines == PERFT[ply]


@pytest.mark.parametrize("ply", DISTINCT_POSITIONS)
def test_position_counts_match_the_published_count(generations: dict[int, Generation], ply: int) -> None:
    assert len(generations[ply].lines_by_fen) == DISTINCT_POSITIONS[ply]


def test_a_known_transposition_dedupes(generations: dict[int, Generation]) -> None:
    fen = after("e4", "e5", "Nc3", "Nf6")
    assert fen == after("e4", "Nf6", "Nc3", "e5")
    assert fen == after("Nc3", "Nf6", "e4", "e5")
    assert fen == "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 0 3"
    # Each side's two moves in either order: four lines, one candidate.
    assert generations[4].lines_by_fen[fen] == 4


def test_the_halfmove_clock_is_normalised() -> None:
    pawns_last, knights_last = chess.Board(), chess.Board()
    for move in ("Nf3", "Nc6", "e4", "e5"):
        pawns_last.push_san(move)
    for move in ("e4", "e5", "Nf3", "Nc6"):
        knights_last.push_san(move)
    assert pawns_last.halfmove_clock != knights_last.halfmove_clock
    assert canonical_fen(pawns_last, 4) == canonical_fen(knights_last, 4)


def test_en_passant_is_dropped_when_no_capture_is_legal() -> None:
    # 2...e5 is a double push, but no white pawn can take on e6.
    assert after("e4", "Nf6", "Nc3", "e5").split()[3] == "-"


def test_en_passant_is_kept_when_a_capture_is_legal(generations: dict[int, Generation]) -> None:
    # After 2...d5, exd6 is legal, so the position differs from the same diagram reached by 1...d5.
    capture_possible = after("e4", "Nf6", "e5", "d5")
    no_capture = after("e4", "d5", "e5", "Nf6")
    assert capture_possible == "rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"
    assert no_capture == "rnbqkb1r/ppp1pppp/5n2/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3"
    assert {capture_possible, no_capture} <= set(generations[4].candidates)


def test_the_starting_diagram_returns_at_ply_four(generations: dict[int, Generation]) -> None:
    # Each side sends a knight out and back: four ways each.
    fen = after("Nf3", "Nf6", "Ng1", "Ng8")
    assert fen == "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3"
    assert generations[4].lines_by_fen[fen] == 16


def test_finished_positions_are_not_candidates(generations: dict[int, Generation]) -> None:
    fools_mate = after("f3", "e5", "g4", "Qh4#")
    generation = generations[4]
    # 1.f3 or 1.f4, 1...e5 or 1...e6, then 2.g4 Qh4#: four mates, each reached in two move orders.
    assert len(generation.finished) == 4
    assert fools_mate in generation.finished
    assert fools_mate not in generation.candidates
    assert len(generation.candidates) == DISTINCT_POSITIONS[4] - 4


def test_every_candidate_is_a_valid_canonical_fen(generations: dict[int, Generation]) -> None:
    for fen in generations[4].candidates:
        board = chess.Board(fen)
        assert board.is_valid(), fen
        assert canonical_fen(board, 4) == fen


def test_candidates_are_sorted(generations: dict[int, Generation]) -> None:
    candidates = generations[3].candidates
    assert candidates == sorted(candidates)


def test_the_ply_must_be_positive() -> None:
    with pytest.raises(ValueError, match="at least 1"):
        generate(0)


def test_the_default_ply_is_four() -> None:
    assert DEFAULT_PLY == 4


def test_main_writes_one_fen_per_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    output = tmp_path / "candidates.txt"
    assert main([str(output), "--ply", "2"]) == 0
    data = output.read_bytes()
    assert b"\r" not in data
    lines = data.decode("utf-8").splitlines()
    assert len(lines) == 400
    assert lines == sorted(lines)
    assert all(line.endswith(" w KQkq - 0 2") for line in lines)
    assert capsys.readouterr().out == (
        f"Ply 2: 400 lines, 400 positions, 0 finished and dropped; 400 written to {output}.\n"
    )


def test_main_refuses_a_ply_below_one(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main([str(tmp_path / "out.txt"), "--ply", "0"])
    assert exit_info.value.code == 2
    assert not (tmp_path / "out.txt").exists()
