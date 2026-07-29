"""Generate the Credit Card Benefit Tracker app icon.

Design: a stylized credit card in the app's teal-primary palette with a bold
gold checkmark badge in the lower-right corner (signifying "benefit used /
tracked"). Rendered at 4x supersample then downsampled for anti-aliasing.
Outputs PNG (512x512) and ICO (multi-size).
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# Palette (app teal + gold; matches header primary-600).
BG_TOP = (7, 89, 96, 255)        # deep teal
BG_BOTTOM = (13, 148, 136, 255)  # brighter teal (primary-600-ish)
CARD_TOP = (245, 245, 240, 255)  # warm off-white
CARD_BOTTOM = (220, 220, 210, 255)
CARD_STRIPE = (30, 40, 45, 255)
CHIP_TOP = (218, 165, 32, 255)   # gold chip
CHIP_BOTTOM = (154, 111, 18, 255)
NUM_LINE = (105, 115, 125, 255)
BADGE_BG = (218, 165, 32, 255)   # gold
BADGE_RING = (255, 255, 255, 255)
BADGE_CHECK = (10, 45, 55, 255)  # dark teal check

SCALE = 4
SIZE = 512
S = SIZE * SCALE


def vertical_gradient(w: int, h: int, top, bottom) -> Image.Image:
    grad = Image.new('RGBA', (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px[0, y] = tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(4))
    return grad.resize((w, h))


def rounded_rect_mask(w: int, h: int, r: int) -> Image.Image:
    mask = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
    return mask


def make_icon() -> Image.Image:
    # Background: rounded-square teal gradient.
    bg = vertical_gradient(S, S, BG_TOP, BG_BOTTOM)
    bg_mask = rounded_rect_mask(S, S, r=int(0.20 * S))
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), bg_mask)

    # Card: rounded rectangle with subtle drop-shadow.
    card_w = int(S * 0.72)
    card_h = int(card_w * 0.62)
    card_x = (S - card_w) // 2
    card_y = int(S * 0.22)

    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        [card_x + 8 * SCALE, card_y + 12 * SCALE,
         card_x + card_w + 8 * SCALE, card_y + card_h + 12 * SCALE],
        radius=int(0.10 * card_w), fill=(0, 0, 0, 110),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=10 * SCALE))
    canvas = Image.alpha_composite(canvas, shadow)

    # Card body (gradient).
    card_grad = vertical_gradient(card_w, card_h, CARD_TOP, CARD_BOTTOM)
    card_mask = rounded_rect_mask(card_w, card_h, r=int(0.10 * card_w))
    canvas.paste(card_grad, (card_x, card_y), card_mask)

    # Magnetic stripe (thin dark bar near top).
    stripe_h = int(card_h * 0.12)
    stripe_y = card_y + int(card_h * 0.14)
    stripe = Image.new('RGBA', (card_w, stripe_h), CARD_STRIPE)
    canvas.paste(stripe, (card_x, stripe_y), stripe)

    d = ImageDraw.Draw(canvas)

    # Chip (gold rounded rect on lower-left of card).
    chip_w = int(card_w * 0.18)
    chip_h = int(chip_w * 0.72)
    chip_x = card_x + int(card_w * 0.09)
    chip_y = card_y + int(card_h * 0.42)
    chip_grad = vertical_gradient(chip_w, chip_h, CHIP_TOP, CHIP_BOTTOM)
    chip_mask = rounded_rect_mask(chip_w, chip_h, r=int(0.20 * chip_h))
    canvas.paste(chip_grad, (chip_x, chip_y), chip_mask)
    # Chip contact lines.
    for i in range(1, 3):
        y = chip_y + int(chip_h * i / 3)
        d.line([(chip_x + 4 * SCALE, y), (chip_x + chip_w - 4 * SCALE, y)],
               fill=(120, 80, 10, 200), width=2 * SCALE)
    for i in range(1, 2):
        x = chip_x + int(chip_w * i / 2)
        d.line([(x, chip_y + 4 * SCALE), (x, chip_y + chip_h - 4 * SCALE)],
               fill=(120, 80, 10, 200), width=2 * SCALE)

    # Card number lines (three short bars).
    num_y = card_y + int(card_h * 0.72)
    line_h = int(card_h * 0.05)
    gap = int(card_w * 0.04)
    seg_w = int((card_w * 0.62 - 3 * gap) / 4)
    x0 = card_x + int(card_w * 0.09)
    for i in range(4):
        x = x0 + i * (seg_w + gap)
        d.rounded_rectangle(
            [x, num_y, x + seg_w, num_y + line_h],
            radius=int(line_h / 2), fill=NUM_LINE,
        )

    # Checkmark badge (gold circle with white ring + teal check) in lower-right.
    badge_r = int(S * 0.18)
    badge_cx = card_x + card_w - int(badge_r * 0.35)
    badge_cy = card_y + card_h - int(badge_r * 0.35)
    # Outer white ring.
    d.ellipse(
        [badge_cx - badge_r - 6 * SCALE, badge_cy - badge_r - 6 * SCALE,
         badge_cx + badge_r + 6 * SCALE, badge_cy + badge_r + 6 * SCALE],
        fill=BADGE_RING,
    )
    # Gold fill.
    d.ellipse(
        [badge_cx - badge_r, badge_cy - badge_r,
         badge_cx + badge_r, badge_cy + badge_r],
        fill=BADGE_BG,
    )
    # Checkmark polyline (two segments).
    check_w = int(SCALE * 14)
    ax = badge_cx - int(badge_r * 0.45)
    ay = badge_cy + int(badge_r * 0.05)
    bx = badge_cx - int(badge_r * 0.10)
    by = badge_cy + int(badge_r * 0.40)
    cx = badge_cx + int(badge_r * 0.50)
    cy = badge_cy - int(badge_r * 0.35)
    d.line([(ax, ay), (bx, by)], fill=BADGE_CHECK, width=check_w)
    d.line([(bx, by), (cx, cy)], fill=BADGE_CHECK, width=check_w)
    # Rounded caps for a cleaner look.
    for (px, py) in [(ax, ay), (bx, by), (cx, cy)]:
        r = check_w // 2
        d.ellipse([px - r, py - r, px + r, py + r], fill=BADGE_CHECK)

    # Downsample.
    icon = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    return icon


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent / 'assets'
    out_dir.mkdir(exist_ok=True)
    icon = make_icon()
    icon.save(out_dir / 'icon.png', 'PNG', optimize=True)
    # ICO with a standard set of sizes.
    icon.save(
        out_dir / 'icon.ico',
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"Wrote {out_dir/'icon.png'} and {out_dir/'icon.ico'}")


if __name__ == '__main__':
    main()
