"""The crawl is the pipeline's only network code, and nothing else depends on it (decided 4 November 2026).

The masters crawl runs once; its store is all the pool needs afterwards. So everything else in the
pipeline must keep working, and stay testable, with the crawl module deleted.
"""

import ast
from pathlib import Path

import pytest

PACKAGE = Path(__file__).parents[1] / "src" / "off_book_pipeline"
CRAWL = "masters_crawl"
NETWORK = {"urllib", "http", "socket", "ssl", "requests", "httpx", "aiohttp", "urllib3"}


def imported_modules(path: Path) -> set[str]:
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            found.add(node.module)
            found.update(f"{node.module}.{alias.name}" for alias in node.names)
    return found


MODULES = sorted(path for path in PACKAGE.glob("*.py") if path.stem != CRAWL)


def test_the_crawl_module_exists() -> None:
    assert (PACKAGE / f"{CRAWL}.py").is_file()
    assert NETWORK & {name.split(".")[0] for name in imported_modules(PACKAGE / f"{CRAWL}.py")}


@pytest.mark.parametrize("path", MODULES, ids=lambda path: path.stem)
def test_nothing_else_imports_the_crawl(path: Path) -> None:
    assert not {name for name in imported_modules(path) if CRAWL in name.split(".")}


@pytest.mark.parametrize("path", MODULES, ids=lambda path: path.stem)
def test_nothing_else_touches_the_network(path: Path) -> None:
    assert not {name.split(".")[0] for name in imported_modules(path)} & NETWORK
