#!/usr/bin/env python3
"""Build UwU Sans from Atkinson Hyperlegible Next (SIL OFL 1.1).

Reproducible: the upstream variable TTF is pinned by commit and SHA-256, the
Python dependencies by requirements.txt. Run from a venv:

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python build.py            # writes UwUSans[wght].woff2 (+ .ttf in .cache/)
    .venv/bin/python test_shaping.py     # shaping tests
    .venv/bin/python specimen.py out.png # proof sheet

What it does (see FONTLOG.txt):
  1. download + verify the upstream variable font (roman, wght 200-800)
  2. subset to Latin, Latin Extended, punctuation, currency, arrows
  3. add new glyphs drawn here as code: Nyu cat face (U+E000), heart (U+2665),
     arrows (U+2190-2193); every glyph gets gvar deltas so its strokes follow wght.
     They are reachable by code point only: no ligatures (dropped in 1.100,
     ":3" and "<3" must keep their meaning)
  4. rename everything (family "UwU Sans"), rebuild HVAR, write WOFF2
"""

from __future__ import annotations

import hashlib
import math
import shutil
import sys
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import flagOverlapSimple as OVERLAP_SIMPLE
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.varLib.hvar import add_HVAR

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"

UPSTREAM_COMMIT = "7925f50f649b3813257faf2f4c0b381011f434f1"
UPSTREAM_FILE = "fonts/variable/AtkinsonHyperlegibleNext%5Bwght%5D.ttf"
UPSTREAM_URL = (
    "https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/"
    f"{UPSTREAM_COMMIT}/{UPSTREAM_FILE}"
)
UPSTREAM_SHA256 = "5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745"
UPSTREAM_VERSION = "2.001"

VERSION = "1.100"
FAMILY = "UwU Sans"
PS_FAMILY = "UwUSans"
OUT_NAME = "UwUSans[wght].woff2"

# Stroke width of the drawn glyphs per master. Measured on upstream stems
# (l/n at 200/400/800 = 54/85/166) and kept a little lighter, because
# pictograms look heavier than letters at the same stroke.
STROKE = {200: 50.0, 400: 80.0, 800: 140.0}
MASTERS = (200, 400, 800)

CAP = 668
OVERSHOOT = 10

SUBSET_UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x250))  # Latin-1, Latin Extended-A/B
    + list(range(0x250, 0x2B0))  # IPA (whatever upstream has)
    + list(range(0x2B0, 0x370))  # modifiers + combining marks (ccmp)
    + list(range(0x1E00, 0x1F00))  # Latin Extended Additional (ẞ, Vietnamese)
    + list(range(0x2000, 0x2070))  # general punctuation („ “ « » – … ‰)
    + list(range(0x20A0, 0x20D0))  # currency (€ ₹)
    + list(range(0x2100, 0x2150))  # letterlike (™ ℓ ℮)
    + list(range(0x2190, 0x2200))  # arrows
    + list(range(0x2200, 0x2300))  # math operators upstream ships
    + [0x25CA, 0x2665, 0x266A, 0xE000]
)


# --------------------------------------------------------------------------
# upstream


def fetch_upstream() -> Path:
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"AtkinsonHyperlegibleNext-{UPSTREAM_COMMIT[:12]}.ttf"
    if not path.exists():
        print(f"downloading {UPSTREAM_URL}")
        with urllib.request.urlopen(UPSTREAM_URL) as r:  # noqa: S310 (pinned https URL)
            data = r.read()
        path.write_bytes(data)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != UPSTREAM_SHA256:
        path.unlink()
        sys.exit(f"upstream checksum mismatch: {digest}")
    return path


# --------------------------------------------------------------------------
# geometry helpers. Contours are lists of (x, y, on_curve). Quadratic arcs:
# on-curve points at the segment ends, one off-curve point in between.


