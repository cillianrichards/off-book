"""Harness check: the package installs from the src layout and imports.

Replaced by real tests as the pipeline is built (P1 onwards).
"""

import off_book_pipeline


def test_package_imports_from_src_layout() -> None:
    assert off_book_pipeline.__file__ is not None
    assert "/src/off_book_pipeline/" in off_book_pipeline.__file__.replace("\\", "/")
