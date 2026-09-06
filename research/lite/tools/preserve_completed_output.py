"""Retain completed evaluation output for read-only diagnostic joins."""

import argparse
import json
import os
from pathlib import Path
import shutil
import time


def preserve(source, destination, timeout):
    deadline = time.monotonic() + timeout
    marker = Path(str(source) + ".session.json")
    while time.monotonic() < deadline:
        try:
            summary = json.loads(marker.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            time.sleep(0.5)
            continue
        if not isinstance(summary, dict):
            raise ValueError("Session summary must be an object")
        break
    else:
        raise TimeoutError(f"No completed session at {source}")

    # The sibling session summary is written after the output writer drains.
    destination.mkdir(parents=True, exist_ok=False)
    files = 0
    size = 0
    for current, directories, names in os.walk(source):
        relative = Path(current).relative_to(source)
        target = destination / relative
        target.mkdir(exist_ok=True)
        for directory in directories:
            (target / directory).mkdir(exist_ok=True)
        for name in names:
            original = Path(current) / name
            if original.is_symlink():
                raise ValueError(f"Unexpected symlink: {original}")
            os.link(original, target / name)
            files += 1
            size += original.stat().st_size
    if files == 0:
        raise ValueError("Completed output has no files")
    for suffix in [".session.json", ".utilization.json", ".campaign.json", ".config.json"]:
        sibling = Path(str(source) + suffix)
        if sibling.exists():
            shutil.copyfile(sibling, destination / ("retained" + suffix))
    manifest = {"source": str(source), "files": files, "bytes": size}
    (destination / "retention.json").write_text(json.dumps(manifest) + "\n")
    print(json.dumps(manifest), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--timeout", type=float, default=1800)
    args = parser.parse_args()
    preserve(args.source.resolve(), args.destination.resolve(), args.timeout)
