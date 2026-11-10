"""Make site/fonts/MikkelWind-typing.ttf: MikkelWind plus Ä Ö Ü (the letter with two of the
font's own full stops as dots, like the post draws them). Used only for the title while you
type it on the post, so the letters don't switch to another font.   python3 tools/make_typing_font.py"""
import os
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
f = TTFont(os.path.join(ROOT, "site", "fonts", "MikkelWind.ttf"))
glyf, hmtx, cmap = f["glyf"], f["hmtx"], f.getBestCmap()
upm = f["head"].unitsPerEm
dot = glyf["period"]; dot.recalcBounds(glyf)
S = 0.8                                             # dots at 80 % size, as on the post
dw, dh = (dot.xMax - dot.xMin) * S, (dot.yMax - dot.yMin) * S
for ch, base in (("Ä", "A"), ("Ö", "O"), ("Ü", "U")):
    g = glyf[cmap[ord(base)]]; g.recalcBounds(glyf)
    w = g.xMax - g.xMin
    top = max(y for (x, y) in g.getCoordinates(glyf)[0] if x > g.xMin + w * 0.2 and x < g.xMax - w * 0.2) if g.numberOfContours > 0 else g.yMax
    cy = top + upm * 0.06 + dh / 2                  # dot centre just above the letter
    # the font leans: centre of the ink near the top of the letter
    tops = [x for (x, y) in g.getCoordinates(glyf)[0] if y > g.yMax - (g.yMax - g.yMin) * 0.2] if g.numberOfContours > 0 else [g.xMin, g.xMax]
    cx = (min(tops) + max(tops)) / 2
    comps = []
    c = GlyphComponent(); c.glyphName = cmap[ord(base)]; c.x, c.y = 0, 0; c.flags = 0x4; comps.append(c)
    for dx in (-w * 0.22, w * 0.22):
        d = GlyphComponent(); d.glyphName = "period"
        d.x = round(cx + dx - (dot.xMin * S) - dw / 2); d.y = round(cy - (dot.yMin * S) - dh / 2)
        d.transform = [[S, 0], [0, S]]; d.flags = 0x4; comps.append(d)
    new = Glyph(); new.numberOfContours = -1; new.components = comps
    name = base + "dieresis.typing"
    glyf.glyphs[name] = new; order = f.getGlyphOrder() + [name]; f.setGlyphOrder(order); glyf.glyphOrder = order
    hmtx.metrics[name] = hmtx.metrics[cmap[ord(base)]]
    for t in f["cmap"].tables:
        if t.isUnicode(): t.cmap[ord(ch)] = name
    glyf[name].recalcBounds(glyf)
f.save(os.path.join(ROOT, "site", "fonts", "MikkelWind-typing.ttf"))
print("saved")