def arc(cx, cy, r, a0, a1, n):
    """Arc from angle a0 to a1 (degrees) with n quadratic segments.
    Returns points without the final on-curve point."""
    pts = []
    step = (a1 - a0) / n
    k = r / math.cos(math.radians(step / 2))
    for i in range(n):
        a = a0 + i * step
        pts.append((cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)), True))
        m = a + step / 2
        pts.append((cx + k * math.cos(math.radians(m)), cy + k * math.sin(math.radians(m)), False))
    return pts


def ellipse(cx, cy, rx, ry, n=8, cw=True):
    pts = arc(0, 0, 1, 90, 90 - 360 if cw else 90 + 360, n)
    return [(cx + x * rx, cy + y * ry, on) for x, y, on in pts]


def norm(vx, vy):
    d = math.hypot(vx, vy)
    return vx / d, vy / d


def offset_line(p, q, dist):
    """Line p->q shifted by dist to the LEFT of the travel direction."""
    dx, dy = norm(q[0] - p[0], q[1] - p[1])
    nx, ny = -dy, dx
    return (p[0] + nx * dist, p[1] + ny * dist), (q[0] + nx * dist, q[1] + ny * dist)


def line_x_line(p1, p2, p3, p4):
    x1, y1 = p1
    x2, y2 = p2
    x3, y3 = p3
    x4, y4 = p4
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    return x1 + t * (x2 - x1), y1 + t * (y2 - y1)


def line_x_circle(p, q, c, r, near):
    """Intersection of the infinite line pq with circle (c, r) closest to `near`."""
    dx, dy = q[0] - p[0], q[1] - p[1]
    fx, fy = p[0] - c[0], p[1] - c[1]
    a = dx * dx + dy * dy
    b = 2 * (fx * dx + fy * dy)
    cc = fx * fx + fy * fy - r * r
    disc = math.sqrt(max(b * b - 4 * a * cc, 0.0))
    sols = [(-b - disc) / (2 * a), (-b + disc) / (2 * a)]
    pts = [(p[0] + t * dx, p[1] + t * dy) for t in sols]
    return min(pts, key=lambda s: math.hypot(s[0] - near[0], s[1] - near[1]))


def angle_of(c, p):
    return math.degrees(math.atan2(p[1] - c[1], p[0] - c[0]))


def rounded_corner(p_in, corner, p_out, radius):
    """Replace a sharp corner by on-off-on: on-curve points `radius` before and
    after the corner along the two edges, the corner itself as off-curve."""
    a = norm(p_in[0] - corner[0], p_in[1] - corner[1])
    b = norm(p_out[0] - corner[0], p_out[1] - corner[1])
    return [
        (corner[0] + a[0] * radius, corner[1] + a[1] * radius, True),
        (corner[0], corner[1], False),
        (corner[0] + b[0] * radius, corner[1] + b[1] * radius, True),
    ]


def rotate(contours, cx, cy, deg):
    s, c = math.sin(math.radians(deg)), math.cos(math.radians(deg))
    return [
        [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c, on) for x, y, on in ct]
        for ct in contours
    ]


# --------------------------------------------------------------------------
# glyphs. Each function takes the stroke width w and returns
# (contours, advance). Point structure must not depend on w (gvar).


