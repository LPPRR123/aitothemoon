#!/usr/bin/env python3
"""把手机导出的照片按旅行分组，并挑出重复和模糊的照片。

原始文件夹只读不改：所有结果都是复制到输出文件夹里的副本。

    python group_photos.py 照片文件夹 输出文件夹 [--tickets tickets.csv]

输出：
    输出文件夹/
        2024-05-01_05-04_成都/      每次旅行一个文件夹
        _待删/重复/<旅行>/          连拍里多余的几张（每组留最清晰的一张在旅行文件夹）
        _待删/模糊/<旅行>/          清晰度低于阈值的
        _未分组/                    没有拍摄时间的（截图、微信保存的图等）
        report.md                   每次旅行的日期、张数、对上的票据
        photos.csv                  每张照片的时间、GPS、清晰度、去向

怎么判断"旅行"：
    有 GPS 时，先找出"家"（出现天数最多的位置，也可用 --home 指定），
    离家超过 --away-km 的连续照片算一次旅行，中间隔了超过 --gap-days 天就拆成两次。
    几乎没有 GPS 时，只能按时间间隔切段，结果里会混进日常照片，需要人工看一遍。
"""
from __future__ import annotations

import argparse
import csv
import math
import shutil
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
from PIL import Image

from common import enable_heic, list_images

EXIF_IFD, GPS_IFD = 0x8769, 0x8825
TAG_DATETIME_ORIGINAL, TAG_DATETIME = 0x9003, 0x0132


@dataclass
class Photo:
    path: Path
    time: datetime | None = None
    lat: float | None = None
    lon: float | None = None
    pixels: int = 0
    sharpness: float = 0.0
    dhash: int = 0
    trip: int | None = None
    dest: str = ""  # 最终去向（相对输出文件夹）
    note: str = ""
    error: str = ""


@dataclass
class Trip:
    photos: list[Photo] = field(default_factory=list)
    name: str = ""
    tickets: list[dict] = field(default_factory=list)

    @property
    def start(self) -> datetime:
        return self.photos[0].time

    @property
    def end(self) -> datetime:
        return self.photos[-1].time


# ---------- 读取单张照片 ----------

