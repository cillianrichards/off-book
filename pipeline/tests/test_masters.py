"""P1-10: the Lichess masters crawl gives the same candidates as P1-02, from saved counts alone.

A fake explorer answers as Lichess's masters indexer would for the hand-made collection: each game counted
once per position, by any move order, with its final position included. Its answers carry player names,
game ids, ratings and opening names, as Lichess's do, so the tests can check none of them is kept.
"""

import json
import re
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import parse_qs, urlparse

import chess
import pytest
from hand_made import GAMES, pgn_game

from off_book_pipeline.analyse import read_candidates
from off_book_pipeline.collect import CollectSettings, collect
from off_book_pipeline.masters import (
    START,
    CrawlIncomplete,
    MoveCount,
    Store,
    StoreDamaged,
    candidates_from_store,
    child,
)
from off_book_pipeline.masters import main as candidates_main
from off_book_pipeline.masters_crawl import (
    CrawlRefused,
    LichessExplorer,
    clean_token,
    code_version,
    crawl,
)
from off_book_pipeline.masters_crawl import main as crawl_main

RULE = CollectSettings(min_games=2, rare_below_percent="20", min_ply=4, min_rating=None)
RESULTS = ["1-0", "1/2-1/2", "0-1"]


class FakeExplorer:
    """Lichess's masters endpoint for a fixed set of games."""

    def __init__(self, games: list[tuple[str, str]]) -> None:
        self.totals: dict[str, list[int]] = {}
        self.moves: dict[str, dict[str, list[Any]]] = {}
        self.lookups: list[str] = []
        for moves, result in games:
            column = RESULTS.index(result)
            board, played = chess.Board(), {}
            for san in moves.split():
                move = board.parse_san(san)
                played[board.epd(en_passant="legal")] = (move.uci(), board.san(move))  # last visit wins
                board.push(move)
            for epd in {*played, board.epd(en_passant="legal")}:
                self.totals.setdefault(epd, [0, 0, 0])[column] += 1
            for epd, (uci, san) in played.items():
                self.moves.setdefault(epd, {}).setdefault(uci, [san, 0, 0, 0])[1 + column] += 1

    def lookup(self, epd: str) -> dict[str, Any]:
        self.lookups.append(epd)
        white, draws, black = self.totals.get(epd, [0, 0, 0])
        moves = [
            {
                "uci": uci,
                "san": san,
                "averageRating": 2512,
                "white": w,
                "draws": d,
                "black": b,
                "game": {
                    "id": "SeCrEt01",
                    "winner": None,
                    "white": {"name": "Secretname, White", "rating": 2512},
                    "black": {"name": "Secretname, Black", "rating": 2498},
                    "year": 2001,
                    "month": "2001-05",
                }
                if w + d + b == 1
                else None,
                "opening": {"eco": "C60", "name": "Secret Opening Name"},
            }
            for uci, (san, w, d, b) in sorted(self.moves.get(epd, {}).items(), key=lambda kv: -sum(kv[1][1:]))
        ]
        return {
            "opening": None,
            "white": white,
            "draws": draws,
            "black": black,
            "moves": moves,
            "topGames": [],
        }


def games_with_results() -> list[tuple[str, str]]:
    return [(moves, RESULTS[index % 3]) for index, (_, _, moves) in enumerate(GAMES)]


@pytest.fixture
def explorer() -> FakeExplorer:
    return FakeExplorer(games_with_results())


@pytest.fixture
def crawled(tmp_path: Path, explorer: FakeExplorer) -> Path:
    store = tmp_path / "crawl.jsonl"
    assert crawl(store, explorer, "20", code="test-commit").complete
    return store


def fen_after(moves: str) -> str:
    board = chess.Board()
    for move in moves.split():
        board.push_san(move)
    return f"{board.epd(en_passant='legal')} 0 {board.fullmove_number}"


