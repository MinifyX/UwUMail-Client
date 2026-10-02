#!/usr/bin/env python3
"""Render a proof sheet of the built font to a PNG (HarfBuzz shaping +
FreeType rasterizing, no browser needed).

    .venv/bin/python specimen.py proof.png
"""

from __future__ import annotations

import sys
from pathlib import Path

import freetype
import uharfbuzz as hb
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
TTF = HERE / ".cache" / "UwUSans[wght].ttf"

LINES = [
    (96, 400, " ♥ ← ↑ ↓ →  Hxg"),
    (40, 400, "Hallo :3   <3 Nyu   10:30   um 9:30   a<3b   3<3"),
    (40, 400, "Übergrößenträger ẞ ÄÖÜ äöü „Zitat“ «guillemets» 12,50 €"),
]
for w in (200, 300, 400, 500, 600, 700, 800):
    LINES.append((34, w, f"{w} Hamburgefonstiv :3 <3  ♥ → 0123456789"))
LINES += [
    (20, 400, "Klein: Danke dir <3 bis morgen :3 · Termin 10:30 → Raum 3 · x<3 · 1<35 · 3:33"),
    (14, 400, "14px: Hallo :3 wie geht's? <3 Nyu → Posteingang (12) · Termin 10:30"),
    (14, 700, "14px bold: Hallo :3 wie geht's? <3 Nyu → Posteingang (12)"),
]


def shape(blob_face, text, size, wght):
    font = hb.Font(blob_face)
    font.set_variations({"wght": wght})
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {})
    return buf.glyph_infos, buf.glyph_positions


def main(out: str):
    data = TTF.read_bytes()
    hb_face = hb.Face(hb.Blob(data))
    upem = hb_face.upem
    width, margin = 1700, 30
    height = sum(int(s * 1.55) for s, _, _ in LINES) + 2 * margin
    img = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(img)
    y = margin
    face = freetype.Face(str(TTF))
    for size, wght, text in LINES:
        face.set_var_design_coords((wght,))
        face.set_char_size(size * 64)
        infos, poss = shape(hb_face, text, size, wght)
        scale = size / upem
        baseline = y + int(size * 1.15)
        # guides for the big line: baseline, x-height, cap height
        if size >= 90:
            for gy, shade in ((0, 150), (496, 200), (668, 150)):
                yy = baseline - int(gy * scale)
                draw.line([(margin, yy), (width - margin, yy)], fill=shade)
        x = margin
        for info, pos in zip(infos, poss):
            face.load_glyph(info.codepoint, freetype.FT_LOAD_RENDER | freetype.FT_LOAD_NO_HINTING)
            bm = face.glyph.bitmap
            if bm.width and bm.rows:
                glyph = Image.frombytes("L", (bm.width, bm.rows), bytes(bm.buffer), "raw", "L", bm.pitch)
                gx = int(x + pos.x_offset * scale) + face.glyph.bitmap_left
                gy = baseline - int(pos.y_offset * scale) - face.glyph.bitmap_top
                img.paste(0, (gx, gy), glyph)
            x += pos.x_advance * scale
        y += int(size * 1.55)
    img.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "specimen.png")
