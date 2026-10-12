# Mağaza ekran görüntüleri: dar yan-panel kırpıntılarını 1280x800 RGB PNG'ye çevirir.
# Panel oranını korur (esneme yok), alfa yok, zemini panelin temasına uydurur (karışık set).
# Kullanım: <venv-python> scripts/make-store-screenshots.py <girdi-klasörü> [çıktı-klasörü]

import glob
import os
import sys

from PIL import Image

TARGET = (1280, 800)
PANEL_H = 740  # panelin hedef yüksekliği (alt-üst pay bırakır)

DARK_TOP, DARK_BOTTOM = (15, 23, 42), (49, 46, 129)
LIGHT_TOP, LIGHT_BOTTOM = (248, 250, 252), (224, 231, 255)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, top, bottom):
    img = Image.new('RGB', size)
    px = img.load()
    for y in range(size[1]):
        c = lerp(top, bottom, y / max(size[1] - 1, 1))
        for x in range(size[0]):
            px[x, y] = c
    return img


def is_dark(im):
    g = im.convert('L').resize((16, 16))
    h = g.histogram()
    dark = sum(h[:128])
    return dark >= sum(h[128:])


def compose(src, dst):
    panel = Image.open(src).convert('RGBA')
    dark = is_dark(panel)
    bg = gradient(TARGET, *(DARK_TOP, DARK_BOTTOM) if dark else (LIGHT_TOP, LIGHT_BOTTOM))
    flat = Image.new('RGBA', panel.size, (0, 0, 0, 0))
    # Alfa varsa zemine uygun düz renkle birleştir
    base = Image.new('RGB', panel.size, DARK_BOTTOM if dark else LIGHT_BOTTOM)
    base.paste(panel, (0, 0), panel)
    scale = PANEL_H / base.size[1]
    nw = max(1, int(base.size[0] * scale))
    base = base.resize((nw, PANEL_H), Image.LANCZOS)
    bg.paste(base, ((TARGET[0] - nw) // 2, (TARGET[1] - PANEL_H) // 2))
    bg.save(dst)
    print(dst, bg.size, bg.mode)


def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'release', 'store-graphics')
    os.makedirs(out_dir, exist_ok=True)
    files = sorted(glob.glob(os.path.join(src_dir, 'Screenshot_2[56789]_*.png')))
    for i, f in enumerate(files, 1):
        compose(f, os.path.join(out_dir, 'heraai-screenshot-%d-1280x800.png' % i))


if __name__ == '__main__':
    main()
