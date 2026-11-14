#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["fonttools>=4.50", "skia-pathops>=0.8"]
# ///
"""Build (and optionally install) the pjangler prompt glyph font.

`pjangler-prompt` prints a few icons no Nerd Font carries — today the candybar
candy from delorenj/icons (icons/outline/candy.svg, MIT, Tabler lineage). A
terminal cannot draw an SVG, so this script turns each vendored outline icon
into a filled glyph inside a tiny TTF, "pjangler Prompt Glyphs", that
fontconfig uses as a fallback for codepoints the primary font lacks.

Codepoints live in Supplementary Private Use Area-B (plane 16), which Nerd
Fonts does not touch (its highest is U+F1AF0). Tabler's own codepoint for the
candy, U+EF0D, is NOT usable: Nerd Fonts maps Font Awesome there, so the
primary font would always win and the candy would never show. The glyph keeps
Tabler's number as a mnemonic: U+EF0D -> U+10EF0D.

Keep GLYPHS in sync with src/prompt-pipeline.ts (CANDYBAR_GLYPH).

    scripts/build-prompt-font.py                 # build dist/fonts/pjangler-prompt-glyphs.ttf
    scripts/build-prompt-font.py --install       # ...and copy it to ~/.local/share/fonts + fc-cache
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pathops
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

ROOT = Path(__file__).resolve().parent.parent
GLYPH_DIR = ROOT / "assets" / "prompt-glyphs"
OUT = ROOT / "dist" / "fonts" / "pjangler-prompt-glyphs.ttf"
FAMILY = "pjangler Prompt Glyphs"

# name -> (svg file, codepoint)
GLYPHS = {
    "candy": ("candy.svg", 0x10EF0D),
}

UPM = 1000
ASCENT = 800
DESCENT = 200
VIEWBOX = 24.0
# The icon's 24x24 box maps onto the em square [-DESCENT, ASCENT], with a hair
# of padding so a round cap never touches the cell edge.
PAD = 30
SCALE = (UPM - 2 * PAD) / VIEWBOX


def outline(svg_path: Path) -> pathops.Path:
    """Every <path> of an outline icon, stroked at its stroke-width and unioned into fills."""
    root = ET.parse(svg_path).getroot()
    width = float(root.get("stroke-width", "2"))
    strokes = pathops.Path()
    pen = strokes.getPen()
    found = 0
    for node in root.iter():
        if node.tag.rsplit("}", 1)[-1] == "path" and node.get("d"):
            parse_path(node.get("d"), pen)
            found += 1
    if not found:
        raise SystemExit(f"{svg_path}: no <path d=...> elements")
    # Tabler outline icons are round-capped, round-joined 2px strokes on a 24px grid.
    strokes.stroke(width, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
    # Skia strokes round caps/joins as conics; fonts and simplify() take only quads/cubics.
    strokes.convertConicsToQuads()
    return pathops.simplify(strokes, fix_winding=True, clockwise=False)


def glyph_for(path: pathops.Path):
    tt = TTGlyphPen(None)
    # SVG is y-down from the top-left; a glyph is y-up from the baseline.
    flip = TransformPen(Cu2QuPen(tt, max_err=0.5, reverse_direction=True), (SCALE, 0, 0, -SCALE, PAD, ASCENT - PAD))
    path.draw(flip)
    return tt.glyph()


def build() -> Path:
    order = [".notdef", *GLYPHS]
    glyphs = {".notdef": TTGlyphPen(None).glyph()}
    cmap = {}
    for name, (file, codepoint) in GLYPHS.items():
        glyphs[name] = glyph_for(outline(GLYPH_DIR / file))
        cmap[codepoint] = name

    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    glyf = fb.font["glyf"]
    fb.setupHorizontalMetrics({
        name: (UPM if name != ".notdef" else UPM // 2, getattr(glyf[name], "xMin", 0) if glyf[name].numberOfContours else 0)
        for name in order
    })
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable({"familyName": FAMILY, "styleName": "Regular", "uniqueFontIdentifier": f"{FAMILY} Regular", "fullName": f"{FAMILY} Regular", "psName": "pjanglerPromptGlyphs-Regular", "version": "Version 1.000"})
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=-DESCENT, sTypoLineGap=0, usWinAscent=ASCENT, usWinDescent=DESCENT, achVendID="DELO")
    fb.setupPost(isFixedPitch=0)
    fb.setupHead(unitsPerEm=UPM)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    fb.save(str(OUT))
    return OUT


def install(font: Path) -> Path:
    dest_dir = Path.home() / ".local" / "share" / "fonts"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / font.name
    shutil.copyfile(font, dest)
    if shutil.which("fc-cache"):
        subprocess.run(["fc-cache", "-f", str(dest_dir)], check=False)
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--install", action="store_true", help="copy into ~/.local/share/fonts and refresh fontconfig")
    args = parser.parse_args()
    font = build()
    print(f"built {font.relative_to(ROOT)}: " + ", ".join(f"{n} U+{cp:X}" for n, (_, cp) in GLYPHS.items()))
    if args.install:
        print(f"installed {install(font)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
