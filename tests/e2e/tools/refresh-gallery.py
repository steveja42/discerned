#!/usr/bin/env python3
"""
Refresh test-output/baselines-gallery/ — a single folder that holds every
fixture-visual pixel baseline plus a 600px "top of clip" preview for each one,
so File Explorer's Extra-large-icons view shows them all side by side.

Inputs:
  - tests/e2e/<site>-fixture-visual.spec.ts-snapshots/<site>-fixture-clipbody-*.png
      (the committed pixel baselines)
  - test-output/<site>-fixture-rendered.png
      (the most-recent rendered debug image — written every test run)

Outputs (in test-output/baselines-gallery/):
  - <site>.png       — baseline (full clip body)
  - <site>-top.png   — top 600px of the most-recent rendered image

Run from the monorepo root after regenerating baselines:

  python tests/e2e/tools/refresh-gallery.py

Requires: Pillow (pip install pillow).
"""
from __future__ import annotations
import os
import shutil
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("error: Pillow not installed. Run: pip install pillow")

ROOT = Path(__file__).resolve().parents[3]
SPEC_ROOT = ROOT / "tests" / "e2e"
RENDERED_DIR = ROOT / "test-output"
DEST = RENDERED_DIR / "baselines-gallery"
TOP_CROP_H = 1200

def main() -> None:
    DEST.mkdir(parents=True, exist_ok=True)

    baseline_count = 0
    for path in SPEC_ROOT.rglob("*-fixture-clipbody-*.png"):
        site = path.name.split("-fixture-clipbody-")[0]
        shutil.copyfile(path, DEST / f"{site}.png")
        baseline_count += 1

    top_count = 0
    for path in RENDERED_DIR.glob("*-fixture-rendered.png"):
        site = path.name[: -len("-fixture-rendered.png")]
        try:
            with Image.open(path) as im:
                h = min(TOP_CROP_H, im.height)
                top = im.crop((0, 0, im.width, h))
                top.save(DEST / f"{site}-top.png")
                top_count += 1
        except Exception as e:
            print(f"skip {site}: {e}")

    print(f"refreshed {baseline_count} baselines + {top_count} top-crops")
    print(f"  -> {DEST}")

if __name__ == "__main__":
    main()