def nyu(w):
    """Cat face: round head with two ears as one stroked outline (ears open
    into the face), two oval eyes, a ':3' mouth turned into an omega."""
    sb = 40 + (w - 80) * 0.25
    R = 262.0 + (w - 80) * 0.35  # centerline radius of the head (a bit wider when bold)
    cy = -OVERSHOOT + R + w / 2  # the head's outer bottom sits on the overshoot line
    cx = sb + R + w / 2 + 6
    c = (cx, cy)
    # right ear on the centerline: junctions on the head circle, rounded tip.
    # Tip and junctions scale with the head so the ears keep their shape.
    jo, ji = 22.0, 80.0  # junction angles (deg) outside / towards the top
    tip_r = (cx + R * 0.80, cy + R * 1.30)

    def ear_points(side):
        s = 1 if side == "r" else -1

        def mirror(p):
            return (cx + s * (p[0] - cx), p[1])

        a_o = jo if s == 1 else 180 - jo
        a_i = ji if s == 1 else 180 - ji
        J_o = (cx + R * math.cos(math.radians(a_o)), cy + R * math.sin(math.radians(a_o)))
        J_i = (cx + R * math.cos(math.radians(a_i)), cy + R * math.sin(math.radians(a_i)))
        return J_o, mirror(tip_r), J_i

    # Centerline (counter-clockwise): right ear (Jo -> T -> Ji), top arc,
    # left ear (Ji -> T -> Jo), bottom arc back to the right ear.
    rJo, rT, rJi = ear_points("r")
    lJo, lT, lJi = ear_points("l")
    legs = [(rJo, rT), (rT, rJi), (lJi, lT), (lT, lJo)]

    def contour(dist):
        """Offset of the centerline by dist to the left (inside for CCW)."""
        r = R - dist
        L = [offset_line(p, q, dist) for p, q in legs]
        pts = []
        # right ear
        a = line_x_circle(*L[0], c, r, rJo)
        t = line_x_line(*L[0], *L[1])
        b = line_x_circle(*L[1], c, r, rJi)
        pts.append((*a, True))
        tip_round = 34 if dist < 0 else 14
        pts += rounded_corner(a, t, b, tip_round)
        # top arc from b to the left ear's first junction
        a2 = line_x_circle(*L[2], c, r, lJi)
        pts += arc(cx, cy, r, angle_of(c, b), angle_of(c, a2), 3)
        t2 = line_x_line(*L[2], *L[3])
        b2 = line_x_circle(*L[3], c, r, lJo)
        pts.append((*a2, True))
        pts += rounded_corner(a2, t2, b2, tip_round)
        # bottom arc back round to the start
        a_end = angle_of(c, a) + 360
        pts += arc(cx, cy, r, angle_of(c, b2), a_end, 8)
        return pts

    outer = list(reversed(contour(-w / 2)))  # clockwise
    inner = contour(w / 2)  # counter-clockwise -> counter
    # eyes: filled vertical ovals
    er = 34 + w * 0.18
    ey = cy + R * 0.16
    ex = R * 0.42
    eyes = [ellipse(cx - ex, ey, er * 0.88, er * 1.12), ellipse(cx + ex, ey, er * 0.88, er * 1.12)]
    # mouth: two lower half-circle strokes with round caps (":3" turned 90°)
    mw = w * 0.58
    m = mw * 0.5 + 22
    my = cy - R * 0.26

    def bowl(mx):
        ro, ri = m + mw / 2, m - mw / 2
        pts = []
        # outer arc, clockwise: from the right end (0°) down to the left end (180°)
        pts += arc(mx, my, ro, 0, -180, 4)
        # left cap (round, half circle of radius mw/2 at (mx - m, my))
        pts += arc(mx - m, my, mw / 2, 180, 0, 2)
        # inner arc back: from 180° to 0° going through the bottom (-90°)
        pts += arc(mx, my, ri, -180, 0, 4)
        # right cap
        pts += arc(mx + m, my, mw / 2, 180, 0, 2)
        return pts

    mouth = [bowl(cx - m), bowl(cx + m)]
    adv = cx + R + w / 2 + 6 + sb
    return [outer, inner, *eyes, *mouth], round(adv)