def _parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip()[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def _dms_to_deg(dms, ref) -> float | None:
    try:
        d, m, s = (float(x) for x in dms)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    deg = d + m / 60 + s / 3600
    if str(ref).upper() in ("S", "W"):
        deg = -deg
    return deg


def read_photo(path: Path) -> Photo:
    p = Photo(path)
    try:
        with Image.open(path) as img:
            p.pixels = img.width * img.height
            exif = img.getexif()
            sub = exif.get_ifd(EXIF_IFD)
            p.time = _parse_time(sub.get(TAG_DATETIME_ORIGINAL)) or _parse_time(
                exif.get(TAG_DATETIME)
            )
            gps = exif.get_ifd(GPS_IFD)
            if gps.get(2) and gps.get(4):
                lat = _dms_to_deg(gps[2], gps.get(1, "N"))
                lon = _dms_to_deg(gps[4], gps.get(3, "E"))
                # (0, 0) 是相机没定到位时写的占位值
                if lat is not None and lon is not None and (abs(lat) > 1e-6 or abs(lon) > 1e-6):
                    p.lat, p.lon = lat, lon
            img.draft("L", (640, 640))  # JPEG 解码时直接缩小，快很多
            gray = img.convert("L")
            p.dhash = _dhash(gray)
            p.sharpness = _sharpness(gray)
    except Exception as e:  # 坏文件不该让整批停下
        p.error = f"{type(e).__name__}: {e}"
    return p


def _dhash(gray: Image.Image) -> int:
    """64 位差值哈希：内容接近的照片，哈希只差几位。"""
    a = np.asarray(gray.resize((9, 8), Image.LANCZOS), dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    return int("".join("1" if b else "0" for b in bits), 2)


def _sharpness(gray: Image.Image) -> float:
    """拉普拉斯方差，越小越糊。统一缩到长边 512 再算，不同分辨率才可比。"""
    g = gray.copy()
    g.thumbnail((512, 512), Image.LANCZOS)
    a = np.asarray(g, dtype=np.float32)
    if a.shape[0] < 3 or a.shape[1] < 3:
        return 0.0
    lap = a[1:-1, :-2] + a[1:-1, 2:] + a[:-2, 1:-1] + a[2:, 1:-1] - 4 * a[1:-1, 1:-1]
    return float(lap.var())


# ---------- 分组 ----------

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def guess_home(photos: list[Photo]) -> tuple[float, float] | None:
    """出现天数最多的 0.1 度格子（约 10 公里）当作家。"""
    days = defaultdict(set)
    coords = defaultdict(list)
    for p in photos:
        if p.lat is None or p.time is None:
            continue
        cell = (round(p.lat, 1), round(p.lon, 1))
        days[cell].add(p.time.date())
        coords[cell].append((p.lat, p.lon))
    if not days:
        return None
    cell = max(days, key=lambda c: len(days[c]))
    pts = coords[cell]
    return (sum(x for x, _ in pts) / len(pts), sum(y for _, y in pts) / len(pts))


def split_trips_by_gps(photos, home, away_km, gap) -> list[Trip]:
    """先按天判断在不在外地，连续的外地日子连成一次旅行。

    按天而不是按张判断，是因为旅行途中偶尔会混进一张定位在家的图
    （别人发来的、定位漂移的），不该把一次旅行切成两半。
    一次旅行取第一张到最后一张外地照片之间的全部照片，没有 GPS 的也算进去。
    """
    away_n, home_n = Counter(), Counter()
    is_away = {}
    for p in photos:
        if p.lat is None:
            continue
        away = haversine_km(p.lat, p.lon, *home) > away_km
        is_away[id(p)] = away
        (away_n if away else home_n)[p.time.date()] += 1
    away_days = {d for d, n in away_n.items() if n >= 2 or n >= home_n[d]}
    home_days = set(home_n) - away_days

    spans: list[list[datetime]] = []  # 每次旅行的 [第一张外地照片时间, 最后一张]
    for p in photos:
        if not is_away.get(id(p)) or p.time.date() not in away_days:
            continue
        if spans:
            last = spans[-1][1]
            came_home = any(last.date() < d < p.time.date() for d in home_days)
            if p.time - last <= gap and not came_home:
                spans[-1][1] = p.time
                continue
        spans.append([p.time, p.time])
    return [Trip([p for p in photos if s <= p.time <= e]) for s, e in spans]


def split_trips_by_time(photos, gap) -> list[Trip]:
    trips: list[Trip] = []
    for p in photos:
        if trips and p.time - trips[-1].end <= gap:
            trips[-1].photos.append(p)
        else:
            trips.append(Trip([p]))
    return trips


# ---------- 重复和模糊 ----------

def mark_duplicates(trip: Trip, window_s: int, max_bits: int) -> None:
    """拍摄时间接近、画面又几乎一样的算一组，每组只留最好的一张。"""
    ps = trip.photos
    parent = list(range(len(ps)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(ps)):
        for j in range(i + 1, len(ps)):
            if (ps[j].time - ps[i].time).total_seconds() > window_s:
                break
            if bin(ps[i].dhash ^ ps[j].dhash).count("1") <= max_bits:
                parent[find(j)] = find(i)
    groups = defaultdict(list)
    for i, p in enumerate(ps):
        groups[find(i)].append(p)
    for g in groups.values():
        if len(g) < 2:
            continue
        best = max(g, key=lambda p: (p.sharpness, p.pixels))
        for p in g:
            if p is not best:
                p.note = f"重复，保留的是 {best.path.name}"


# ---------- 票据对照 ----------

def load_tickets(path: Path) -> list[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                row["_date"] = datetime.strptime(row.get("日期", "").strip(), "%Y-%m-%d").date()
            except ValueError:
                row["_date"] = None
            rows.append(row)
    return rows


def attach_tickets(trips: list[Trip], tickets: list[dict]) -> list[dict]:
    """票据日期落在旅行前后一天内就算这次旅行的。返回没对上的票据。"""
    unmatched = []
    for t in tickets:
        d = t["_date"]
        hit = None
        if d is not None:
            for trip in trips:
                if trip.start.date() - timedelta(days=1) <= d <= trip.end.date() + timedelta(days=1):
                    hit = trip
                    break
        (hit.tickets if hit else unmatched).append(t)
    return unmatched


def name_trip(trip: Trip) -> str:
    s, e = trip.start, trip.end
    name = s.strftime("%Y-%m-%d") if s.date() == e.date() else f"{s:%Y-%m-%d}_{e:%m-%d}"
    places = Counter(
        (t.get("旅行") or t.get("目的地") or "").strip() for t in trip.tickets
    )
    places.pop("", None)
    if places:
        place = places.most_common(1)[0][0]
        name += "_" + "".join(c for c in place if c not in '\\/:*?"<>|')
    return name


# ---------- 输出 ----------

def copy_unique(src: Path, dst_dir: Path) -> Path:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    n = 1
    while dst.exists():
        dst = dst_dir / f"{src.stem}_{n}{src.suffix}"
        n += 1
    shutil.copy2(src, dst)
    return dst


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="手机导出的照片文件夹")
    ap.add_argument("out", type=Path, help="输出文件夹（会新建）")
    ap.add_argument("--tickets", type=Path, help="票据时间线 CSV，用来给旅行命名和对照")
    ap.add_argument("--home", help="家的位置 '纬度,经度'，不填则自动猜")
    ap.add_argument("--away-km", type=float, default=80, help="离家多远算出门旅行（默认 80）")
    ap.add_argument("--gap-days", type=float, default=2, help="隔多少天没照片就算两次旅行（默认 2）")
    ap.add_argument("--min-photos", type=int, default=5, help="少于这么多张不算旅行（默认 5）")
    ap.add_argument("--blur", type=float, default=40, help="清晰度低于此值算模糊（默认 40，看 photos.csv 调）")
    ap.add_argument("--dup-seconds", type=int, default=120, help="多少秒内拍的才比较是否重复（默认 120）")
    ap.add_argument("--dup-bits", type=int, default=6, help="哈希相差几位以内算重复（默认 6，越小越严）")
    ap.add_argument("--dry-run", action="store_true", help="只出报告，不复制照片")
    args = ap.parse_args()

    if not args.src.is_dir():
        print(f"找不到文件夹：{args.src}", file=sys.stderr)
        return 1
    if args.out.resolve() == args.src.resolve() or args.src.resolve() in args.out.resolve().parents:
        print("输出文件夹不能放在照片文件夹里面。", file=sys.stderr)
        return 1
    if args.out.exists() and any(args.out.iterdir()):
        print(f"输出文件夹已有内容：{args.out}。换个新文件夹，免得和上次结果混在一起。", file=sys.stderr)
        return 1

    heic = enable_heic()
    files = list_images(args.src)
    skipped_heic = [f for f in files if f.suffix.lower() in (".heic", ".heif")] if not heic else []
    if skipped_heic:
        files = [f for f in files if f.suffix.lower() not in (".heic", ".heif")]
        print(f"有 {len(skipped_heic)} 张 HEIC 读不了，先运行 pip install pillow-heif。", file=sys.stderr)
    if not files:
        print("文件夹里没有图片。", file=sys.stderr)
        return 1

    photos = []
    for i, f in enumerate(files, 1):
        photos.append(read_photo(f))
        if i % 200 == 0 or i == len(files):
            print(f"\r读取 {i}/{len(files)}", end="", file=sys.stderr)
    print(file=sys.stderr)

    timed = sorted((p for p in photos if p.time and not p.error), key=lambda p: p.time)
    with_gps = [p for p in timed if p.lat is not None]
    gap = timedelta(days=args.gap_days)
    mode_note = ""
    home = None
    if args.home:
        home = tuple(float(x) for x in args.home.split(","))
    elif len(with_gps) >= max(10, len(timed) * 0.2):
        home = guess_home(with_gps)
    if home:
        trips = split_trips_by_gps(timed, home, args.away_km, gap)
        mode_note = f"按 GPS 分组，家的位置取 {home[0]:.3f}, {home[1]:.3f}，离家 {args.away_km:g} 公里以上算旅行。"
    else:
        trips = split_trips_by_time(timed, gap)
        mode_note = (
            f"带 GPS 的照片太少（{len(with_gps)}/{len(timed)}），只按时间间隔分段。"
            "日常照片也会被分成段，需要人工挑出哪些是旅行。"
        )
    trips = [t for t in trips if len(t.photos) >= args.min_photos]

    tickets = load_tickets(args.tickets) if args.tickets else []
    unmatched = attach_tickets(trips, tickets)
    used = Counter()
    for i, trip in enumerate(trips):
        trip.name = name_trip(trip)
        used[trip.name] += 1
        if used[trip.name] > 1:
            trip.name += f"_{used[trip.name]}"
        for p in trip.photos:
            p.trip = i
        mark_duplicates(trip, args.dup_seconds, args.dup_bits)
        for p in trip.photos:
            if not p.note and p.sharpness < args.blur:
                p.note = "模糊"

    for p in photos:
        if p.error:
            p.dest, p.note = "", "读取失败"
        elif p.trip is not None:
            name = trips[p.trip].name
            if p.note.startswith("重复"):
                p.dest = f"_待删/重复/{name}"
            elif p.note == "模糊":
                p.dest = f"_待删/模糊/{name}"
            else:
                p.dest = name
        elif p.time is None:
            p.dest, p.note = "_未分组", "没有拍摄时间"
        else:
            p.dest = ""  # 不属于任何旅行的日常照片，不复制

    if not args.dry_run:
        for p in photos:
            if p.dest:
                p.dest = str(copy_unique(p.path, args.out / p.dest).relative_to(args.out))
    args.out.mkdir(parents=True, exist_ok=True)

    with open(args.out / "photos.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["原文件", "拍摄时间", "纬度", "经度", "清晰度", "去向", "备注"])
        for p in sorted(photos, key=lambda p: (p.time or datetime.max, str(p.path))):
            w.writerow([
                p.path.relative_to(args.src),
                p.time.strftime("%Y-%m-%d %H:%M:%S") if p.time else "",
                f"{p.lat:.5f}" if p.lat is not None else "",
                f"{p.lon:.5f}" if p.lon is not None else "",
                f"{p.sharpness:.1f}",
                p.dest,
                p.error or p.note,
            ])

    lines = ["# 照片分组报告", "", mode_note, ""]
    n_trip = sum(len(t.photos) for t in trips)
    lines += [
        f"- 图片总数：{len(photos)}",
        f"- 分进旅行：{n_trip} 张，共 {len(trips)} 次旅行",
        f"- 没有拍摄时间：{sum(1 for p in photos if p.time is None and not p.error)} 张（在 `_未分组`）",
        f"- 有时间但不属于任何旅行：{len(timed) - n_trip} 张（没有复制）",
        f"- 读取失败：{sum(1 for p in photos if p.error)} 张",
        "",
    ]
    if args.dry_run:
        lines += ["这次是 --dry-run，没有复制任何照片。", ""]
    for t in trips:
        dup = sum(1 for p in t.photos if p.note.startswith("重复"))
        blur = sum(1 for p in t.photos if p.note == "模糊")
        days = (t.end.date() - t.start.date()).days + 1
        lines += [
            f"## {t.name}",
            "",
            f"- {t.start:%Y-%m-%d %H:%M} 到 {t.end:%Y-%m-%d %H:%M}，{days} 天",
            f"- {len(t.photos)} 张，其中待删：重复 {dup}，模糊 {blur}",
        ]
        gps = [p for p in t.photos if p.lat is not None]
        if gps:
            lat = sum(p.lat for p in gps) / len(gps)
            lon = sum(p.lon for p in gps) / len(gps)
            lines.append(f"- 大致位置：{lat:.3f}, {lon:.3f}")
        for tk in t.tickets:
            desc = " ".join(
                tk.get(k, "").strip() for k in ("日期", "类型", "出发地", "目的地", "车次航班", "座位")
            )
            lines.append(f"- 票据：{' '.join(desc.split())}")
        lines.append("")
    if unmatched:
        lines += ["## 没对上照片的票据", ""]
        for tk in unmatched:
            lines.append(f"- {tk.get('日期', '')} {tk.get('类型', '')} {tk.get('出发地', '')} {tk.get('目的地', '')} （{tk.get('文件', '')}）")
        lines.append("")
    (args.out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(trips)} 次旅行，报告在 {args.out / 'report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
