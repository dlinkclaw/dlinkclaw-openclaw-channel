#!/usr/bin/env python3
# 2026-10-18：Kokoro 中文 G2P 对阿拉伯数字/英文/符号会崩，合成前清洗。
import json, sys
t = sys.argv[1] if len(sys.argv) > 1 else ''
keep = set('，。！？、；：（）《》“”‘’')
DIGITS = str.maketrans('0123456789', '零一二三四五六七八九')
out = []
for ch in t:
    if ch.isascii():
        if ch.isdigit():
            out.append(ch.translate(DIGITS))
        else:
            out.append(' ')
    elif ch in keep:
        out.append(ch)
    elif 0x4e00 <= ord(ch) <= 0x9fff:
        out.append(ch)
    else:
        out.append(' ')
clean = ' '.join(''.join(out).split())[:1200]
print(json.dumps(clean, ensure_ascii=False))