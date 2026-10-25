"""Print the pipeline environment's installed distributions and declared requirements as JSON.

Run by the licence check (main.ts) inside the pipeline's uv environment:

    uv run --project pipeline python -I tools/licence-check/src/python_inventory.py pipeline/pyproject.toml

Standard library only, so it adds nothing to the environment it inspects.
"""

import json
import sys
import tomllib
from importlib import metadata
from typing import Any


def requirements(pyproject: dict[str, Any]) -> list[str]:
    project = pyproject.get("project", {})
    found = list(project.get("dependencies", []))
    for extra in project.get("optional-dependencies", {}).values():
        found.extend(extra)
    for group in pyproject.get("dependency-groups", {}).values():
        # Entries may also be {include-group = "..."} tables, whose requirements are listed elsewhere.
        found.extend(r for r in group if isinstance(r, str))
    return found


def distribution(dist: metadata.Distribution) -> dict[str, Any]:
    meta = dist.metadata
    return {
        "name": meta["Name"],
        "version": dist.version,
        "licenseExpression": meta.get("License-Expression"),
        "license": meta.get("License"),
        "classifiers": meta.get_all("Classifier") or [],
    }


def main(pyproject_path: str) -> None:
    with open(pyproject_path, "rb") as file:
        pyproject = tomllib.load(file)
    inventory = {
        "project": pyproject["project"]["name"],
        "requirements": requirements(pyproject),
        "distributions": [distribution(d) for d in metadata.distributions()],
    }
    json.dump(inventory, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
