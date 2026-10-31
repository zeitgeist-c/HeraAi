# Generates store graphics: small promo tile (440x280, dark) + marquee (1400x560, light).
# Outputs are 24-bit RGB PNGs (no alpha) — required by the Chrome Web Store.
# Usage: <venv-python> scripts/make-store-graphics.py [output-dir]

import os
import sys

from PIL import Image, ImageDraw, ImageFont

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_PATH = os.path.join(REPO, 'public', 'icon128.png')
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'release', 'store-graphics')

ARIAL = 'C:/Windows/Fonts/arial.ttf'
ARIAL_BOLD = 'C:/Windows/Fonts/arialbd.ttf'

TITLE = 'HeraAi'
TAGLINE = 'Yan panelde yapay zekâ asistanı'
PROVIDERS = 'Gemini  •  OpenRouter  •  Ollama  •  Tavily'


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size, top, bottom):
    w, h = size
    img = Image.new('RGB', size)
    px = img.load()
    for y in range(h):
        c = lerp(top, bottom, y / max(h - 1, 1))
        for x in range(w):
            px[x, y] = c
    return img


def load_icon(px):
    icon = Image.open(ICON_PATH).convert('RGBA')
    return icon.resize((px, px), Image.LANCZOS)


def paste_icon(base, icon, pos, icon_bg=None):
    if icon_bg is not None:
        pad = int(icon.size[0] * 0.22)
        box = Image.new('RGBA', (icon.size[0] + pad * 2, icon.size[1] + pad * 2), icon_bg)
        base.paste(box, (pos[0] - pad, pos[1] - pad), box)
    base.paste(icon, pos, icon)


def make_small():
    w, h = 440, 280
    img = gradient((w, h), (15, 23, 42), (49, 46, 129))
    d = ImageDraw.Draw(img)
    icon = load_icon(104)
    paste_icon(img, icon, (28, 88))
    d.text((152, 96), TITLE, font=ImageFont.truetype(ARIAL_BOLD, 44), fill=(255, 255, 255))
    d.text((154, 152), TAGLINE, font=ImageFont.truetype(ARIAL, 17), fill=(203, 213, 225))
    d.text((154, 178), PROVIDERS, font=ImageFont.truetype(ARIAL, 12), fill=(148, 163, 184))
    return img


def make_marquee():
    w, h = 1400, 560
    img = gradient((w, h), (248, 250, 252), (224, 231, 255))
    d = ImageDraw.Draw(img)
    icon = load_icon(220)
    paste_icon(img, icon, (120, 170), icon_bg=(255, 255, 255, 235))
    d.text((400, 200), TITLE, font=ImageFont.truetype(ARIAL_BOLD, 110), fill=(15, 23, 42))
    d.text((404, 330), TAGLINE, font=ImageFont.truetype(ARIAL, 42), fill=(51, 65, 85))
    d.text((404, 396), PROVIDERS, font=ImageFont.truetype(ARIAL, 28), fill=(100, 116, 139))
    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    small = make_small()
    marquee = make_marquee()
    p1 = os.path.join(OUT_DIR, 'heraai-promo-small-440x280.png')
    p2 = os.path.join(OUT_DIR, 'heraai-promo-marquee-1400x560.png')
    small.save(p1)
    marquee.save(p2)
    for p, im in ((p1, small), (p2, marquee)):
        print(p, im.size, im.mode, os.path.getsize(p), 'bytes')


if __name__ == '__main__':
    main()