def heart(w):
    """Filled heart, cap height, gets a bit fuller with weight."""
    grow = (w - 80) * 0.30
    sb = 40.0
    r = 196.0 + grow
    d = 150.0
    cx = sb + d + r
    top = CAP + OVERSHOOT
    cy = top - r
    tip = (cx, 4 - grow * 0.6)
    left = (cx - d, cy)
    right = (cx + d, cy)

    # tangent point on the left circle (contour runs clockwise: tip -> left -> top -> right -> tip)
    def tangent_point(center, sign):
        dx, dy = center[0] - tip[0], center[1] - tip[1]
        dist = math.hypot(dx, dy)
        base = math.atan2(dy, dx)
        off = math.asin(r / dist)
        ang = base + sign * off  # direction of the tangent line from the tip
        length = math.sqrt(dist * dist - r * r)
        return (tip[0] + math.cos(ang) * length, tip[1] + math.sin(ang) * length)

    tl = tangent_point(left, +1)
    tr = tangent_point(right, -1)
    cusp_y = cy + math.sqrt(max(r * r - d * d, 0))
    cusp = (cx, cusp_y)
    pts = [(*tip, True), (*tl, True)]
    pts += arc(*left, r, angle_of(left, tl), angle_of(left, cusp) - 360 if angle_of(left, cusp) > angle_of(left, tl) else angle_of(left, cusp), 4)
    pts.append((*cusp, True))
    a_end = angle_of(right, tr)
    a_start = angle_of(right, cusp)
    if a_end > a_start:
        a_end -= 360
    pts += arc(*right, r, a_start, a_end, 4)
    pts.append((*tr, True))
    # the arc helper emits on-curve start points; drop duplicates at joins
    clean = []
    for p in pts:
        if clean and clean[-1][2] and p[2] and math.hypot(clean[-1][0] - p[0], clean[-1][1] - p[1]) < 0.5:
            continue
        clean.append(p)
    adv = cx + d + r + sb
    return [clean], round(adv)


def arrow_right(w):
    """Arrow in the style of the upstream hyphen/chevrons: a shaft and an open
    chevron head, centered on the math axis."""
    sb = 50.0
    length = 560.0
    axis = 330.0  # hyphen/math axis of upstream
    head = 185.0  # chevron arm reach (x) back from the tip
    x0, x1 = sb, sb + length
    h = w / 2
    # chevron: outer tip at x1; arms 45° up/down
    t = w * math.sqrt(2)  # horizontal thickness of a 45° arm
    tip = (x1, axis)
    inner_tip = (x1 - t, axis)
    up_o = (x1 - head, axis + head)
    up_i = (up_o[0] - t, up_o[1])  # arm ends cut horizontally
    dn_o = (x1 - head, axis - head)
    dn_i = (dn_o[0] - t, dn_o[1])
    chevron = [
        (*tip, True),
        (*dn_o, True),
        (*dn_i, True),
        (*inner_tip, True),
        (*up_i, True),
        (*up_o, True),
    ]
    end = x1 - w * 1.1  # overlaps into the solid part of the chevron
    shaft = [(x0, axis - h, True), (x0, axis + h, True), (end, axis + h, True), (end, axis - h, True)]
    return [chevron, shaft], round(x1 + sb)


NEW_GLYPHS = {
    # name: (codepoint, drawing function)
    "nyu": (0xE000, nyu),
    "heart": (0x2665, heart),
    "arrowright": (0x2192, arrow_right),
    "arrowleft": (0x2190, lambda w: _rotated_arrow(w, 180)),
    "arrowup": (0x2191, lambda w: _rotated_arrow(w, 90)),
    "arrowdown": (0x2193, lambda w: _rotated_arrow(w, -90)),
}


def _rotated_arrow(w, deg):
    contours, adv = arrow_right(w)
    cx = adv / 2
    if deg in (90, -90):
        # vertical arrows: centered on the advance, spanning cap height
        ct = rotate(contours, cx, 330.0, deg)
        ys = [p[1] for c in ct for p in c]
        dy = (CAP / 2) - (min(ys) + max(ys)) / 2
        ct = [[(x, y + dy, on) for x, y, on in c] for c in ct]
        xs = [p[0] for c in ct for p in c]
        new_adv = (max(xs) - min(xs)) + 2 * 70
        dx = 70 - min(xs)
        ct = [[(x + dx, y, on) for x, y, on in c] for c in ct]
        return ct, round(new_adv)
    return rotate(contours, cx, 330.0, deg), adv


