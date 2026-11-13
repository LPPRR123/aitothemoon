"""几个脚本共用的小工具：找中文字体、列出图片文件。"""
from __future__ import annotations

import os
from pathlib import Path

from PIL import ImageFont

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"}

_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def load_font(size: int, path: str | None = None) -> ImageFont.ImageFont:
    """返回能显示中文的字体；找不到就退回 Pillow 默认字体（中文会显示成方框）。"""
    for cand in [path, os.environ.get("SCRAPBOOK_FONT"), *_FONT_CANDIDATES]:
        if cand and Path(cand).exists():
            try:
                return ImageFont.truetype(cand, size)
            except OSError:
                continue
    return ImageFont.load_default(size)


def enable_heic() -> bool:
    """装了 pillow-heif 就能读 iPhone 的 HEIC。"""
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        return True
    except ImportError:
        return False


def list_images(folder: Path) -> list[Path]:
    return sorted(
        p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXTS
    )
