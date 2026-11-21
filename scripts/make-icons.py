"""Generate the Sylk icon set from a single vector-ish drawing.

Run:  python scripts/make-icons.py
Requires: Pillow

The mark is deliberately plain: five rounded bars (a voiceprint) standing on a
thin baseline inside a squircle. It stays legible down to 16 px.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 1024
BG = (14, 19, 33, 255)
BAR = (255, 255, 255, 255)
BAR_ACCENT = (91, 121, 240, 255)
BASE = (255, 255, 255, 46)


def squircle(size: int, radius_ratio: float = 0.225) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=BG)
    return img


def draw_mark(size: int) -> Image.Image:
    img = squircle(size)
    d = ImageDraw.Draw(img)
    k = size / S

    heights = [214, 372, 512, 372, 214]
    bar_w = 74
    gap = 46
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    x = (S - total) / 2
    cy = 486

    for i, h in enumerate(heights):
        top = cy - h / 2
        box = (x, top, x + bar_w, top + h)
        d.rounded_rectangle(
            tuple(int(v * k) for v in (box[0], box[1], box[2], box[3])),
            radius=int(bar_w * 0.46 * k),
            fill=BAR_ACCENT if i == 2 else BAR,
        )
        x += bar_w + gap

    d.rounded_rectangle(
        (int(202 * k), int(792 * k), int(822 * k), int(800 * k)),
        radius=int(4 * k),
        fill=BASE,
    )
    return img


def main() -> None:
    master = draw_mark(S)
    master.save(OUT / "icon.png")

    for name, px in {
        "32x32.png": 32,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "icon-512.png": 512,
    }.items():
        draw_mark(px).save(OUT / name)

    # Windows .ico needs a multi-resolution container.
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw_mark(n) for n in ico_sizes]
    frames[-1].save(OUT / "icon.ico", format="ICO", sizes=[(n, n) for n in ico_sizes])

    # macOS icon (Tauri only consumes it when bundling on macOS).
    draw_mark(1024).save(OUT / "icon.icns")

    # Tauri's Windows Store assets are optional but harmless to include.
    for name, w, h in [
        ("Square30x30Logo.png", 30, 30),
        ("Square44x44Logo.png", 44, 44),
        ("Square71x71Logo.png", 71, 71),
        ("Square89x89Logo.png", 89, 89),
        ("Square107x107Logo.png", 107, 107),
        ("Square142x142Logo.png", 142, 142),
        ("Square150x150Logo.png", 150, 150),
        ("Square284x284Logo.png", 284, 284),
        ("Square310x310Logo.png", 310, 310),
        ("StoreLogo.png", 50, 50),
    ]:
        draw_mark(max(w, h)).resize((w, h), Image.LANCZOS).save(OUT / name)

    print(f"icons written to {OUT}")


if __name__ == "__main__":
    main()