# --------------------------------------------------------------------------
# glyph construction + variations


def signed_area(ct):
    a = 0.0
    for i, (x, y, _) in enumerate(ct):
        x2, y2, _ = ct[(i + 1) % len(ct)]
        a += x * y2 - x2 * y
    return a / 2


def build_glyph(contours, cw_first=True):
    """TrueType wants outer contours clockwise. Each drawing function returns
    outer contours clockwise already except where noted; we enforce it for
    single-contour shapes (heart, arrows) by area sign."""
    pen = TTGlyphPen(None)
    for ct in contours:
        start = 0
        # TTGlyphPen needs an on-curve start point
        for i, p in enumerate(ct):
            if p[2]:
                start = i
                break
        ct = ct[start:] + ct[:start]
        pen.moveTo((round(ct[0][0]), round(ct[0][1])))
        buf = []
        for x, y, on in ct[1:]:
            pt = (round(x), round(y))
            if on:
                if buf:
                    pen.qCurveTo(*buf, pt)
                    buf = []
                else:
                    pen.lineTo(pt)
            else:
                buf.append(pt)
        if buf:
            pen.qCurveTo(*buf, (round(ct[0][0]), round(ct[0][1])))
        pen.closePath()
    return pen.glyph()


def oriented(name, contours):
    """Return contours with the right direction: outer clockwise (negative
    area in y-up coords), counters counter-clockwise."""
    if name == "nyu":
        return contours  # built with explicit directions
    out = []
    for ct in contours:
        out.append(ct if signed_area(ct) < 0 else list(reversed(ct)))
    return out


def glyph_coords(glyph, glyf):
    coords, _, _ = glyph.getCoordinates(glyf)
    return list(coords)


def add_new_glyphs(font: TTFont):
    glyf = font["glyf"]
    hmtx = font["hmtx"]
    gvar = font["gvar"]
    order = font.getGlyphOrder()
    cmap_tables = [t for t in font["cmap"].tables if t.isUnicode()]
    gdef = font["GDEF"].table
    for name, (cp, fn) in NEW_GLYPHS.items():
        per_master = {}
        for m in MASTERS:
            contours, adv = fn(STROKE[m])
            per_master[m] = (oriented(name, contours), adv)
        g = build_glyph(per_master[400][0])
        g.recalcBounds(glyf)
        # mark overlapping contours so CoreText renders them correctly
        if g.numberOfContours > 0:
            g.flags[0] |= OVERLAP_SIMPLE
        order.append(name)
        glyf.glyphs[name] = g
        glyf.glyphOrder = order
        hmtx.metrics[name] = (per_master[400][1], g.xMin)
        for t in cmap_tables:
            if cp <= 0xFFFF or t.format == 12:
                t.cmap[cp] = name
        # gvar: deltas between the masters, including phantom points
        base = [(round(x), round(y)) for ct in per_master[400][0] for x, y, _ in ct]
        base_adv = per_master[400][1]
        variations = []
        for m, peak in ((200, -1.0), (800, 1.0)):
            pts = [(round(x), round(y)) for ct in per_master[m][0] for x, y, _ in ct]
            assert len(pts) == len(base), f"{name}: point structure differs at {m}"
            # build_glyph rotates each contour to start on-curve: apply same rotation
            deltas = _deltas_in_glyph_order(per_master[400][0], per_master[m][0])
            adv_d = per_master[m][1] - base_adv
            # phantom points: left origin, right (advance), top, bottom
            deltas += [(0, 0), (adv_d, 0), (0, 0), (0, 0)]
            variations.append(TupleVariation({"wght": (peak, peak, 0.0) if peak < 0 else (0.0, peak, peak)}, deltas))
        gvar.variations[name] = variations
        if gdef.GlyphClassDef is not None:
            gdef.GlyphClassDef.classDefs[name] = 1
    font.setGlyphOrder(order)
    font["maxp"].numGlyphs = len(order)


