"""P1-01: the pipeline accepts the pinned Stockfish build and refuses any other.

Most tests drive a fake engine that prints what Stockfish's `bench` prints. One drives a real build, when
`OFF_BOOK_STOCKFISH` names one; CI builds Stockfish 19 from source for it.
"""

import os
import sys
from pathlib import Path

import pytest

from off_book_pipeline.engine import (
    PINNED,
    STOCKFISH_19,
    EngineRefused,
    main,
    verify_engine,
)

# Arguments: banner name, comma-separated networks, nodes searched ("" for none), exit code; then "bench".
FAKE_STOCKFISH = """
import sys

name, networks, nodes, code, *rest = sys.argv[1:]
assert rest == ["bench"], rest
print(f"{name} by the Stockfish developers (see AUTHORS file)")
for network in filter(None, networks.split(",")):
    print(f"info string NNUE evaluation using {network} (109MiB, (86896, 1024, 32, 32, 1))")
print("bestmove e2e4 ponder g8f6")
if nodes:
    print("===========================", file=sys.stderr)
    print("Total time (ms) : 3060", file=sys.stderr)
    print(f"Nodes searched  : {nodes}", file=sys.stderr)
    print("Nodes/second    : 816311", file=sys.stderr)
sys.exit(int(code))
"""


def fake_engine(
    tmp_path: Path,
    name: str = "Stockfish 19",
    networks: str = PINNED.network,
    nodes: str = str(PINNED.bench),
    code: int = 0,
) -> list[str]:
    script = tmp_path / "fake_stockfish.py"
    script.write_text(FAKE_STOCKFISH, encoding="utf-8")
    return [sys.executable, str(script), name, networks, nodes, str(code)]


def test_the_pin_is_stockfish_19() -> None:
    assert PINNED is STOCKFISH_19
    assert PINNED.bench == 2497913
    assert PINNED.network == "nn-1a298aa575a0.nnue"


def test_the_pinned_build_passes(tmp_path: Path) -> None:
    command = fake_engine(tmp_path)
    engine = verify_engine(command)
    assert engine.pin == PINNED
    assert engine.reported_name == "Stockfish 19"
    assert engine.command == tuple(command)


def test_the_name_is_not_checked(tmp_path: Path) -> None:
    # The pin is behaviour, not identity: a build with the same bench and network gives the same evals.
    engine = verify_engine(fake_engine(tmp_path, name="Stockfish dev-20261028-ff7cee42"))
    assert engine.reported_name == "Stockfish dev-20261028-ff7cee42"


def test_a_different_bench_is_refused(tmp_path: Path) -> None:
    with pytest.raises(EngineRefused, match=r"gives bench 2497914; Stockfish 19 gives 2497913"):
        verify_engine(fake_engine(tmp_path, name="Stockfish 20", nodes="2497914"))


def test_a_different_network_is_refused(tmp_path: Path) -> None:
    with pytest.raises(EngineRefused, match=r"evaluates with nn-000000000000\.nnue; Stockfish 19 uses"):
        verify_engine(fake_engine(tmp_path, networks="nn-000000000000.nnue"))


def test_a_second_network_is_refused(tmp_path: Path) -> None:
    # Stockfish 18 and earlier switch to a small net position by position; the pool uses the big net alone.
    networks = f"{PINNED.network},nn-37f18f62d772.nnue"
    with pytest.raises(EngineRefused, match=r"evaluates with nn-1a298aa575a0\.nnue, nn-37f18f62d772\.nnue"):
        verify_engine(fake_engine(tmp_path, networks=networks))


def test_no_reported_network_is_refused(tmp_path: Path) -> None:
    with pytest.raises(EngineRefused, match=r"evaluates with no network it reported"):
        verify_engine(fake_engine(tmp_path, networks=""))


def test_a_missing_bench_signature_is_refused(tmp_path: Path) -> None:
    with pytest.raises(EngineRefused, match=r"reported no single bench signature"):
        verify_engine(fake_engine(tmp_path, nodes=""))


def test_a_failing_bench_is_refused(tmp_path: Path) -> None:
    with pytest.raises(EngineRefused, match=r"bench failed with exit code 3"):
        verify_engine(fake_engine(tmp_path, code=3))


def test_a_missing_binary_is_refused(tmp_path: Path) -> None:
    with pytest.raises(EngineRefused, match=r"Cannot start the engine"):
        verify_engine([str(tmp_path / "no-such-stockfish")])


def test_a_bench_that_never_finishes_is_refused() -> None:
    with pytest.raises(EngineRefused, match=r"did not finish within 0\.5 seconds"):
        verify_engine([sys.executable, "-c", "import time; time.sleep(30)"], timeout=0.5)


def test_an_engine_without_a_banner_is_named_generically(tmp_path: Path) -> None:
    script = tmp_path / "silent.py"
    script.write_text("import sys; sys.exit(1)\n", encoding="utf-8")
    with pytest.raises(EngineRefused, match=r"^The engine's bench failed"):
        verify_engine([sys.executable, str(script)])


def test_the_pin_fills_the_pool_version_engine_columns() -> None:
    assert PINNED.pool_version_fields() == {
        "engine_build_hash": "edb0d9db6731067ec50ce619ff372b463bc4dd5d",
        "engine_bench": 2497913,
        "engine_network": "nn-1a298aa575a0.nnue",
    }


def test_main_accepts_the_pinned_build(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(fake_engine(tmp_path)) == 0
    assert capsys.readouterr().out == "Accepted: Stockfish 19, bench 2497913, network nn-1a298aa575a0.nnue.\n"


def test_main_refuses_another_build(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(fake_engine(tmp_path, nodes="1")) == 1
    assert capsys.readouterr().err.startswith("Refused: Stockfish 19 gives bench 1;")


def test_main_needs_a_path(capsys: pytest.CaptureFixture[str]) -> None:
    assert main([]) == 2
    assert "Usage:" in capsys.readouterr().err


REAL_STOCKFISH = os.environ.get("OFF_BOOK_STOCKFISH")


@pytest.mark.skipif(not REAL_STOCKFISH, reason="OFF_BOOK_STOCKFISH does not name a Stockfish 19 build")
def test_a_real_stockfish_19_build_passes() -> None:
    assert REAL_STOCKFISH is not None
    engine = verify_engine([REAL_STOCKFISH])
    assert engine.reported_name == "Stockfish 19"