def test_the_crawl_gives_the_hand_counted_candidates(crawled: Path) -> None:
    candidates, report = candidates_from_store(crawled, RULE)
    assert {(c.fen, c.ply, c.games) for c in candidates} == {
        (fen_after("e4 e5 Nf3 Nc6 Bb5 a6"), 6, 2),
        (fen_after("e4 e5 Nf3 Nc6 Bb5 Nf6"), 6, 2),
        (fen_after("e4 e5 Nf3 Nc6 a3"), 5, 3),
        (fen_after("f3 e5 g4 d5"), 4, 2),
    }
    assert report["total_games"] == 20
    assert report["common_from_games"] == 4
    assert report["common_positions"] == 10
    # One fewer than P1-02 counts: Lichess keeps one move per position per game, the last one played from it.
    # The knight-shuffle game leaves the start by 1.Nf3 and later by 1.e4, so Lichess records only 1.e4 and
    # never offers 1.Nf3, which one game played and so could not have been a candidate anyway.
    assert report["entered_from_common"] == 20
    assert report["removed"] == {
        "still_common": 9,
        "below_min_games": 3,
        "before_min_ply": 3,
        "no_legal_moves": 1,
    }


def test_the_crawl_and_p1_02_agree_on_the_same_games(crawled: Path, tmp_path: Path) -> None:
    pgn = tmp_path / "games.pgn"
    pgn.write_text(
        "".join(
            pgn_game(w, b, moves, result=r)
            for (w, b, _), (moves, r) in zip(GAMES, games_with_results(), strict=True)
        )
    )
    from_games = collect([pgn], RULE).candidates
    from_crawl, _ = candidates_from_store(crawled, RULE)
    assert from_crawl == from_games


def test_each_position_needed_is_looked_up_once(crawled: Path, explorer: FakeExplorer) -> None:
    # The start, and every position one move on from the 10 common positions (20 of them; see above).
    assert len(explorer.lookups) == len(set(explorer.lookups)) == 21
    assert explorer.lookups[0] == START


def test_only_counts_are_kept(crawled: Path) -> None:
    text = crawled.read_text(encoding="utf-8")
    for leaked in (
        "Secretname",
        "SeCrEt01",
        "Secret Opening",
        "rating",
        "averageRating",
        "opening",
        "topGames",
    ):
        assert leaked not in text
    record = json.loads(text.splitlines()[1])
    assert set(record) == {"fen", "date", "white", "draws", "black", "moves"}
    assert json.loads(text.splitlines()[-1])["run"]["code"] == "test-commit"
    assert record["fen"] == START
    assert record["white"] + record["draws"] + record["black"] == 20


def test_a_higher_threshold_needs_no_new_crawl(crawled: Path, tmp_path: Path) -> None:
    # At 30% a position is common from 6 games; 3.Bb5 (4 games) becomes a candidate itself.
    higher = CollectSettings(min_games=2, rare_below_percent="30", min_ply=4, min_rating=None)
    offline, _ = candidates_from_store(crawled, higher)
    fresh_store = tmp_path / "fresh.jsonl"
    crawl(fresh_store, FakeExplorer(games_with_results()), "30")
    fresh, _ = candidates_from_store(fresh_store, higher)
    assert offline == fresh
    assert {c.fen for c in offline} == {fen_after("e4 e5 Nf3 Nc6 Bb5"), fen_after("e4 e5 Nf3 Nc6 a3")}


def test_other_floors_and_minimum_plies_need_no_new_crawl(crawled: Path) -> None:
    floor_three = CollectSettings(min_games=3, rare_below_percent="20", min_ply=4, min_rating=None)
    assert {c.fen for c in candidates_from_store(crawled, floor_three)[0]} == {fen_after("e4 e5 Nf3 Nc6 a3")}
    early = CollectSettings(min_games=2, rare_below_percent="20", min_ply=1, min_rating=None)
    fens = {c.fen for c in candidates_from_store(crawled, early)[0]}
    assert {fen_after("Na3"), fen_after("d4 d5"), fen_after("d4 Nf6")} <= fens


def test_a_lower_threshold_than_the_crawl_is_refused(tmp_path: Path) -> None:
    store = tmp_path / "crawl.jsonl"
    crawl(store, FakeExplorer(games_with_results()), "30")
    with pytest.raises(CrawlIncomplete, match="20% threshold needs: crawl it at that threshold or lower"):
        candidates_from_store(store, RULE)


def test_crawling_again_lower_looks_up_only_what_is_new(tmp_path: Path) -> None:
    store, explorer = tmp_path / "crawl.jsonl", FakeExplorer(games_with_results())
    crawl(store, explorer, "30")
    first = len(explorer.lookups)
    summary = crawl(store, explorer, "20")
    assert summary.complete
    assert len(explorer.lookups) == len(set(explorer.lookups)) == 21
    assert summary.looked_up == 21 - first
    assert len(candidates_from_store(store, RULE)[0]) == 4


