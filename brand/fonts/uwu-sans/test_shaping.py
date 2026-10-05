#!/usr/bin/env python3
"""Shaping tests for UwU Sans.

    .venv/bin/python test_shaping.py   (after build.py)

UwU Sans has no ligatures: ":3", "<3" and every other sequence render as the
characters that were typed (until 1.000 a `calt` lookup turned ":3" into Nyu
and "<3" into a heart; that changed the meaning of the symbols and is gone).
The drawn glyphs stay and are reachable by code point: Nyu U+E000, heart
U+2665, arrows U+2190-2193.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
WOFF2 = HERE / "UwUSans[wght].woff2"

DRAWN = {0xE000: "nyu", 0x2665: "heart", 0x2190: "arrowleft", 0x2191: "arrowup", 0x2192: "arrowright", 0x2193: "arrowdown"}

# Text that used to form a ligature, and text that never did: all of it must
# shape to one glyph per character, the glyph the cmap gives for it.
PLAIN = [
    ":3",
    "Hallo :3",
    "<3 Nyu",
    "Danke dir <3",
    "(:3)",
    "<3<3",
    ":3 <3",
    "„:3“",
    "10:30",
    "um 9:30",
    "3:33",
    "x<3",
    "1<35",
    "a<3b",
    "http://localhost:3000",
    "-> => <- != ==",
]
VARIANTS = (({}, 400), ({"tnum": True}, 400), ({}, 200), ({}, 800), ({"calt": True, "liga": True, "dlig": True}, 400))


def shape(face, text, features=None, wght=400):
    font = hb.Font(face)
    font.set_variations({"wght": wght})
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, features or {})
    return [font.glyph_to_string(i.codepoint) for i in buf.glyph_infos]


def main() -> int:
    # uharfbuzz cannot read woff2; decompress via fontTools
    tt = TTFont(io.BytesIO(WOFF2.read_bytes()))
    tt.flavor = None
    raw = io.BytesIO()
    tt.save(raw)
    face = hb.Face(hb.Blob(raw.getvalue()))
    cmap = tt.getBestCmap()
    failures = []
    checks = 0

    tnum_names = {name for name in tt.getGlyphOrder() if name.endswith(".tf")}
    for text in PLAIN:
        for feats, wght in VARIANTS:
            checks += 1
            got = shape(face, text, feats, wght)
            want = [cmap[ord(c)] for c in text]
            if feats.get("tnum"):
                got = [g.removesuffix(".tf") if g in tnum_names else g for g in got]
            if got != want:
                failures.append(f"{text!r} ({feats}, {wght}) shaped as {got}, expected {want}")

    # no contextual or ligature features at all
    tags = {r.FeatureTag for r in tt["GSUB"].table.FeatureList.FeatureRecord}
    checks += 1
    if tags & {"calt", "liga", "dlig", "rlig", "clig"}:
        failures.append(f"GSUB has ligature features: {sorted(tags)}")

    # the drawn glyphs are reachable by code point and have outlines
    glyf = tt["glyf"]
    for cp, name in DRAWN.items():
        checks += 2
        if cmap.get(cp) != name:
            failures.append(f"U+{cp:04X} should map to {name}, got {cmap.get(cp)}")
        if glyf[name].numberOfContours <= 0:
            failures.append(f"{name} has no outline")
        if shape(face, chr(cp)) != [name]:
            failures.append(f"U+{cp:04X} does not shape to {name}")

    # tabular figures: all digits share one advance with tnum
    font = hb.Font(face)
    widths = set()
    for d in "0123456789":
        buf = hb.Buffer()
        buf.add_str(d)
        buf.guess_segment_properties()
        hb.shape(font, buf, {"tnum": True})
        widths.add(buf.glyph_positions[0].x_advance)
    checks += 1
    if len(widths) != 1:
        failures.append(f"tnum digits differ in width: {widths}")

    # naming: no upstream family name left where the OFL asks for a new one
    names = {r.nameID: r.toUnicode() for r in tt["name"].names if r.platformID == 3}
    for nid in (1, 3, 4, 6, 16, 17, 21, 22, 25):
        checks += 1
        if nid in names and ("Atkinson" in names[nid] or "Hyperlegible" in names[nid]):
            failures.append(f"name {nid} still carries the upstream name: {names[nid]}")
    checks += 1
    if names.get(1) != "UwU Sans":
        failures.append(f"family name is {names.get(1)!r}")

    for f in failures:
        print("FAIL", f)
    print(f"{checks - len(failures)}/{checks} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
