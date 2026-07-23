#!/usr/bin/env python3
"""Decode a raw RGB565 framebuffer dump into a PNG — the no-camera way to see
the living-room panel (RUNBOOK §B.4).

    ssh pi@orrery.local "sudo cat /dev/fb0 > /tmp/fb.raw"
    python3 fbshot.py out.png [fb.raw] [WxH]

Input defaults to /tmp/fb.raw, size to 480x320 (MHS-3.5, landscape). Pass the
raw path explicitly when comparing two grabs — an earlier /tmp-only version of
this helper hardcoded its input, which made two "different" captures decode
the same stale file and nearly passed off a nine-hour-old frame as live
(2026-07-22). Runs anywhere numpy+Pillow exist (Mac or the Pi's pager venv).
"""
import sys

import numpy as np
from PIL import Image

if len(sys.argv) < 2:
    sys.exit(__doc__)
out = sys.argv[1]
src = sys.argv[2] if len(sys.argv) > 2 else "/tmp/fb.raw"
w, h = (int(v) for v in (sys.argv[3] if len(sys.argv) > 3 else "480x320").split("x"))

r = np.fromfile(src, "<u2")
if r.size < w * h:
    sys.exit(f"{src}: {r.size} px words < {w}x{h} — wrong size or truncated dump")
r = r[: w * h].reshape(h, w)
rgb = np.dstack([((r >> 11) & 0x1F) << 3, ((r >> 5) & 0x3F) << 2, (r & 0x1F) << 3]).astype("uint8")
Image.fromarray(rgb).save(out)
print(f"{out}: {w}x{h} from {src}")