def test_an_interrupted_crawl_resumes_without_repeating_lookups(tmp_path: Path) -> None:
    store, explorer = tmp_path / "crawl.jsonl", FakeExplorer(games_with_results())
    stopped = crawl(store, explorer, "20", max_lookups=7)
    assert (stopped.looked_up, stopped.complete) == (7, False)
    assert stopped.still_queued > 0
    finished = crawl(store, explorer, "20")
    assert finished.complete
    assert len(explorer.lookups) == len(set(explorer.lookups)) == 21
    assert len(candidates_from_store(store, RULE)[0]) == 4


def test_a_crawl_stops_when_its_time_is_up(tmp_path: Path) -> None:
    ticks = iter(range(0, 1000, 10))
    summary = crawl(
        tmp_path / "crawl.jsonl",
        FakeExplorer(games_with_results()),
        "20",
        max_seconds=25,
        clock=lambda: next(ticks),
    )
    assert not summary.complete
    assert summary.looked_up == 2


def test_a_line_cut_off_mid_write_is_discarded(tmp_path: Path) -> None:
    store, explorer = tmp_path / "crawl.jsonl", FakeExplorer(games_with_results())
    crawl(store, explorer, "20", max_lookups=5)
    with store.open("a", encoding="utf-8") as file:
        file.write('{"fen":"rnbqkbnr/pp')
    assert crawl(store, explorer, "20").complete
    assert len(candidates_from_store(store, RULE)[0]) == 4


def test_castling_written_as_king_takes_rook_is_understood() -> None:
    board = chess.Board("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    as_lichess = child(board, MoveCount("e1h1", "O-O", 1, 0, 0))
    as_uci = child(board, MoveCount("e1g1", "O-O", 1, 0, 0))
    assert as_lichess == as_uci == "r3k2r/8/8/8/8/8/8/R4RK1 b kq -"


def test_an_answer_without_counts_is_refused(tmp_path: Path) -> None:
    class Broken:
        def lookup(self, epd: str) -> dict[str, Any]:
            return {"error": "nope"}

    with pytest.raises(CrawlRefused, match="expected counts"):
        crawl(tmp_path / "crawl.jsonl", Broken(), "20")


# The HTTP client, against a local server


class LichessStandIn(BaseHTTPRequestHandler):
    answers: ClassVar[list[tuple[int, dict[str, Any]]]] = []
    requests: ClassVar[list[tuple[str, str | None]]] = []

    def do_GET(self) -> None:
        LichessStandIn.requests.append((self.path, self.headers.get("Authorization")))
        status, body = LichessStandIn.answers.pop(0)
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def stand_in() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), LichessStandIn)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    LichessStandIn.answers, LichessStandIn.requests = [], []
    yield f"http://127.0.0.1:{server.server_address[1]}/masters"
    server.shutdown()


def test_the_client_asks_for_every_move_and_no_top_games_and_waits_on_429(stand_in: str) -> None:
    waits: list[float] = []
    notices: list[str] = []
    LichessStandIn.answers = [(429, {}), (429, {}), (200, {"white": 1, "draws": 2, "black": 3, "moves": []})]
    explorer = LichessExplorer("token123", url=stand_in, sleep=waits.append, notify=notices.append)
    answer = explorer.lookup(START)
    assert answer["draws"] == 2
    assert waits == [60.0, 120.0]
    assert notices == [
        "Lichess asked the crawl to slow down; waiting 60 seconds before trying again.",
        "Lichess asked the crawl to slow down; waiting 120 seconds before trying again.",
    ]
    path, authorisation = LichessStandIn.requests[-1]
    query = parse_qs(urlparse(path).query)
    assert query == {"fen": [f"{START} 0 1"], "moves": ["256"], "topGames": ["0"]}
    assert authorisation == "Bearer token123"


def test_the_client_reports_a_refused_token_with_lichesss_reason(stand_in: str) -> None:
    LichessStandIn.answers = [(401, {"error": "No such token"})]
    with pytest.raises(CrawlRefused, match=r"refused the token \(HTTP 401: No such token\)\. Check that"):
        LichessExplorer("bad", url=stand_in, sleep=lambda _: None).lookup(START)


