#!/usr/bin/env python3
"""Slice a tall sweep clip into legible horizontal bands for visual review.

WHY: a 610x8000 clip PNG is downscaled ~4x when read, landing at ~152px wide,
where body text is an illegible smear. Layout is still visible (where a hero
sits, whether a rail stacks one-per-row), but PROSE is not -- so a verdict like
"full body captured, sections intact" taken from that image is an inference
from block shape, not something actually read.

Slicing into <=2000px bands keeps each band near 1:1 when read, so the text is
actually legible. Cost is one image read per band, so slice only the clips
whose verdict depends on reading the words.

This REPLACES an earlier version that opened each PNG in a headless Chromium
tab and screenshotted a clip region -- a whole browser round-trip to do what is
a two-line crop. discerned-ext/CLAUDE.md already established the precedent
(refresh-gallery.py crops fixture baselines with Pillow); this tool should have
followed it from the start. A plain PIL.Image.open().crop() is milliseconds per
band with no browser, no file:// shim page, no waiting for naturalWidth > 0.

Usage:
  python tests/e2e/tools/slice-clip.py <domain[,domain,...]> [--band 1800] [--max N]
  python tests/e2e/tools/slice-clip.py <domains> --cast   # slice the CAST image
  python tests/e2e/tools/slice-clip.py --list             # clips needing this
  python tests/e2e/tools/slice-clip.py --all --stale-only [--cast]
                                                          # catch-up: re-slice
                                                          # every domain whose
                                                          # PNG is newer than
                                                          # its bands

Writes test-output/corpus-sweep-run/slices/<domain>--slice-N.png (or
--castslice-N.png with --cast) and prints the paths, one per line.
Defaults to the TOP THREE bands -- see MAX_BANDS_DEFAULT. When a clip runs
past that, the output says how many bands were NOT written, so a verdict is
never written against a silently-truncated view.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

OUT_ROOT = Path(__file__).resolve().parents[3] / "test-output"


def resolve_run_dir(run_dir_arg: str | None) -> Path:
    """--run-dir (or SWEEP_RUN_DIR) points at a BACKUP folder instead of the
    live corpus-sweep-run/ -- e.g. to verify a prior full run's images before
    trusting it as the regression baseline. review-queue.mjs and
    record-verdict.mjs take the same flag; point all three at the same folder.
    Bare name resolves under test-output/; absolute path used as-is.
    """
    import os

    arg = run_dir_arg or os.environ.get("SWEEP_RUN_DIR")
    if not arg:
        return OUT_ROOT / "corpus-sweep-run"
    p = Path(arg)
    return p if p.is_absolute() else OUT_ROOT / arg

BAND_DEFAULT = 1800
# Default to the TOP THREE BANDS.
#
# This was 1, on the premise that "what a reader sees first is where capture
# defects show up". That premise holds only when the clip STARTS at the
# article. It fails on the one defect shape where a verdict most needs the
# extra bands: content that is present but BURIED under prepended chrome. The
# top band is then guaranteed not to contain the thing the verdict is asserting
# the presence of, so "captured X instead of the article" gets recorded when
# the truth is "captured X AND the article, in that order" -- different defects
# with different fixes.
#
# Measured on apnews (2026-09-11): ~4700px of video player + thumbnail rail +
# expanded photo carousel before the byline, which lands in BAND 3. Its live
# verdict said the article was replaced by a video rail; reading bands 3-5
# showed full prose with section headings intact. Two bands would still have
# missed it, which is why the default is 3 and not 2.
#
# Cost across a 192-clip run: 476 band-reads vs 192. Bounded on purpose -- this
# is not "slice everything" (634), since past band 3 the marginal band almost
# always just confirms "the body continues". Pass --max N for a taller clip.
MAX_BANDS_DEFAULT = 3


def list_tall_clips(run_dir: Path) -> None:
    rows = []
    for f in run_dir.glob("*--2-clip.png"):
        domain = f.name[: -len("--2-clip.png")]
        with Image.open(f) as im:
            width, height = im.size
        scale = height / 2000
        if scale >= 2.5:
            rows.append((domain, width, height, scale))
    rows.sort(key=lambda r: -r[3])
    print(f"{len(rows)} clip(s) too tall to read at 1:1 (>=2.5x downscale):")
    for domain, width, height, scale in rows:
        print(f"  {domain:<22} {width}x{height}  {scale:.1f}x")


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("domains", nargs="?")
    parser.add_argument("--band", type=int, default=BAND_DEFAULT)
    parser.add_argument("--max", type=int, default=MAX_BANDS_DEFAULT)
    parser.add_argument("--cast", action="store_true")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--run-dir", dest="run_dir")
    # Slice only domains whose source image is NEWER than its existing band 1,
    # i.e. re-captured since it was last sliced. Cheap enough to run over the
    # whole corpus, which is what makes it safe to call after any re-capture.
    parser.add_argument("--stale-only", action="store_true")
    # Every domain that has a source image, for use with --stale-only.
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    run_dir = resolve_run_dir(args.run_dir)
    out_dir = run_dir / "slices"

    if args.list:
        list_tall_clips(run_dir)
        return

    if not args.domains and not args.all:
        print(
            "usage: slice-clip.py <domain[,domain...]> [--cast] [--band N] [--max N] "
            "[--run-dir DIR] [--stale-only] | --all --stale-only | --list",
            file=sys.stderr,
        )
        sys.exit(1)

    if args.all:
        domains = sorted(
            p.name[: -len("--score.json")] for p in run_dir.glob("*--score.json")
        )
    else:
        domains = [d.strip() for d in args.domains.split(",") if d.strip()]
    # --cast slices the CAST image instead of the clip. The cast is a separate
    # render (kind-30023 markdown through /discerns) with its own failure modes
    # -- dropped headline, link-pill spills -- that a clean clip does not reveal.
    kind = "3-cast" if args.cast else "2-clip"
    suffix = "castslice" if args.cast else "slice"

    out_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for domain in domains:
        src = run_dir / f"{domain}--{kind}.png"
        if not src.exists():
            print(f"SKIP {domain}: no {kind} image")
            continue

        # A domain that now SKIPS keeps its previous run's image on disk, and
        # slicing that produces a legible-looking band of STALE content, which
        # then gets reviewed as if it were current (observed: medium-generic,
        # whose stale slice showed a Google SERP long after the domain had been
        # re-captured as a skip).
        score_path = run_dir / f"{domain}--score.json"
        if score_path.exists():
            try:
                status = json.loads(score_path.read_text(encoding="utf-8")).get("status")
                if status != "ok":
                    print(f"SKIP {domain}: status={status}, image is from an earlier run")
                    continue
            except Exception:
                pass  # sidecar unreadable -- fall through and slice what's there

        # --stale-only: skip a domain whose bands are already cut from THIS
        # image. The inverse case is the dangerous one and the reason this
        # exists: a domain re-captured outside the sweep's own slicing path (a
        # -Resume pass, a SWEEP_ONLY re-run, or the watcher not being up) keeps
        # its OLD bands beside a fresh PNG, and nothing marks them -- measured
        # 2026-09-23, politico's slices were 92h older than its clip while its
        # sidecar and verdict both read as current. Same failure as the two
        # guards below: a legible image that is legible about the wrong thing.
        if args.stale_only:
            band1 = out_dir / f"{domain}--{suffix}-1.png"
            if band1.exists() and band1.stat().st_mtime >= src.stat().st_mtime:
                continue

        # Clear this domain's previous bands first. A run with a smaller --max
        # (or a shorter re-captured clip) otherwise leaves higher-numbered
        # bands from an earlier slice on disk, where anything enumerating the
        # directory -- watch-sweep-stream.mjs announces every band it finds --
        # picks them up and presents STALE content as part of the current clip.
        # Same failure as the status!="ok" guard above: a legible image that is
        # legible about the wrong thing.
        for old in out_dir.glob(f"{domain}--{suffix}-*.png"):
            old.unlink()

        with Image.open(src) as im:
            width, height = im.size
            total_bands = -(-height // args.band)  # ceil div
            bands = min(total_bands, args.max)
            for i in range(bands):
                y = i * args.band
                h = min(args.band, height - y)
                if h <= 0:
                    break
                out_path = out_dir / f"{domain}--{suffix}-{i + 1}.png"
                im.crop((0, y, width, y + h)).save(out_path)
                print(out_path)
                written += 1
            # Say so when the clip extends past what was written. Without this
            # a truncated slice is INDISTINGUISHABLE at review time from a
            # complete one -- which is how a band-1-only verdict came to assert
            # what the whole clip did or didn't contain. A reviewer who sees
            # this line and needs the rest re-runs with --max.
            if total_bands > bands:
                print(
                    f"   ^ {domain}: showing {bands} of {total_bands} bands "
                    f"({height}px tall) -- {total_bands - bands} NOT written; "
                    f"re-run with --max {total_bands} to see the rest"
                )

    print(f"-- {written} band(s) written for {len(domains)} domain(s) [{kind}]")


if __name__ == "__main__":
    main()
