#!/usr/bin/env python3
"""Build host font.png + font.png.dat from Schwung's font4x5 glyph table."""
from __future__ import annotations

import argparse
import re
import urllib.request
from pathlib import Path

from PIL import Image

FONT4X5_URL = (
    "https://raw.githubusercontent.com/charlesvestal/schwung/main/"
    "src/shared/param_pages/font4x5.mjs"
)

# Fallback printable ASCII not in font4x5 — use 5x7-ish blanks / simple shapes.
CELL_W = 5
CELL_H = 5


def fetch_source(path: Path | None) -> str:
    if path and path.exists():
        return path.read_text(encoding="utf-8")
    with urllib.request.urlopen(FONT4X5_URL) as resp:
        return resp.read().decode("utf-8")


def parse_js_string(literal: str) -> str:
    """Decode a JS double-quoted string body (handles \\ and \\\")."""
    out: list[str] = []
    i = 0
    while i < len(literal):
        if literal[i] == "\\" and i + 1 < len(literal):
            nxt = literal[i + 1]
            out.append({"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'"}.get(nxt, nxt))
            i += 2
            continue
        out.append(literal[i])
        i += 1
    return "".join(out)


def parse_font4x5(src: str) -> tuple[str, list[list[int]]]:
    chars_m = re.search(r'export const CHARS = "((?:\\.|[^"\\])*)"', src)
    if not chars_m:
        raise SystemExit("CHARS not found")
    chars = parse_js_string(chars_m.group(1))
    start = src.index("const G = [")
    end = src.index("];", start)
    body = src[start:end]
    entries = re.findall(
        r"\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)((?:,\s*-?\d+)*)\]",
        body,
    )
    if len(entries) != len(chars):
        raise SystemExit(f"glyph count {len(entries)} != chars {len(chars)}")
    glyphs: list[list[int]] = []
    for adv, yoff, w, h, rest in entries:
        bits = [int(x) for x in rest.split(",") if x.strip()]
        glyphs.append([int(adv), int(yoff), int(w), int(h), *bits])
    return chars, glyphs


def blit_glyph(img: Image.Image, x0: int, glyph: list[int]) -> None:
    adv, yoff, w, h, *rows = glyph
    del adv
    for r, bits in enumerate(rows):
        y = yoff + r
        if y < 0 or y >= CELL_H:
            continue
        for c in range(w):
            if bits & (1 << c):
                x = x0 + c
                if 0 <= x < x0 + CELL_W:
                    img.putpixel((x, y), (255, 255, 255, 255))


# Hand glyphs for punctuation our UI uses that font4x5 omits.
EXTRA: dict[str, list[int]] = {
    # [ advance=3 body 2×5
    "[": [3, 0, 2, 5, 3, 1, 1, 1, 3],
    # ] advance=3 body 2×5
    "]": [3, 0, 2, 5, 3, 2, 2, 2, 3],
}


def build(chars: str, glyphs: list[list[int]], out: Path) -> None:
    # Atlas must cover printable ASCII so host fallbacks (lowercase etc.) exist.
    atlas_chars = [chr(c) for c in range(32, 127)]
    by_char = {ch: g for ch, g in zip(chars, glyphs)}
    by_char.update(EXTRA)
    img = Image.new("RGBA", (len(atlas_chars) * CELL_W, CELL_H), (0, 0, 0, 0))
    for i, ch in enumerate(atlas_chars):
        glyph = by_char.get(ch) or by_char.get(ch.upper())
        if glyph:
            blit_glyph(img, i * CELL_W, glyph)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    # Host strips only trailing \\n; a Windows \\r would bump numChars and
    # scramble charW (width/numChars), so write LF-only bytes.
    dat = out.with_name(out.name + ".dat")
    dat.write_bytes(("".join(atlas_chars) + "\n").encode("utf-8"))
    print(f"wrote {out} ({len(atlas_chars)} chars, cell {CELL_W}x{CELL_H})")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--src", type=Path, default=None)
    p.add_argument("--out", type=Path, required=True)
    args = p.parse_args()
    chars, glyphs = parse_font4x5(fetch_source(args.src))
    build(chars, glyphs, args.out)


if __name__ == "__main__":
    main()