def test_the_client_reports_another_refusal_with_its_reason(stand_in: str) -> None:
    LichessStandIn.answers = [(400, {"error": "Invalid fen"})]
    with pytest.raises(CrawlRefused, match=r"HTTP 400: Invalid fen for "):
        LichessExplorer("t", url=stand_in, sleep=lambda _: None).lookup(START)


@pytest.mark.parametrize("pasted", ['"lip_abc123"', "lip_abc123\r", "  'lip_abc123' ", "lip_abc123"])
def test_a_pasted_token_loses_quotes_and_whitespace(pasted: str) -> None:
    assert clean_token(pasted) == "lip_abc123"


def test_the_client_retries_a_server_error(stand_in: str) -> None:
    waits: list[float] = []
    LichessStandIn.answers = [(503, {}), (200, {"white": 0, "draws": 0, "black": 1, "moves": []})]
    assert LichessExplorer("t", url=stand_in, sleep=waits.append).lookup(START)["black"] == 1
    assert waits == [20.0]


# Command line


def test_main_writes_candidates_from_a_store(
    crawled: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    output = tmp_path / "candidates.tsv"
    assert candidates_main([str(crawled), str(output), "--rare-below", "20"]) == 0
    fens, _ = read_candidates(output)
    assert len(fens) == 4
    report = json.loads((tmp_path / "candidates.tsv.report.json").read_text(encoding="utf-8"))
    assert report["source"]["source"] == "https://explorer.lichess.org/masters"
    assert report["settings"] == {"min_games": 2, "rare_below_percent": "20", "min_ply": 4}
    assert "4 candidates written" in capsys.readouterr().out


def test_main_refuses_a_threshold_the_store_cannot_support(crawled: Path, tmp_path: Path) -> None:
    assert candidates_main([str(crawled), str(tmp_path / "out.tsv"), "--rare-below", "10"]) == 1


def test_main_needs_a_token_to_crawl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LICHESS_TOKEN", raising=False)
    with pytest.raises(SystemExit) as exit_info:
        crawl_main([str(tmp_path / "crawl.jsonl")])
    assert exit_info.value.code == 2


def test_each_run_records_its_threshold_outcome_and_code(tmp_path: Path) -> None:
    store, explorer = tmp_path / "crawl.jsonl", FakeExplorer(games_with_results())
    crawl(store, explorer, "30", max_lookups=3, code="abc123")
    crawl(store, explorer, "20", code="def456")
    runs = Store(store, create=False).runs
    assert [(r["crawl_threshold"], r["complete"], r["code"]) for r in runs] == [
        ("30", False, "abc123"),
        ("20", True, "def456"),
    ]
    assert [r["looked_up"] for r in runs] == [3, 18]
    assert all(r["ended"] for r in runs)
    # Run lines do not disturb the counts or the candidates.
    assert len(candidates_from_store(store, RULE)[0]) == 4


def test_the_candidates_report_names_the_runs_behind_it(crawled: Path) -> None:
    _, report = candidates_from_store(crawled, RULE)
    assert [run["code"] for run in report["source"]["runs"]] == ["test-commit"]


def test_the_code_version_is_a_commit() -> None:
    assert re.fullmatch(r"[0-9a-f]{40}(-dirty)?|unknown", code_version())


def test_a_damaged_store_is_refused(crawled: Path) -> None:
    lines = crawled.read_text(encoding="utf-8").splitlines(keepends=True)
    lines[3] = "not json\n"
    crawled.write_text("".join(lines), encoding="utf-8")
    with pytest.raises(StoreDamaged, match="start a new store"):
        candidates_from_store(crawled, RULE)


def test_stopping_with_ctrl_c_says_how_to_carry_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def interrupted(*args: object, **kwargs: object) -> None:
        raise KeyboardInterrupt

    monkeypatch.setenv("LICHESS_TOKEN", '"lip_abc"')
    monkeypatch.setattr("off_book_pipeline.masters_crawl.crawl", interrupted)
    assert crawl_main([str(tmp_path / "crawl.jsonl")]) == 130
    err = capsys.readouterr().err
    assert err.startswith("Crawling at 0.05%, one lookup at a time")
    assert "Stopped. Everything looked up so far is saved" in err
