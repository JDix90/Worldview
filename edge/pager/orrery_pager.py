#!/usr/bin/env python3
"""
ORRERY duty-officer pager — Pi Zero 2 W + PiSugar Whisplay HAT (240x280 LCD,
one button, RGB LED). Renders the Stage-4 digest from GET /api/pager/summary;
never touches raw data (four-stage discipline). The globe stays on the desk —
this is the watch in your pocket. See docs/EDGE.md.

Design forced by the hardware: ONE physical button. Short press cycles pages,
long press forces a refresh. The RGB LED is the at-a-glance status: green
nominal, amber elevated, red S1 / feed-down. Rendering is pure PIL so it runs
identically on hardware and in --mock (which writes PNGs for review).

Config via env or edge/pager/pager.env:
  ORRERY_API_URL   e.g. http://orrery.local:8787   (the Pi 5 appliance)
  ORRERY_AUTH_TOKEN  same static token as the web client
  POLL_SEC         default 90
  NTFY_TOPIC       optional — instant S1/S2 via ntfy SSE
  NTFY_URL         default https://ntfy.sh
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

import requests
from PIL import Image, ImageDraw, ImageFont

W, H = 240, 280

# instrument palette (matches the globe HUD)
BG = (6, 14, 22)
CYAN = (79, 216, 255)
DIM = (143, 163, 184)
WHITE = (210, 224, 236)
AMBER = (255, 179, 0)
RED = (255, 90, 90)
GREEN = (107, 227, 107)
PANEL = (14, 26, 38)

POLL_SEC = int(os.environ.get("POLL_SEC", "90"))


# ─────────────────────────── fonts ───────────────────────────
def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Menlo.ttc",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_SM = _font(12)
F_MD = _font(15)
F_LG = _font(20)
F_HUGE = _font(34)


# ─────────────────────────── data ───────────────────────────
@dataclass
class Summary:
    raw: dict
    fetched_at: float
    ok: bool = True

    @property
    def stale_s(self) -> int:
        return int(time.time() - self.fetched_at)


def fetch_summary(url: str, token: str, timeout: float = 8.0) -> Optional[dict]:
    r = requests.get(
        f"{url}/api/pager/summary",
        headers={"Authorization": f"Bearer {token}"},
        timeout=timeout,
    )
    r.raise_for_status()
    return r.json()


def overall_status(s: dict) -> str:
    """green | amber | red — the LED and header dot."""
    feed = s.get("feed", {})
    if not feed.get("live", False):
        return "red"
    if s.get("shadowS1Last24h", 0) > 0:
        return "red"
    integ = s.get("integrity", [])
    if any(r.get("verdict") == "severe" for r in integ):
        return "red"
    if any(r.get("verdict") == "elevated" for r in integ):
        return "amber"
    if any(sig.get("severity") == "S1" for sig in s.get("signals", [])):
        return "red"
    if s.get("signals"):
        return "amber"
    return "green"


STATUS_RGB = {"green": GREEN, "amber": AMBER, "red": RED, "stale": DIM}


# ─────────────────────────── text helpers ───────────────────────────
def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _demark(text: str) -> str:
    """Strip the markdown emphasis the briefing body carries (**bold**, `code`)."""
    for ch in ("**", "*", "`", "__"):
        text = text.replace(ch, "")
    return text.strip()


def _ago(sec: int) -> str:
    if sec < 90:
        return f"{sec}s"
    if sec < 5400:
        return f"{sec // 60}m"
    if sec < 172800:
        return f"{sec // 3600}h"
    return f"{sec // 86400}d"


# ─────────────────────────── page rendering ───────────────────────────
PAGES = ["STATUS", "SIGNALS", "BRIEFING", "INTEGRITY", "SYSTEM"]


def render(summary: Optional[Summary], page_idx: int, sysinfo: dict) -> Image.Image:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    page = PAGES[page_idx]

    # header bar
    d.rectangle((0, 0, W, 24), fill=PANEL)
    d.text((8, 5), "ORRERY", font=F_SM, fill=CYAN)
    d.text((70, 5), page, font=F_SM, fill=WHITE)
    status = "stale"
    if summary and summary.ok:
        status = overall_status(summary.raw)
        if summary.stale_s > POLL_SEC * 3:
            status = "stale"
    d.ellipse((W - 20, 7, W - 8, 19), fill=STATUS_RGB[status])

    if not summary or not summary.ok:
        d.text((8, 120), "no contact", font=F_LG, fill=RED)
        d.text((8, 148), "with backend", font=F_LG, fill=RED)
        if summary:
            d.text((8, 180), f"last ok {_ago(summary.stale_s)} ago", font=F_SM, fill=DIM)
        _footer(d, page_idx, sysinfo)
        return img

    s = summary.raw
    body_fn = {
        "STATUS": _page_status,
        "SIGNALS": _page_signals,
        "BRIEFING": _page_briefing,
        "INTEGRITY": _page_integrity,
        "SYSTEM": _page_system,
    }[page]
    body_fn(d, s, sysinfo, summary)
    _footer(d, page_idx, sysinfo)
    return img


def _footer(d: ImageDraw.ImageDraw, page_idx: int, sysinfo: dict) -> None:
    y = H - 18
    d.rectangle((0, y, W, H), fill=PANEL)
    # page dots
    for i in range(len(PAGES)):
        cx = 10 + i * 14
        col = CYAN if i == page_idx else DIM
        d.ellipse((cx, y + 6, cx + 6, y + 12), fill=col if i == page_idx else None, outline=col)
    batt = sysinfo.get("battery_pct")
    label = f"{batt}%" if batt is not None else sysinfo.get("clock", "")
    d.text((W - 8 - d.textlength(label, font=F_SM), y + 3), label, font=F_SM, fill=DIM)


def _page_status(d, s, _sys, summ) -> None:
    feed = s["feed"]
    st = overall_status(s)
    d.text((8, 40), {"green": "NOMINAL", "amber": "ELEVATED", "red": "ATTENTION"}[st],
           font=F_LG, fill=STATUS_RGB[st])
    d.text((8, 78), "FEED", font=F_SM, fill=DIM)
    d.text((8, 94), "LIVE" if feed["live"] else "DOWN", font=F_HUGE,
           fill=GREEN if feed["live"] else RED)
    d.text((8, 140), f"{feed['aircraft']:,} aircraft", font=F_MD, fill=WHITE)
    d.text((8, 162), f"data {feed['dataAgeS']}s old", font=F_SM, fill=DIM)
    n_sig = len(s.get("signals", []))
    d.text((8, 192), f"{n_sig} open signal{'s' if n_sig != 1 else ''}", font=F_MD, fill=WHITE)
    s1 = s.get("shadowS1Last24h", 0)
    d.text((8, 214), f"{s1} S1 shadow / 24h", font=F_SM, fill=AMBER if s1 else DIM)
    d.text((8, 236), f"synced {_ago(summ.stale_s)} ago", font=F_SM, fill=DIM)


def _page_signals(d, s, _sys, _summ) -> None:
    sigs = s.get("signals", [])
    if not sigs:
        d.text((8, 130), "nothing of note", font=F_MD, fill=DIM)
        return
    y = 32
    for sig in sigs[:4]:
        sev = sig.get("severity", "S?")
        col = RED if sev == "S1" else AMBER
        d.text((8, y), sev, font=F_MD, fill=col)
        d.text((40, y), f"{sig.get('region') or '—'}  {_ago(sig.get('ageS', 0))}", font=F_SM, fill=DIM)
        lines = _wrap(d, sig.get("what", ""), F_SM, W - 16)[:2]
        yy = y + 18
        for ln in lines:
            d.text((8, yy), ln, font=F_SM, fill=WHITE)
            yy += 14
        disp = sig.get("disposition")
        if disp:
            d.text((8, yy), f"› {disp}", font=F_SM, fill=CYAN)
            yy += 14
        y = yy + 6
        if y > H - 40:
            break


def _page_briefing(d, s, _sys, _summ) -> None:
    b = s.get("briefing")
    if not b:
        d.text((8, 130), "no briefing yet", font=F_MD, fill=DIM)
        return
    date = str(b.get("date", ""))[:10]
    d.text((8, 32), date, font=F_SM, fill=CYAN)
    tag = "QUIET" if b.get("quiet") else "ACTIVE"
    d.text((W - 8 - d.textlength(tag, font=F_SM), 32), tag,
           font=F_SM, fill=DIM if b.get("quiet") else AMBER)
    y = 54
    for ln in _wrap(d, _demark(b.get("headline", "")), F_MD, W - 16)[:3]:
        d.text((8, y), ln, font=F_MD, fill=WHITE)
        y += 18
    y += 6
    for ln in _wrap(d, _demark(b.get("open", "")), F_SM, W - 16)[:11]:
        d.text((8, y), ln, font=F_SM, fill=DIM)
        y += 14
        if y > H - 30:
            break


def _page_integrity(d, s, _sys, _summ) -> None:
    d.text((8, 30), "GPS INTEGRITY", font=F_SM, fill=CYAN)
    y = 54
    vcol = {"nominal": GREEN, "elevated": AMBER, "severe": RED, "no-data": DIM}
    for r in s.get("integrity", []):
        name = r.get("name", "")[:22]
        d.text((8, y), name, font=F_SM, fill=WHITE)
        v = r.get("verdict", "no-data")
        pct = r.get("pct")
        label = v.upper() if pct is None else f"{v.upper()} {pct}%"
        d.text((8, y + 15), label, font=F_MD, fill=vcol.get(v, DIM))
        y += 44
        if y > H - 30:
            break


def _page_system(d, s, sysinfo, summ) -> None:
    d.text((8, 30), "SYSTEM", font=F_SM, fill=CYAN)
    rows = [
        ("battery", f"{sysinfo['battery_pct']}%" if sysinfo.get("battery_pct") is not None else "—"),
        ("wifi", sysinfo.get("wifi", "—")),
        ("backend", "reachable" if (summ and summ.ok) else "unreachable"),
        ("last sync", f"{_ago(summ.stale_s)} ago" if summ else "—"),
        ("poll", f"{POLL_SEC}s"),
        ("clock", sysinfo.get("clock", "")),
    ]
    y = 54
    for k, v in rows:
        d.text((8, y), k, font=F_SM, fill=DIM)
        d.text((110, y), str(v), font=F_SM, fill=WHITE)
        y += 26


# ─────────────────────────── hardware backends ───────────────────────────
class Backend:
    def blit(self, img: Image.Image) -> None: ...
    def set_led(self, rgb: tuple[int, int, int]) -> None: ...
    def on_button(self, short: Callable[[], None], long: Callable[[], None]) -> None: ...
    def battery_pct(self) -> Optional[int]:
        return None
    def cleanup(self) -> None: ...


class WhisplayBackend(Backend):
    """Real hardware. Imports the vendor driver; converts PIL→RGB565-BE."""

    LONG_PRESS_S = 0.6

    def __init__(self) -> None:
        from whisplay import WhisplayBoard  # vendored on the Pi (runtime/whisplay.py)

        self.board = WhisplayBoard()
        self.board.set_backlight(100)
        self._down_at = 0.0
        self._short = self._long = lambda: None

    def blit(self, img: Image.Image) -> None:
        import numpy as np

        a = np.asarray(img.convert("RGB"), dtype=np.uint16)
        r = (a[:, :, 0] >> 3) << 11
        g = (a[:, :, 1] >> 2) << 5
        b = a[:, :, 2] >> 3
        rgb565 = (r | g | b).astype(">u2")  # big-endian: driver sends high byte first
        self.board.draw_image(0, 0, W, H, rgb565.tobytes())

    def set_led(self, rgb: tuple[int, int, int]) -> None:
        self.board.set_rgb(*rgb)

    def on_button(self, short, long) -> None:
        self._short, self._long = short, long
        self.board.on_button_press(lambda: setattr(self, "_down_at", time.time()))
        self.board.on_button_release(self._release)

    def _release(self) -> None:
        held = time.time() - self._down_at
        (self._long if held >= self.LONG_PRESS_S else self._short)()

    def battery_pct(self) -> Optional[int]:
        try:
            # PiSugar exposes battery over a local TCP socket (get battery)
            import socket

            s = socket.create_connection(("127.0.0.1", 8423), timeout=1)
            s.sendall(b"get battery\n")
            resp = s.recv(64).decode()
            s.close()
            return int(float(resp.strip().split(":")[-1]))
        except Exception:
            return None

    def cleanup(self) -> None:
        self.board.cleanup()


class MockBackend(Backend):
    """Off-device: writes each frame to a PNG for review; button via stdin thread."""

    def __init__(self, shot_dir: str) -> None:
        self.shot_dir = shot_dir
        os.makedirs(shot_dir, exist_ok=True)
        self.frame = 0
        self._short = self._long = lambda: None

    def blit(self, img: Image.Image) -> None:
        path = os.path.join(self.shot_dir, f"frame_{self.frame:03d}.png")
        img.save(path)
        self.last_path = path
        self.frame += 1

    def set_led(self, rgb: tuple[int, int, int]) -> None:
        self.last_led = rgb

    def on_button(self, short, long) -> None:
        self._short, self._long = short, long

    def cleanup(self) -> None:
        pass


# ─────────────────────────── app loop ───────────────────────────
@dataclass
class App:
    url: str
    token: str
    backend: Backend
    page_idx: int = 0
    summary: Optional[Summary] = None
    _dirty: bool = True

    def next_page(self) -> None:
        self.page_idx = (self.page_idx + 1) % len(PAGES)
        self._dirty = True

    def refresh(self) -> None:
        try:
            data = fetch_summary(self.url, self.token)
            self.summary = Summary(raw=data, fetched_at=time.time(), ok=True)
        except Exception as e:  # never crash the pager on a bad poll
            if self.summary:
                self.summary.ok = False
            else:
                self.summary = Summary(raw={}, fetched_at=time.time(), ok=False)
            print(f"[pager] poll failed: {e}", file=sys.stderr)
        self._dirty = True

    def sysinfo(self) -> dict:
        return {
            "battery_pct": self.backend.battery_pct(),
            "wifi": _wifi_label(),
            "clock": time.strftime("%H:%M"),
        }

    def draw(self) -> None:
        img = render(self.summary, self.page_idx, self.sysinfo())
        self.backend.blit(img)
        led = STATUS_RGB["stale"]
        if self.summary and self.summary.ok:
            led = STATUS_RGB[overall_status(self.summary.raw)]
        self.backend.set_led(led)
        self._dirty = False

    def run(self) -> None:
        self.backend.on_button(self.next_page, self.refresh)
        self.refresh()
        self.draw()
        last_poll = time.time()
        while True:
            if time.time() - last_poll >= POLL_SEC:
                self.refresh()
                last_poll = time.time()
            if self._dirty:
                self.draw()
            time.sleep(0.05)


def _wifi_label() -> str:
    try:
        import subprocess

        out = subprocess.run(["iwgetid", "-r"], capture_output=True, text=True, timeout=2)
        return out.stdout.strip() or "—"
    except Exception:
        return "—"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", metavar="DIR", help="render frames to PNGs instead of hardware")
    ap.add_argument("--shot-all", metavar="SUMMARY_JSON",
                    help="with --mock: render every page once from a summary JSON file, then exit")
    args = ap.parse_args()

    url = os.environ.get("ORRERY_API_URL", "http://127.0.0.1:8787").rstrip("/")
    token = os.environ.get("ORRERY_AUTH_TOKEN", "")

    if args.mock and args.shot_all:
        import json

        data = json.load(open(args.shot_all))
        backend = MockBackend(args.mock)
        summ = Summary(raw=data, fetched_at=time.time(), ok=True)
        for i in range(len(PAGES)):
            img = render(summ, i, {"battery_pct": 82, "wifi": "home", "clock": "07:14"})
            img.save(os.path.join(args.mock, f"{PAGES[i].lower()}.png"))
        # plus the no-contact state
        render(Summary(raw={}, fetched_at=time.time() - 500, ok=False), 0,
               {"clock": "07:14"}).save(os.path.join(args.mock, "no_contact.png"))
        print(f"wrote {len(PAGES)+1} page PNGs to {args.mock}")
        return

    backend = MockBackend(args.mock) if args.mock else WhisplayBackend()
    app = App(url=url, token=token, backend=backend)
    try:
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        backend.cleanup()


if __name__ == "__main__":
    main()
