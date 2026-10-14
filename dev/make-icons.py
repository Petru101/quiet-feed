# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

"""Render icons/icon.svg to PNGs at the sizes Firefox and AMO want.

The SVG stays the source of truth and is what the popup and settings pages use;
these PNGs are for the manifest, where a raster icon is the safe choice.

Run from the project root:  python dev/make-icons.py
"""

from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 96, 128]
SS = 16                      # supersample factor, downsampled with LANCZOS
BOX = 64                     # the SVG viewBox

BLUE = (47, 111, 237, 255)           # #2f6fed
RED = (255, 77, 77, 255)             # #ff4d4d
# The bars are white at 92% and 55% over the blue; precomputed so they can be
# drawn opaque, which keeps PIL's compositing out of it.
BAR_BRIGHT = (238, 243, 254, 255)
BAR_DIM = (161, 190, 247, 255)


def s(v):
    """SVG units -> supersampled pixels."""
    return v * SS


def render():
    img = Image.new('RGBA', (s(BOX), s(BOX)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # card
    d.rounded_rectangle([s(4), s(9), s(60), s(55)], radius=s(11), fill=BLUE)

    # three lines of "text"
    for x, y, w, colour in [
        (14, 21, 36, BAR_BRIGHT),
        (14, 32, 25, BAR_BRIGHT),
        (14, 43, 31, BAR_DIM),
    ]:
        d.rounded_rectangle([s(x), s(y), s(x + w), s(y + 5)], radius=s(2.5), fill=colour)

    # the strike-through, with round caps drawn on as circles
    x0, y0, x1, y1 = 11, 55, 53, 11
    width = 7
    d.line([s(x0), s(y0), s(x1), s(y1)], fill=RED, width=int(s(width)))
    r = s(width) / 2
    for cx, cy in [(x0, y0), (x1, y1)]:
        d.ellipse([s(cx) - r, s(cy) - r, s(cx) + r, s(cy) + r], fill=RED)

    return img


def main():
    master = render()
    for size in SIZES:
        out = master.resize((size, size), Image.LANCZOS)
        path = 'icons/icon-%d.png' % size
        out.save(path, 'PNG', optimize=True)
        print('wrote %s' % path)


if __name__ == '__main__':
    main()
