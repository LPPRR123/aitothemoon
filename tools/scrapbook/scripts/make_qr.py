#!/usr/bin/env python3
"""批量生成二维码，尺寸按打印来算，可以跟照片一起冲印。

    python make_qr.py links.csv 输出文件夹 [--inches 1.5]

links.csv 三列（第一行是表头）：
    旅行,标题,链接
    2024-05 成都,火锅店的视频,https://example.com/abc

输出：
    输出文件夹/单张/<旅行>_<标题>.png    每个二维码一张，下面带标题
    输出文件夹/拼版_01.png ...           拼在 4x6 寸相纸上，冲印后剪开

链接要用长期有效的（网盘分享设成永久、或自己的相册链接），不然几年后扫不出来。
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw

from common import load_font

DPI = 300


def safe_name(s: str) -> str:
    return "".join("_" if c in '\\/:*?"<>| ' else c for c in s).strip("_") or "qr"


def fit_text(draw, text, font_size, max_w, font_path):
    """标题太长就缩小字号，最小缩到一半，再长就截断。"""
    size = font_size
    while size > font_size // 2:
        font = load_font(size, font_path)
        if draw.textlength(text, font=font) <= max_w:
            return text, font
        size -= 2
    font = load_font(size, font_path)
    while len(text) > 1 and draw.textlength(text + "…", font=font) > max_w:
        text = text[:-1]
    return text + "…", font


def make_tile(url: str, title: str, inches: float, font_path: str | None) -> Image.Image:
    side = round(inches * DPI)
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=2)
    qr.add_data(url)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    # 最近邻放大，保持方块边缘锐利
    img = img.resize((side, side), Image.NEAREST)
    cap_h = round(0.25 * DPI) if title else 0
    tile = Image.new("RGB", (side, side + cap_h), "white")
    tile.paste(img, (0, 0))
    if title:
        d = ImageDraw.Draw(tile)
        text, font = fit_text(d, title, round(0.14 * DPI), side - 20, font_path)
        w = d.textlength(text, font=font)
        d.text(((side - w) / 2, side + cap_h * 0.12), text, fill=(60, 60, 60), font=font)
    return tile


def make_sheets(tiles: list[Image.Image], sheet_in=(6.0, 4.0)) -> list[Image.Image]:
    sw, sh = round(sheet_in[0] * DPI), round(sheet_in[1] * DPI)
    margin, gap = round(0.15 * DPI), round(0.1 * DPI)
    sheets, x, y, row_h = [], margin, margin, 0
    sheet = None
    for t in tiles:
        if sheet is None:
            sheet = Image.new("RGB", (sw, sh), "white")
        if x + t.width > sw - margin:
            x, y, row_h = margin, y + row_h + gap, 0
        if y + t.height > sh - margin:
            sheets.append(sheet)
            sheet = Image.new("RGB", (sw, sh), "white")
            x, y, row_h = margin, margin, 0
        sheet.paste(t, (x, y))
        x += t.width + gap
        row_h = max(row_h, t.height)
    if sheet is not None:
        sheets.append(sheet)
    return sheets


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--inches", type=float, default=1.5, help="二维码边长，英寸（默认 1.5，不建议小于 1）")
    ap.add_argument("--font", help="字体文件路径，默认自动找系统里的中文字体")
    args = ap.parse_args()

    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("链接") or "").strip()]
    if not rows:
        print("CSV 里没有带链接的行。表头要是：旅行,标题,链接", file=sys.stderr)
        return 1

    single = args.out / "单张"
    single.mkdir(parents=True, exist_ok=True)
    tiles = []
    for i, r in enumerate(rows, 1):
        title = (r.get("标题") or "").strip()
        tile = make_tile(r["链接"].strip(), title, args.inches, args.font)
        name = safe_name(f"{(r.get('旅行') or '').strip()}_{title or i}")
        tile.save(single / f"{i:02d}_{name}.png", dpi=(DPI, DPI))
        tiles.append(tile)
    sheets = make_sheets(tiles)
    for i, s in enumerate(sheets, 1):
        s.save(args.out / f"拼版_{i:02d}.png", dpi=(DPI, DPI))
    print(f"{len(tiles)} 个二维码，{len(sheets)} 张 4x6 拼版，在 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