def _deltas_in_glyph_order(base_contours, master_contours):
    out = []
    for cb, cm in zip(base_contours, master_contours):
        start = next(i for i, p in enumerate(cb) if p[2])
        cb = cb[start:] + cb[:start]
        cm = cm[start:] + cm[:start]
        for (bx, by, _), (mx, my, _) in zip(cb, cm):
            out.append((round(mx) - round(bx), round(my) - round(by)))
    return out


# --------------------------------------------------------------------------
# naming


def rename(font: TTFont):
    name = font["name"]
    copyright_ = (
        "Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors "
        "(https://github.com/googlefonts/atkinson-hyperlegible-next). "
        "Copyright 2026 MinifyX (UwU Sans, a modified version)"
    )
    values = {
        0: copyright_,
        1: FAMILY,
        2: "Regular",
        3: f"{VERSION};MFX;{PS_FAMILY}-Regular",
        4: f"{FAMILY} Regular",
        5: f"Version {VERSION}; based on Atkinson Hyperlegible Next {UPSTREAM_VERSION}",
        6: f"{PS_FAMILY}-Regular",
        8: "MinifyX",
        9: "Elliott Scott, Megan Eiswerth, Linus Boman, Theodore Petrosky, Letters from Sweden "
        "(Atkinson Hyperlegible Next); MinifyX (UwU Sans additions)",
        10: "UwU Sans is a modified version of Atkinson Hyperlegible Next (Braille Institute) "
        "with a Nyu cat face, a heart and arrows. It is not affiliated "
        "with or endorsed by the Braille Institute.",
        11: "https://github.com/MinifyX/UwUSuite-Design",
        12: "https://github.com/MinifyX/UwUSuite-Design",
        25: PS_FAMILY,
    }
    # drop names we do not set (16/17 typographic family, trademark, ...)
    keep_ids = set(values) | {13, 14} | {r.nameID for r in name.names if r.nameID >= 256}
    name.names = [r for r in name.names if r.nameID in keep_ids]
    for nid, val in values.items():
        name.removeNames(nameID=nid)
        name.setName(val, nid, 3, 1, 0x409)
    font["OS/2"].achVendID = "MFX "
    font["head"].fontRevision = float(VERSION)
    for r in name.names:
        text = r.toUnicode()
        assert "Atkinson" not in text or r.nameID in (0, 5, 9, 10), (r.nameID, text)
        assert "Hyperlegible" not in text or r.nameID in (0, 5, 9, 10), (r.nameID, text)


# --------------------------------------------------------------------------


def build() -> Path:
    src = fetch_upstream()
    font = TTFont(src)

    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = True
    opts.hinting = False  # upstream variable font ships no instructions worth keeping
    opts.drop_tables += ["DSIG"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=SUBSET_UNICODES)
    sub.subset(font)

    add_new_glyphs(font)
    rename(font)
    if "HVAR" in font:
        del font["HVAR"]
    add_HVAR(font)
    font["post"].formatType = 2.0

    # deterministic output: keep upstream's timestamps instead of "now"
    font.recalcTimestamp = False
    font["head"].modified = font["head"].created

    CACHE.mkdir(exist_ok=True)
    ttf = CACHE / "UwUSans[wght].ttf"
    font.save(ttf)
    font = TTFont(ttf, recalcTimestamp=False)
    font.flavor = "woff2"
    out = HERE / OUT_NAME
    font.save(out)
    print(f"wrote {out.name}: {out.stat().st_size} bytes (ttf {ttf.stat().st_size})")
    return out


def install(out: Path):
    dest = HERE.parents[2] / "apps" / "desktop" / "src" / "assets" / "fonts" / OUT_NAME
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(out, dest)
    print(f"copied to {dest.relative_to(HERE.parents[2])}")


if __name__ == "__main__":
    out = build()
    if "--install" in sys.argv:
        install(out)
