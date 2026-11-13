#!/usr/bin/env python3
"""按相册页面尺寸，给一次旅行出三种跨页摆法的示意图。只是参考，不用照着贴。

    python layout_sketch.py 旅行文件夹 输出文件夹 --page 10.6x11 [--tickets 3]

--page 是单页的 宽x高（英寸），量一下相册内页可贴的区域再填。
--tickets 可以是数字（画占位框），也可以是票据扫描图的文件夹（按 --ticket-long 的长边画出来）。

三种摆法：
    A 整齐     按行排开，不重叠
    B 主图     每页一张大的，其余缩小围在旁边
    C 散拼     尺寸大一号，带角度、互相压一点

照片印多大由脚本从大到小试（4x6、3.5x5、3x4、2x3），放得下为止；
图上和 layout.md 里会写明每种摆法需要印的尺寸。
"""
from __future__ import annotations

import argparse
import random
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from common import enable_heic, list_images, load_font

PPI = 80  # 示意图的分辨率，不是打印用
SIZES = [(4, 6), (3.5, 5), (3, 4), (2, 3)]  # 短边 x 长边
PAPER = (244, 238, 226)
TAPE = [(214, 190, 150), (170, 190, 175), (205, 165, 160), (160, 175, 200)]


@dataclass
class Item:
    img: Image.Image | None  # None 画占位框
    landscape: bool
    kind: str  # photo / ticket
    w: float = 0  # 英寸
    h: float = 0
    x: float = 0  # 在跨页上的位置，英寸
    y: float = 0
    angle: float = 0


def set_size(it: Item, short: float, long: float) -> None:
    it.w, it.h = (long, short) if it.landscape else (short, long)


def pack(items: list[Item], page_w: float, page_h: float, margin: float, gap: float) -> bool:
    """按面积把东西对半分到左右两页，每页一行一行往下排。放不下返回 False。"""
    total = sum(i.w * i.h for i in items)
    acc, split = 0.0, len(items)
    for n, it in enumerate(items):
        acc += it.w * it.h
        if acc >= total / 2:
            split = n + 1
            break
    if len(items) > 1:
        split = min(split, len(items) - 1)
    return all(
        _pack_page(part, pi * page_w, page_w, page_h, margin, gap)
        for pi, part in enumerate((items[:split], items[split:]))
    )


def _pack_page(items, x0, page_w, page_h, margin, gap) -> bool:
    inner_w, inner_h = page_w - 2 * margin, page_h - 2 * margin
    rows: list[list[Item]] = []
    row_w = 0.0
    for it in items:
        if it.w > inner_w:
            return False
        if rows and row_w + gap + it.w <= inner_w:
            rows[-1].append(it)
            row_w += gap + it.w
        else:
            rows.append([it])
            row_w = it.w
    heights = [max(i.h for i in r) for r in rows]
    total_h = sum(heights) + gap * (len(rows) - 1)
    if total_h > inner_h:
        return False
    # 每行水平居中，整页垂直居中
    y = margin + (inner_h - total_h) / 2
    for r, rh in zip(rows, heights):
        rw = sum(i.w for i in r) + gap * (len(r) - 1)
        x = x0 + margin + (inner_w - rw) / 2
        for i in r:
            i.x, i.y = x, y + (rh - i.h) / 2
            x += i.w + gap
        y += rh + gap
    return True


