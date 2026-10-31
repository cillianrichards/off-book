"""The pinned Stockfish build (P1-01).

An eval is a property of the position, the engine and the search settings together, so every position in
a pool must come from one engine. The pipeline checks the engine before it analyses anything and refuses
to start on any other.

The check is Stockfish's own bench signature, not the binary's checksum (decided 30 October 2026).
`stockfish bench` searches a fixed set of positions to a fixed depth and reports the nodes searched, and
Stockfish's CI requires every build of a commit, on every platform, to report the same number. So any
build of the pinned release passes, whoever compiled it and for whatever CPU, while a build that would
give different evals fails. The network is checked as well, so that a wrong net is reported as one rather
than as a bare bench mismatch.

Check a build by hand with `python -m off_book_pipeline.engine PATH`.
"""

import re
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class EnginePin:
    """A Stockfish release, identified as `PoolVersion` records it."""

    release: str
    """What the release calls itself on start-up. Used in messages only, never checked."""

    source_commit: str
    """The commit the release was built from. Recorded, not checked: a release build does not report it."""

    bench: int
    """Nodes searched by `stockfish bench` with its default arguments, as the release commit records it."""

    network: str
    """The network embedded in the binary. The pipeline never sets `EvalFile`, so it is the only one used."""

    def pool_version_fields(self) -> dict[str, str | int]:
        """The `pool_version` columns this pin fills (migrations 20261029170000 and 20261030083000)."""
        return {
            "engine_build_hash": self.source_commit,
            "engine_bench": self.bench,
            "engine_network": self.network,
        }


STOCKFISH_19 = EnginePin(
    release="Stockfish 19",
    source_commit="edb0d9db6731067ec50ce619ff372b463bc4dd5d",
    bench=2497913,
    network="nn-1a298aa575a0.nnue",
)

PINNED = STOCKFISH_19
"""The engine every pool is analysed with. Changing it means a new pool version (P6-05)."""

BENCH_TIMEOUT_SECONDS = 300.0
"""Generous: bench takes a few seconds on a modern CPU, longer on a build without SIMD."""


class EngineRefused(Exception):
    """The engine is not the pinned build, or could not be checked, so the pipeline must not run."""


@dataclass(frozen=True)
class VerifiedEngine:
    """An engine that has passed the check, and the pin it matched."""

    command: tuple[str, ...]
    pin: EnginePin
    reported_name: str


_BANNER_SUFFIX = " by the Stockfish developers"
_NETWORK = re.compile(r"^info string NNUE evaluation using (\S+)", re.MULTILINE)
_NODES = re.compile(r"^Nodes searched\s*:\s*(\d+)\s*$", re.MULTILINE)


def verify_engine(
    command: Sequence[str], pin: EnginePin = PINNED, timeout: float = BENCH_TIMEOUT_SECONDS
) -> VerifiedEngine:
    """Run `bench` on the engine and refuse it unless it behaves as `pin`'s release.

    `command` starts the engine, without `bench`: usually just the binary's path.
    """
    command = tuple(command)
    try:
        result = subprocess.run(
            [*command, "bench"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except OSError as error:
        raise EngineRefused(f"Cannot start the engine {' '.join(command)}: {error}") from error
    except subprocess.TimeoutExpired as error:
        raise EngineRefused(f"The engine's bench did not finish within {timeout:g} seconds.") from error

    name = _reported_name(result.stdout)
    remedy = f"Use a build of {pin.release}, or change the pin, which means a new pool version."

    if result.returncode != 0:
        raise EngineRefused(f"{name}'s bench failed with exit code {result.returncode}. {remedy}")

    networks = sorted(set(_NETWORK.findall(result.stdout)))
    if networks != [pin.network]:
        found = ", ".join(networks) or "no network it reported"
        expected = f"{pin.release} uses {pin.network} alone"
        raise EngineRefused(f"{name} evaluates with {found}; {expected}. {remedy}")

    # Stockfish writes bench's summary to stderr; both streams are searched so that moving it is harmless.
    signatures = _NODES.findall(result.stdout + result.stderr)
    if len(signatures) != 1:
        raise EngineRefused(f"{name} reported no single bench signature. {remedy}")
    if int(signatures[0]) != pin.bench:
        raise EngineRefused(f"{name} gives bench {signatures[0]}; {pin.release} gives {pin.bench}. {remedy}")

    return VerifiedEngine(command=command, pin=pin, reported_name=name)


def _reported_name(stdout: str) -> str:
    """The name in Stockfish's start-up banner, such as "Stockfish 19", or a stand-in if there is none."""
    first_line = next((line for line in stdout.splitlines() if line.strip()), "")
    name, found, _ = first_line.partition(_BANNER_SUFFIX)
    return name.strip() if found and name.strip() else "The engine"


def main(argv: Sequence[str] | None = None) -> int:
    """Check an engine by hand: `python -m off_book_pipeline.engine PATH`. Exits 0 if it passes."""
    command = sys.argv[1:] if argv is None else list(argv)
    if not command:
        print("Usage: python -m off_book_pipeline.engine PATH_TO_STOCKFISH", file=sys.stderr)
        return 2
    try:
        engine = verify_engine(command)
    except EngineRefused as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    pin = engine.pin
    print(f"Accepted: {engine.reported_name}, bench {pin.bench}, network {pin.network}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
