#!/usr/bin/env python3
"""Shaping tests for the :3 / <3 ligatures and the new glyphs.

    .venv/bin/python test_ligatures.py   (after build.py)

Rules (calt): ":3" -> nyu and "<3" -> heart, but only when the pair stands
on its own: no letter or digit right before the ":" / "<" and no letter or
digit right after the "3". So times (10:30, 9:30, 3:33), comparisons
(x<3, 1<35, 3<3) and words (a<3b, a:3) keep their characters.
"""

from __future__ import annotations

import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
WOFF2 = HERE / "UwUSans[wght].woff2"

FIRES = {
    ":3": ["nyu"],
    "Hallo :3": ["nyu"],
    "<3 Nyu": ["heart"],
    "Danke dir <3": ["heart"],
    "(:3)": ["nyu"],
    "Hey :3!": ["nyu"],
    "<3<3": ["heart", "heart"],
    ":3 <3": ["nyu", "heart"],
    "„:3“": ["nyu"],
}
STAYS = [
    "10:30",
    "um 9:30",
    "3:33",
    ":30",
    "a:3",
    ":3a",
    "a<3b",
    "x<3",
    "1<35",
    "3<3",
    "<35",
    "http://localhost:3000",
    "Ü:3",
]


def shape(face, text, features=None, wght=400):
    font = hb.Font(face)
    font.set_variations({"wght": wght})
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, features or {})
    return [font.glyph_to_string(i.codepoint) for i in buf.glyph_infos]


def main() -> int:
    data = WOFF2.read_bytes()
    # uharfbuzz cannot read woff2; decompress via fontTools
    import io

    tt = TTFont(io.BytesIO(data))
    tt.flavor = None
    raw = io.BytesIO()
    tt.save(raw)
    face = hb.Face(hb.Blob(raw.getvalue()))
    failures = []

    for text, expected in FIRES.items():
        for feats, wght in (({}, 400), ({"tnum": True}, 400), ({}, 800)):
            got = [g for g in shape(face, text, feats, wght) if g in ("nyu", "heart")]
            if got != expected:
                failures.append(f"expected {expected} in {text!r} ({feats}, {wght}), got {shape(face, text, feats, wght)}")
    for text in STAYS:
        got = shape(face, text)
        if "nyu" in got or "heart" in got:
            failures.append(f"ligature must not fire in {text!r}: {got}")
    # switched off (as the composer does with font-variant-ligatures / "calt" 0)
    for text in FIRES:
        got = shape(face, text, {"calt": False})
        if "nyu" in got or "heart" in got:
            failures.append(f"calt off still forms a ligature in {text!r}")

    # the new glyphs are reachable by code point too
    cmap = tt.getBestCmap()
    for cp, name in ((0xE000, "nyu"), (0x2665, "heart"), (0x2192, "arrowright"), (0x2190, "arrowleft")):
        if cmap.get(cp) != name:
            failures.append(f"U+{cp:04X} should map to {name}, got {cmap.get(cp)}")
    # tabular figures: all digits share one advance with tnum
    font = hb.Font(face)
    widths = set()
    for d in "0123456789":
        buf = hb.Buffer()
        buf.add_str(d)
        buf.guess_segment_properties()
        hb.shape(font, buf, {"tnum": True})
        widths.add(buf.glyph_positions[0].x_advance)
    if len(widths) != 1:
        failures.append(f"tnum digits differ in width: {widths}")
    # naming: no upstream family name left where the OFL asks for a new one
    names = {r.nameID: r.toUnicode() for r in tt["name"].names if r.platformID == 3}
    for nid in (1, 3, 4, 6, 16, 17, 21, 22, 25):
        if nid in names and ("Atkinson" in names[nid] or "Hyperlegible" in names[nid]):
            failures.append(f"name {nid} still carries the upstream name: {names[nid]}")
    if names.get(1) != "UwU Sans":
        failures.append(f"family name is {names.get(1)!r}")

    for f in failures:
        print("FAIL", f)
    total = len(FIRES) * 4 + len(STAYS) + 4 + 2 + 1
    print(f"{total - len(failures)}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