def balance(items: list[Item]) -> list[Item]:
    """照片和票据交错开，避免票据全堆在最后。"""
    photos = [i for i in items if i.kind == "photo"]
    tickets = [i for i in items if i.kind == "ticket"]
    if not tickets:
        return photos
    out, step = [], max(1, len(photos) // len(tickets))
    for n, p in enumerate(photos, 1):
        out.append(p)
        if n % step == 0 and tickets:
            out.append(tickets.pop(0))
    return out + tickets


def layout_tidy(items, pw, ph, margin):
    for s in SIZES:
        for it in items:
            if it.kind == "photo":
                set_size(it, *s)
        if pack(balance(items), pw, ph, margin, 0.3):
            return f"照片印 {s[0]:g}x{s[1]:g} 寸"
    return None


def layout_hero(items, pw, ph, margin):
    photos = [i for i in items if i.kind == "photo"]
    if len(photos) < 4:
        return None
    half = (len(photos) + 1) // 2
    heroes = {id(photos[0]), id(photos[half])}  # 左右页各一张主图
    for hi, hero in enumerate(SIZES[:-1]):
        for small in SIZES[hi + 1:]:
            for it in photos:
                set_size(it, *(hero if id(it) in heroes else small))
            if pack(balance(items), pw, ph, margin, 0.3):
                return (
                    f"主图 2 张印 {hero[0]:g}x{hero[1]:g} 寸，"
                    f"其余 {len(photos) - 2} 张印 {small[0]:g}x{small[1]:g} 寸"
                )
    return None


def layout_scatter(items, pw, ph, margin, rng):
    """用负间距排，让相邻的互相压住一点，再加随机角度和偏移。"""
    for s in SIZES:
        for it in items:
            if it.kind == "photo":
                set_size(it, *s)
        order = balance(items)
        if pack(order, pw, ph, margin * 0.6, -0.45):
            for it in order:
                it.angle = rng.uniform(-7, 7)
                it.x += rng.uniform(-0.15, 0.15)
                it.y += rng.uniform(-0.15, 0.15)
            rng.shuffle(order)  # 打乱叠放顺序
            items[:] = order
            return f"照片印 {s[0]:g}x{s[1]:g} 寸，互相压住约半寸"
    return None


def render(items, pw, ph, title, subtitle, font_path) -> Image.Image:
    head = 60
    W, H = round(2 * pw * PPI), round(ph * PPI)
    canvas = Image.new("RGB", (W + 40, H + head + 20), (225, 225, 225))
    spread = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(spread)
    d.line([(W // 2, 0), (W // 2, H)], fill=(200, 192, 176), width=3)  # 装订线
    rng = random.Random(len(items))
    for it in items:
        w, h = round(it.w * PPI), round(it.h * PPI)
        if it.img is not None:
            pic = ImageOps.fit(it.img, (w, h), Image.LANCZOS)
        else:
            pic = Image.new("RGB", (w, h), (236, 222, 190))
            pd = ImageDraw.Draw(pic)
            pd.rectangle([0, 0, w - 1, h - 1], outline=(150, 130, 95), width=2)
            f = load_font(18, font_path)
            pd.text((w / 2, h / 2), "票据", fill=(120, 100, 70), font=f, anchor="mm")
        if it.kind == "photo":
            pic = ImageOps.expand(pic, border=5, fill="white")
        card = Image.new("RGBA", pic.size, (0, 0, 0, 0))
        card.paste(pic, (0, 0))
        cd = ImageDraw.Draw(card)
        cd.rectangle([0, 0, card.width - 1, card.height - 1], outline=(170, 170, 170, 255))
        if it.kind == "photo":  # 顶上一小段胶带
            tw, th = 70, 18
            cd.rectangle(
                [card.width // 2 - tw // 2, 0, card.width // 2 + tw // 2, th],
                fill=(*rng.choice(TAPE), 215),
            )
        card = card.rotate(it.angle, expand=True, resample=Image.BICUBIC)
        cx, cy = (it.x + it.w / 2) * PPI, (it.y + it.h / 2) * PPI
        spread.paste(card, (round(cx - card.width / 2), round(cy - card.height / 2)), card)
    canvas.paste(spread, (20, head))
    cd = ImageDraw.Draw(canvas)
    cd.text((20, 8), title, fill=(40, 40, 40), font=load_font(24, font_path))
    cd.text((20, 36), subtitle, fill=(90, 90, 90), font=load_font(16, font_path))
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("trip", type=Path, help="挑好照片的旅行文件夹")
    ap.add_argument("out", type=Path)
    ap.add_argument("--page", required=True, help="单页可贴区域 宽x高，英寸，例如 10.6x11")
    ap.add_argument("--tickets", default="0", help="票据数量，或票据扫描图的文件夹")
    ap.add_argument("--ticket-long", type=float, default=3.4, help="票据长边，英寸（默认 3.4，火车票大小）")
    ap.add_argument("--margin", type=float, default=0.5, help="页边留白，英寸")
    ap.add_argument("--seed", type=int, default=1, help="散拼的随机种子，换个数字换一种摆法")
    ap.add_argument("--font", help="字体文件路径")
    args = ap.parse_args()

    try:
        pw, ph = (float(v) for v in args.page.lower().split("x"))
    except ValueError:
        print("--page 要写成 宽x高，例如 10.6x11", file=sys.stderr)
        return 1
    enable_heic()
    files = list_images(args.trip) if args.trip.is_dir() else []
    if not files:
        print(f"{args.trip} 里没有照片。", file=sys.stderr)
        return 1

    items: list[Item] = []
    for f in files:
        img = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        img.thumbnail((900, 900))
        items.append(Item(img, img.width >= img.height, "photo"))
    ticket_imgs: list[Image.Image | None]
    if args.tickets.isdigit():
        ticket_imgs = [None] * int(args.tickets)
    else:
        ticket_imgs = []
        for f in list_images(Path(args.tickets)):
            t = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
            t.thumbnail((900, 900))
            ticket_imgs.append(t)
    for t in ticket_imgs:
        land = True if t is None else t.width >= t.height
        ratio = 0.62 if t is None else min(t.size) / max(t.size)
        it = Item(t, land, "ticket")
        set_size(it, args.ticket_long * ratio, args.ticket_long)
        items.append(it)

    args.out.mkdir(parents=True, exist_ok=True)
    n_photo = len(files)
    notes = [f"# {args.trip.name} 排版示意", "", f"单页 {pw:g}x{ph:g} 寸，照片 {n_photo} 张，票据 {len(ticket_imgs)} 张。", ""]
    rng = random.Random(args.seed)
    layouts = [
        ("A_整齐", lambda its: layout_tidy(its, pw, ph, args.margin)),
        ("B_主图", lambda its: layout_hero(its, pw, ph, args.margin)),
        ("C_散拼", lambda its: layout_scatter(its, pw, ph, args.margin, rng)),
    ]
    made = 0
    for name, fn in layouts:
        its = [Item(i.img, i.landscape, i.kind, i.w, i.h) for i in items]
        desc = fn(its)
        if desc is None:
            notes.append(f"- {name}：放不下（照片太多或太少），跳过。")
            continue
        render(its, pw, ph, f"{args.trip.name}  {name}", desc, args.font).save(args.out / f"{name}.png")
        notes.append(f"- {name}：{desc}。见 `{name}.png`")
        made += 1
    if made == 0:
        notes.append("")
        notes.append("三种都放不下：减少照片，或者这次旅行做两个跨页。")
    (args.out / "layout.md").write_text("\n".join(notes) + "\n", encoding="utf-8")
    print("\n".join(notes))
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
