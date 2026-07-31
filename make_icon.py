"""PWA アイコンを生成する（依存なし: 標準ライブラリのみ）。

以前は 1x1 の透明PNGを 192x192 / 512x512 と偽って manifest に載せており、
PWA のインストールが成立しなかった。実サイズの PNG を書き出す。

    python3 make_icon.py
"""
import math
import struct
import zlib

BG = (59, 130, 246, 255)      # #3b82f6 (manifest の theme_color と揃える)
FG = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def _rounded_rect(x, y, cx, cy, hw, hh, r):
    """中心 (cx, cy)、半幅 hw・半高 hh、角丸 r の矩形内なら True。"""
    dx = abs(x - cx)
    dy = abs(y - cy)
    if dx > hw or dy > hh:
        return False
    if dx <= hw - r or dy <= hh - r:
        return True
    return (dx - (hw - r)) ** 2 + (dy - (hh - r)) ** 2 <= r * r


def _pixel(x, y, size):
    """512基準で設計し、他サイズへは比率で写す。"""
    s = size / 512.0
    px, py = x / s, y / s

    # 外形（角丸の正方形）
    if not _rounded_rect(px, py, 256, 256, 256, 256, 104):
        return TRANSPARENT

    # マイクのヘッド（カプセル）
    if _rounded_rect(px, py, 256, 205, 66, 110, 66):
        return FG

    # ヘッドを囲む U 字のアーチ
    d = math.hypot(px - 256, py - 215)
    if 118 <= d <= 140 and py >= 215:
        return FG

    # 支柱
    if _rounded_rect(px, py, 256, 380, 13, 32, 6):
        return FG

    # 台座
    if _rounded_rect(px, py, 256, 414, 70, 13, 13):
        return FG

    return BG


def render(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # filter type 0
        for x in range(size):
            rows.extend(_pixel(x, y, size))
    return bytes(rows)


def write_png(path, size):
    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(render(size), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print("wrote %s (%dx%d, %d bytes)" % (path, size, size, len(png)))


if __name__ == "__main__":
    write_png("icon-192.png", 192)
    write_png("icon-512.png", 512)
