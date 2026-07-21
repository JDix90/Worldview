#!/usr/bin/env python3
"""
ORRERY duty-officer display — renders the Stage-4 digest from
GET /api/pager/summary; never touches raw data (four-stage discipline).

Two hardware targets, one pure-PIL renderer:
  - Pi Zero 2 W + PiSugar Whisplay HAT: 240x280 portrait, one button, RGB LED
  - Pi 5 appliance + MHS-3.5" (ILI9486): 480x320 landscape framebuffer,
    XPT2046 resistive touch (tap = next page, long-press = refresh)

Interaction contract is identical everywhere: short input advances the page,
long input forces a refresh. Rendering runs identically off-device via --mock
(writes PNGs for review).

Config via env or pager.env:
  ORRERY_API_URL     e.g. http://orrery.local:8787
  ORRERY_AUTH_TOKEN  same static token as the web client
  POLL_SEC           default 90
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass
from typing import Callable, Optional

import requests
from PIL import Image, ImageDraw, ImageFont

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
# Auto-advance pages every N seconds (0 = off). The MHS-3.5 clone's resistive
# touch proved electrically marginal (PENIRQ latches until a real power cut),
# so the appliance display self-cycles; touch still works when it feels like it.
CAROUSEL_SEC = int(os.environ.get("CAROUSEL_SEC", "0"))

# ── screen sleep ─────────────────────────────────────────────────────
# Nightly window (local time) when the backlight goes dark; empty = never.
# A red overall status overrides sleep (WAKE_ON_RED) — the screen lights
# itself when something demands attention, duty-officer style. Manual
# override via /run/orrery-display.ctl (orrery-screen CLI) or the server's
# /api/display pref (browser chip); newest timestamp wins.
SLEEP_START = os.environ.get("SLEEP_START", "")   # e.g. "23:00"
SLEEP_END = os.environ.get("SLEEP_END", "")       # e.g. "06:30"
WAKE_ON_RED = os.environ.get("WAKE_ON_RED", "1") != "0"
WAKE_MINUTES = int(os.environ.get("WAKE_MINUTES", "10"))
CTL_FILE = "/run/orrery-display.ctl"


def _parse_hhmm(s: str) -> Optional[int]:
    try:
        hh, mm = s.strip().split(":")
        v = int(hh) * 60 + int(mm)
        return v if 0 <= v < 1440 else None
    except Exception:
        return None


def in_sleep_window(minute_of_day: int, start_min: Optional[int], end_min: Optional[int]) -> bool:
    """True when the schedule says dark. Handles windows crossing midnight."""
    if start_min is None or end_min is None or start_min == end_min:
        return False
    if start_min < end_min:
        return start_min <= minute_of_day < end_min
    return minute_of_day >= start_min or minute_of_day < end_min


def decide_awake(
    mode: str,                 # 'on' | 'off' | 'auto'
    minute_of_day: int,
    start_min: Optional[int],
    end_min: Optional[int],
    status: str,               # 'green' | 'amber' | 'red' | 'stale'
    wake_on_red: bool,
    temp_wake_active: bool,
) -> bool:
    """The whole sleep policy in one pure, testable function."""
    if mode == "on":
        return True
    if mode == "off":
        return False
    if not in_sleep_window(minute_of_day, start_min, end_min):
        return True
    if wake_on_red and status == "red":
        return True
    return temp_wake_active


# ─────────────────────────── fonts / layout ───────────────────────────
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


@dataclass(frozen=True)
class Layout:
    w: int
    h: int
    landscape: bool
    sm: ImageFont.FreeTypeFont
    md: ImageFont.FreeTypeFont
    lg: ImageFont.FreeTypeFont
    huge: ImageFont.FreeTypeFont
    header_h: int
    footer_h: int
    pad: int
    line_sm: int
    line_md: int


def make_layout(w: int, h: int) -> Layout:
    landscape = w > h
    # scale type roughly with the short edge (240 → the original sizes)
    k = min(w, h) / 240.0 if not landscape else min(w, h) / 280.0
    sz = lambda base: max(10, round(base * k))
    return Layout(
        w=w, h=h, landscape=landscape,
        sm=_font(sz(12)), md=_font(sz(15)), lg=_font(sz(20)), huge=_font(sz(34)),
        header_h=round(24 * k), footer_h=round(18 * k), pad=round(8 * k),
        line_sm=round(14 * k), line_md=round(18 * k),
    )


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
    """green | amber | red — the LED / header dot."""
    feed = s.get("feed", {})
    if not feed.get("live", False):
        return "red"
    if s.get("shadowS1Last24h", 0) > 0:
        return "red"
    integ = s.get("integrity", [])
    if any(r.get("verdict") == "severe" for r in integ):
        return "red"
    if any(sig.get("severity") == "S1" for sig in s.get("signals", [])):
        return "red"
    if any(r.get("verdict") == "elevated" for r in integ):
        return "amber"
    if s.get("signals"):
        return "amber"
    return "green"


STATUS_RGB = {"green": GREEN, "amber": AMBER, "red": RED, "stale": DIM}
VERDICT_RGB = {"nominal": GREEN, "elevated": AMBER, "severe": RED, "no-data": DIM}

# ─────────────────────────── local conditions (TODAY page) ───────────────────
# Living-room role: weather + alerts lead the display. Keyless sources, both
# verified live: Open-Meteo (forecast + air quality) and NWS active alerts.
WMO_WORDS = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow",
    77: "snow grains", 80: "showers", 81: "showers", 82: "heavy showers",
    85: "snow showers", 86: "snow showers", 95: "thunderstorm", 96: "hail storm", 99: "hail storm",
}

RED_ALERT_RE = None  # compiled lazily to keep import cheap


def weather_status(alerts: list) -> str:
    """green|amber|red from NWS alerts — Extreme/Severe or tornado-class = red.
    Red feeds the same wake-on-red path as instrument reds: a Tornado Warning
    lights the sleeping living-room screen."""
    global RED_ALERT_RE
    if RED_ALERT_RE is None:
        import re

        RED_ALERT_RE = re.compile(r"tornado|flash flood|blizzard|extreme wind", re.I)
    worst = "green"
    for a in alerts:
        sev = str(a.get("severity", "")).lower()
        event = str(a.get("event", ""))
        if sev in ("extreme", "severe") or RED_ALERT_RE.search(event):
            return "red"
        worst = "amber"
    return worst


def worse(a: str, b: str) -> str:
    order = {"green": 0, "stale": 0, "amber": 1, "red": 2}
    return a if order.get(a, 0) >= order.get(b, 0) else b


def compass16(deg: float) -> str:
    pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
    return pts[round(deg / 22.5) % 16]


def aqi_band(aqi: int) -> tuple:
    if aqi <= 50:
        return "good", GREEN
    if aqi <= 100:
        return "moderate", AMBER
    if aqi <= 150:
        return "unhealthy (sensitive)", (255, 157, 77)
    if aqi <= 200:
        return "unhealthy", RED
    return "very unhealthy", (200, 107, 255)


def geomagnetic_lat(lat: float, lon: float) -> float:
    """Dipole approximation (2025 CGM pole 80.9N 72.7W) — few degrees accuracy."""
    import math
    D = math.pi / 180
    p_lat, p_lon = 80.9 * D, -72.7 * D
    d = math.acos(
        math.sin(lat * D) * math.sin(p_lat)
        + math.cos(lat * D) * math.cos(p_lat) * math.cos(lon * D - p_lon)
    )
    return 90 - d / D


def aurora_verdict(kp, lat: float, lon: float) -> str:
    """none|horizon|overhead — oval boundary ~ maglat 66 - 2*Kp."""
    if kp is None:
        return "none"
    maglat = abs(geomagnetic_lat(lat, lon))
    boundary = 66 - 2 * kp
    if maglat >= boundary:
        return "overhead"
    if maglat >= boundary - 5:
        return "horizon"
    return "none"


def fetch_local_conditions(lat: float, lon: float) -> dict:
    """One shot of weather + AQI + alerts. Every field optional; failures
    degrade to absent keys (the TODAY page renders dashes)."""
    out: dict = {"alerts": []}
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon,
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m",
                "daily": "temperature_2m_max,temperature_2m_min,sunrise,sunset",
                "temperature_unit": "fahrenheit", "wind_speed_unit": "mph", "timezone": "auto",
            },
            timeout=8,
        )
        r.raise_for_status()
        d = r.json()
        c = d.get("current", {})
        daily = d.get("daily", {})
        out["temp"] = round(c["temperature_2m"])
        out["feels"] = round(c["apparent_temperature"])
        out["cond"] = WMO_WORDS.get(c.get("weather_code"), "—")
        out["wind"] = f"{round(c['wind_speed_10m'])} mph {compass16(c['wind_direction_10m'])}"
        out["hi"] = round(daily["temperature_2m_max"][0])
        out["lo"] = round(daily["temperature_2m_min"][0])
        out["sunrise"] = daily["sunrise"][0][-5:]
        out["sunset"] = daily["sunset"][0][-5:]
    except Exception as e:
        print(f"[display] weather fetch failed: {e}", file=sys.stderr)
    try:
        r = requests.get(
            "https://air-quality-api.open-meteo.com/v1/air-quality",
            params={"latitude": lat, "longitude": lon, "current": "us_aqi,pm2_5"},
            timeout=8,
        )
        r.raise_for_status()
        c = r.json().get("current", {})
        out["aqi"] = round(c["us_aqi"])
        out["pm25"] = round(c["pm2_5"], 1)
    except Exception as e:
        print(f"[display] aqi fetch failed: {e}", file=sys.stderr)
    try:
        r = requests.get(
            f"https://api.weather.gov/alerts/active?point={lat},{lon}",
            headers={"User-Agent": "ORRERY living-room display (personal)"},
            timeout=8,
        )
        if r.ok:  # non-US home → 404/empty, gracefully absent
            for f in r.json().get("features", [])[:3]:
                p = f.get("properties", {})
                end = (p.get("ends") or p.get("expires") or "")
                out["alerts"].append({
                    "event": p.get("event", "Alert"),
                    "severity": p.get("severity", ""),
                    "until": end[11:16] if len(end) >= 16 else "",
                })
    except Exception as e:
        print(f"[display] alerts fetch failed: {e}", file=sys.stderr)
    try:
        r = requests.get(
            "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json",
            timeout=8,
        )
        r.raise_for_status()
        rows = r.json()
        preds = [row["kp"] for row in rows if row.get("observed") == "predicted"][:8]  # next ~24h
        if preds:
            out["kp_max"] = max(preds)
            out["aurora"] = aurora_verdict(out["kp_max"], lat, lon)
    except Exception as e:
        print(f"[display] kp fetch failed: {e}", file=sys.stderr)
    try:
        import sky

        now_ms = time.time() * 1000
        out["moon"] = sky.moon_phase(now_ms)
        passes = sky.next_iss_passes(lat, lon, 24, now_ms)
        if passes:
            out["iss"] = passes[0]
    except Exception as e:
        print(f"[display] sky compute failed: {e}", file=sys.stderr)
    return out


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
# Living-room lineup (2026-07-21): TODAY (weather/alerts) leads; instrument
# vitals moved to SYSTEM; GPS jamming left the Pi entirely (browser only).
PAGES = ["TODAY", "SIGNALS", "BRIEFING", "LOCAL", "SYSTEM"]


def render(summary: Optional[Summary], page_idx: int, sysinfo: dict, L: Layout,
           conditions: Optional[dict] = None) -> Image.Image:
    img = Image.new("RGB", (L.w, L.h), BG)
    d = ImageDraw.Draw(img)
    page = PAGES[page_idx]

    # header bar
    d.rectangle((0, 0, L.w, L.header_h), fill=PANEL)
    d.text((L.pad, (L.header_h - 14) // 2), "ORRERY", font=L.sm, fill=CYAN)
    d.text((L.pad + round(L.w * 0.26), (L.header_h - 14) // 2), page, font=L.sm, fill=WHITE)
    status = "stale"
    if summary and summary.ok:
        status = overall_status(summary.raw)
        if summary.stale_s > POLL_SEC * 3:
            status = "stale"
    # weather severity shares the dot: a Tornado Warning is a red, full stop
    if conditions:
        status = worse(status, weather_status(conditions.get("alerts", [])))
    r = L.header_h // 3
    cy = L.header_h // 2
    d.ellipse((L.w - L.pad - 2 * r, cy - r, L.w - L.pad, cy + r), fill=STATUS_RGB[status])

    if not summary or not summary.ok:
        d.text((L.pad, L.h // 2 - L.line_md), "no contact", font=L.lg, fill=RED)
        d.text((L.pad, L.h // 2 + 4), "with backend", font=L.lg, fill=RED)
        if summary:
            d.text((L.pad, L.h // 2 + L.line_md * 2), f"last ok {_ago(summary.stale_s)} ago", font=L.sm, fill=DIM)
        _footer(d, page_idx, sysinfo, L)
        return img

    s = summary.raw
    if page == "TODAY":
        _page_today(d, s, conditions or {}, L)
    else:
        {
            "SIGNALS": _page_signals,
            "BRIEFING": _page_briefing,
            "LOCAL": _page_local,
            "SYSTEM": _page_system,
        }[page](d, s, sysinfo, summary, L)
    _footer(d, page_idx, sysinfo, L)
    return img


def _page_today(d, s: dict, c: dict, L: Layout) -> None:
    """The living-room glance: big weather, alerts, AQI. All fields optional."""
    y0 = L.header_h + L.pad
    temp = c.get("temp")
    # big temperature + condition
    d.text((L.pad, y0), f"{temp}°" if temp is not None else "—", font=L.huge, fill=WHITE)
    tw = d.textlength(f"{temp}°" if temp is not None else "—", font=L.huge)
    d.text((L.pad + tw + 12, y0 + round(L.huge.size * 0.15)), c.get("cond", ""), font=L.lg, fill=CYAN)
    if c.get("feels") is not None and c.get("feels") != temp:
        d.text((L.pad + tw + 12, y0 + round(L.huge.size * 0.15) + L.line_md + 4),
               f"feels {c['feels']}°", font=L.sm, fill=DIM)
    y = y0 + round(L.huge.size * 1.35)
    # high/low + wind
    hilo = []
    if c.get("hi") is not None:
        hilo.append(f"H {c['hi']}°  L {c['lo']}°")
    if c.get("wind"):
        hilo.append(f"wind {c['wind']}")
    if hilo:
        d.text((L.pad, y), "   ".join(hilo), font=L.md, fill=WHITE)
        y += L.line_md + 4
    # sun times
    if c.get("sunrise"):
        d.text((L.pad, y), f"☀ {c['sunrise']} → {c['sunset']}", font=L.sm, fill=DIM)
        y += L.line_sm + 6
    # AQI
    if c.get("aqi") is not None:
        word, col = aqi_band(c["aqi"])
        aqi_text = f"AQI {c['aqi']} — {word}"
        d.text((L.pad, y), aqi_text, font=L.md, fill=col)
        d.text((L.pad + d.textlength(aqi_text, font=L.md) + 10, y + 2),
               f"PM2.5 {c.get('pm25', '—')}", font=L.sm, fill=DIM)
        y += L.line_md + 8
    # evening sky block: ISS pass + moon, shown from ~1h before sunset onward
    def _min_of(hhmm):
        try:
            hh, mm = hhmm.split(":")
            return int(hh) * 60 + int(mm)
        except Exception:
            return None
    now = time.localtime()
    now_min = now.tm_hour * 60 + now.tm_min
    ss = _min_of(c.get("sunset", "")) if c.get("sunset") else None
    evening = ss is not None and now_min >= ss - 60
    if evening:
        iss = c.get("iss")
        if iss:
            rise = time.localtime(iss["rise_ms"] / 1000)
            tonight = rise.tm_yday == now.tm_yday
            when = f"{rise.tm_hour:02d}:{rise.tm_min:02d}"
            label = f"✦ ISS {'tonight' if tonight else 'tomorrow'} {when} · rises {iss['rise_dir']} · max {iss['max_el']}°"
            if iss.get("bright"):
                label += " · bright"
            d.text((L.pad, y), label, font=L.md, fill=CYAN if iss.get("bright") else WHITE)
            y += L.line_md + 2
        moon = c.get("moon")
        if moon:
            d.text((L.pad, y), f"☾ {moon['name']} · {round(moon['illumination'] * 100)}% lit",
                   font=L.sm, fill=DIM)
            y += L.line_sm + 4
    # aurora line — rare enough to always show when non-none
    if c.get("aurora") in ("horizon", "overhead"):
        word = "likely overhead" if c["aurora"] == "overhead" else "possible on the northern horizon"
        d.text((L.pad, y), f"✦ aurora {word} — look north late", font=L.md,
               fill=GREEN if c["aurora"] == "overhead" else AMBER)
        y += L.line_md + 2
    # home-airport delay line — exception-based like alerts (FAA via summary)
    ap = s.get("airport")
    if ap:
        is_red = ap.get("type") in ("ground-stop", "closure")
        line = f"✈ {ap.get('code', '?')}: {str(ap.get('type', '')).replace('-', ' ')}"
        if ap.get("detail"):
            line += f" · {ap['detail']}"
        d.text((L.pad, y), line, font=L.md, fill=RED if is_red else AMBER)
        y += L.line_md + 2
    # alerts block — omitted entirely when quiet
    for a in c.get("alerts", []):
        sev = str(a.get("severity", "")).lower()
        is_red = weather_status([a]) == "red"
        col = RED if is_red else AMBER
        line = f"⚠ {a.get('event', 'Alert')}"
        if a.get("until"):
            line += f" · until {a['until']}"
        d.text((L.pad, y), line, font=L.md, fill=col)
        y += L.line_md + 2
        if y > L.h - L.footer_h - L.line_md:
            break


def _footer(d: ImageDraw.ImageDraw, page_idx: int, sysinfo: dict, L: Layout) -> None:
    y = L.h - L.footer_h
    d.rectangle((0, y, L.w, L.h), fill=PANEL)
    for i in range(len(PAGES)):
        cx = L.pad + 2 + i * 14
        col = CYAN if i == page_idx else DIM
        d.ellipse((cx, y + L.footer_h // 3, cx + 6, y + L.footer_h // 3 + 6),
                  fill=col if i == page_idx else None, outline=col)
    batt = sysinfo.get("battery_pct")
    label = f"{batt}%" if batt is not None else sysinfo.get("clock", "")
    d.text((L.w - L.pad - d.textlength(label, font=L.sm), y + 2), label, font=L.sm, fill=DIM)


def _col_x(L: Layout) -> int:
    """Landscape: x where the right column starts."""
    return L.w // 2 + L.pad


def _sig_kind(what: str) -> str:
    """'radio failure' from 'UAL2339 squawking 7600 (radio failure). ...'"""
    if "(" in what and ")" in what:
        inner = what[what.index("(") + 1 : what.index(")")]
        if 0 < len(inner) <= 24:
            return inner
    if len(what) <= 24:
        return what
    cut = what[:25].rsplit(" ", 1)[0]  # word boundary, no mid-number chops
    return cut if cut else what[:24]


def _page_signals(d, s, _sys, _summ, L: Layout) -> None:
    sigs = s.get("signals", [])
    if not sigs:
        d.text((L.pad, L.h // 2 - 8), "nothing of note", font=L.md, fill=DIM)
        return
    y = L.header_h + L.pad
    max_w = L.w - 2 * L.pad
    n = 3 if L.landscape else 2
    for sig in sigs[:n]:
        sev = sig.get("severity", "S?")
        col = RED if sev == "S1" else AMBER
        ac = sig.get("aircraft") or {}
        # line 1: severity + identity (route beats callsign beats place beats cell)
        ident = (ac.get("callsign") or "").strip()
        route = sig.get("route")
        if ident and route:
            headline = f"{ident}  {route}"
        elif ident:
            headline = ident
        else:
            headline = sig.get("place") or sig.get("region") or "—"
        d.text((L.pad, y), sev, font=L.md, fill=col)
        d.text((L.pad + 34, y), headline[:44], font=L.md, fill=WHITE)
        # activity tag, right-aligned: ACTIVE (amber) while still squawking, else CLEARED
        if ac:
            tag = "ACTIVE" if ac.get("stillSquawking") else "CLEARED"
            tw = d.textlength(tag, font=L.sm)
            d.text((L.w - L.pad - tw, y + 2), tag, font=L.sm,
                   fill=AMBER if ac.get("stillSquawking") else DIM)
        # line 2: kind · where relative to you · age
        yy = y + L.line_md
        parts = [_sig_kind(sig.get("what", ""))]
        dist = sig.get("distMi")
        if dist is not None and dist < 1500:
            parts.append(f"{dist}mi {sig.get('bearing') or ''} of you".strip())
        elif sig.get("place"):
            parts.append(sig.get("place"))
        parts.append(_ago(sig.get("ageS", 0)))
        if ac.get("altFt"):
            parts.append(f"{ac['altFt']:,} ft")
        d.text((L.pad, yy), " · ".join(str(p) for p in parts)[:70], font=L.sm, fill=DIM)
        yy += L.line_sm
        # line 3: the analyst's read (narrative beats bare disposition)
        story = sig.get("narrative") or sig.get("disposition")
        if story:
            ln = _wrap(d, f"› {story}", L.sm, max_w)[0]
            d.text((L.pad, yy), ln, font=L.sm, fill=CYAN)
            yy += L.line_sm
        y = yy + 7
        if y > L.h - L.footer_h - L.line_md * 2:
            break


def _page_briefing(d, s, _sys, _summ, L: Layout) -> None:
    b = s.get("briefing")
    if not b:
        d.text((L.pad, L.h // 2 - 8), "no briefing yet", font=L.md, fill=DIM)
        return
    y0 = L.header_h + L.pad
    date = str(b.get("date", ""))[:10]
    d.text((L.pad, y0), date, font=L.sm, fill=CYAN)
    tag = "QUIET" if b.get("quiet") else "ACTIVE"
    d.text((L.w - L.pad - d.textlength(tag, font=L.sm), y0), tag,
           font=L.sm, fill=DIM if b.get("quiet") else AMBER)
    y = y0 + L.line_sm + 8
    max_w = L.w - 2 * L.pad
    # lead: the bottom-line verdict (prominent)
    for ln in _wrap(d, _demark(b.get("lead", "")), L.md, max_w):
        d.text((L.pad, y), ln, font=L.md, fill=WHITE)
        y += L.line_md
    # what-changed: the substance (dim, fills the middle), leaving room for the
    # sign-off pinned near the footer
    signoff = _demark(b.get("signoff") or "")
    reserve = (L.line_sm * 2 + 6) if signoff else 0
    changed = b.get("changed")
    if changed:
        y += 4
        d.text((L.pad, y), "changed", font=L.sm, fill=CYAN)
        y += L.line_sm
        budget = (L.h - L.footer_h - reserve - y) // L.line_sm
        for ln in _wrap(d, _demark(changed), L.sm, max_w)[:max(0, budget)]:
            d.text((L.pad, y), ln, font=L.sm, fill=DIM)
            y += L.line_sm
    # sign-off: the duty-officer tagline, near the bottom
    if signoff:
        sy = L.h - L.footer_h - reserve + 2
        for ln in _wrap(d, f'"{signoff}"', L.sm, max_w)[:2]:
            d.text((L.pad, sy), ln, font=L.sm, fill=CYAN)
            sy += L.line_sm


def _page_local(d, s, _sys, _summ, L: Layout) -> None:
    """What's overhead — the 'look up' page, anchored to the home location."""
    y0 = L.header_h + L.pad
    over = s.get("overhead") or {}
    count = over.get("count")
    if count is None:
        d.text((L.pad, L.h // 2 - 8), "no local data (old server?)", font=L.md, fill=DIM)
        return
    d.text((L.pad, y0), f"OVERHEAD — {count} within 150 mi", font=L.sm, fill=CYAN)
    if over.get("milCount"):
        tag = f"{over['milCount']} MILITARY"
        d.text((L.w - L.pad - d.textlength(tag, font=L.sm), y0), tag, font=L.sm, fill=AMBER)
    tops = over.get("tops") or []
    if not tops:
        d.text((L.pad, L.h // 2 - 8), "quiet sky above you", font=L.md, fill=DIM)
        return
    y = y0 + L.line_sm + 10
    for t in tops:
        ident = (t.get("callsign") or "—").strip() or "—"
        line1 = ident
        if t.get("typeDesc"):
            line1 += f"  {t['typeDesc'][:26]}"
        d.text((L.pad, y), line1, font=L.md, fill=AMBER if t.get("mil") else WHITE)
        if t.get("mil"):
            tw = d.textlength("MIL", font=L.sm)
            d.text((L.w - L.pad - tw, y + 2), "MIL", font=L.sm, fill=AMBER)
        bits = []
        if t.get("altFt"):
            bits.append(f"{t['altFt']:,} ft")
        bits.append(f"{t.get('distMi', '?')}mi {t.get('bearing', '')}".strip())
        d.text((L.pad, y + L.line_md), " · ".join(bits), font=L.sm, fill=DIM)
        y += L.line_md + L.line_sm + 8
        if y > L.h - L.footer_h - L.line_md:
            break


def _page_system(d, s, sysinfo, summ, L: Layout) -> None:
    y0 = L.header_h + L.pad
    d.text((L.pad, y0), "SYSTEM", font=L.sm, fill=CYAN)
    feed = s.get("feed", {})
    rows = [
        ("feed", ("LIVE" if feed.get("live") else "DOWN") + f" · {feed.get('aircraft', 0):,} aircraft" if feed else "—"),
        ("S1 shadow", f"{s.get('shadowS1Last24h', 0)} / 24h"),
        ("signals", f"{len(s.get('signals', []))} open"),
        ("battery", f"{sysinfo['battery_pct']}%" if sysinfo.get("battery_pct") is not None else "—"),
        ("power", sysinfo.get("power", "—")),
        ("wifi", sysinfo.get("wifi", "—")),
        ("backend", "reachable" if (summ and summ.ok) else "unreachable"),
        ("last sync", f"{_ago(summ.stale_s)} ago" if summ else "—"),
    ]
    y = y0 + L.line_sm + 8
    label_w = round(L.w * 0.42)
    for k, v in rows:
        d.text((L.pad, y), k, font=L.sm, fill=DIM)
        d.text((L.pad + label_w, y), str(v), font=L.sm, fill=WHITE)
        y += L.line_sm + 8
    # heartbeat sparkline: 24h global aircraft counts (when it fits)
    traffic = sysinfo.get("traffic")
    strip_h = 30
    if traffic and len(traffic) > 2 and y + strip_h < L.h - L.footer_h - 4:
        w = L.w - 2 * L.pad
        lo, hi = min(traffic), max(traffic)
        span = max(1, hi - lo)
        pts = [
            (L.pad + round(i * w / (len(traffic) - 1)),
             y + strip_h - 4 - round((v - lo) / span * (strip_h - 8)))
            for i, v in enumerate(traffic)
        ]
        d.text((L.pad, y - 2), "24h traffic", font=L.sm, fill=CYAN)
        d.line(pts, fill=CYAN, width=1)


# ─────────────────────────── hardware backends ───────────────────────────
class Backend:
    def blit(self, img: Image.Image) -> None: ...
    def set_led(self, rgb: tuple[int, int, int]) -> None: ...
    def on_input(self, short: Callable[[], None], long: Callable[[], None]) -> None: ...
    def set_power(self, on: bool) -> None: ...
    def battery_pct(self) -> Optional[int]:
        return None
    def cleanup(self) -> None: ...


class WhisplayBackend(Backend):
    """Pi Zero 2 W + Whisplay HAT: SPI blit (RGB565 big-endian), button, LED."""

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
        rgb565 = (((a[:, :, 0] >> 3) << 11) | ((a[:, :, 1] >> 2) << 5) | (a[:, :, 2] >> 3)).astype(">u2")
        self.board.draw_image(0, 0, img.width, img.height, rgb565.tobytes())

    def set_led(self, rgb: tuple[int, int, int]) -> None:
        self.board.set_rgb(*rgb)

    def on_input(self, short, long) -> None:
        self._short, self._long = short, long
        self.board.on_button_press(lambda: setattr(self, "_down_at", time.time()))
        self.board.on_button_release(self._release)

    def set_power(self, on: bool) -> None:
        self.board.set_backlight(100 if on else 0)  # Whisplay's backlight is real

    def _release(self) -> None:
        held = time.time() - self._down_at
        (self._long if held >= self.LONG_PRESS_S else self._short)()

    def battery_pct(self) -> Optional[int]:
        try:
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


class FramebufferBackend(Backend):
    """Pi 5 appliance + MHS-3.5" via fbtft: mmap /dev/fbN, RGB565 little-endian.

    Geometry (xres/yres/bpp/stride) is read from sysfs so rotation and driver
    quirks are respected. Optional XPT2046 touch via evdev: tap = short,
    hold >= 0.6s = long. Battery/power come from the X1200 monitor's status
    file when present (written by edge/appliance/x1200_monitor.py).
    """

    LONG_PRESS_S = 0.6
    X1200_STATUS = "/run/orrery-ups.json"

    def __init__(self, fbdev: str, touch: Optional[str]) -> None:
        import mmap

        name = os.path.basename(fbdev)
        sysfs = f"/sys/class/graphics/{name}"
        self.xres, self.yres = (
            int(v) for v in open(f"{sysfs}/virtual_size").read().strip().split(",")
        )
        self.bpp = int(open(f"{sysfs}/bits_per_pixel").read().strip())
        try:
            self.stride = int(open(f"{sysfs}/stride").read().strip())
        except OSError:
            self.stride = self.xres * self.bpp // 8
        if self.bpp != 16:
            raise RuntimeError(f"{fbdev}: expected 16bpp RGB565, got {self.bpp}bpp")
        self._f = open(fbdev, "r+b")
        self._mm = mmap.mmap(self._f.fileno(), self.stride * self.yres)
        self._short = self._long = lambda: None
        self._touch_thread = None
        self._touch_stop = False
        if touch:
            self._start_touch(touch)

    def blit(self, img: Image.Image) -> None:
        import numpy as np

        if img.size != (self.xres, self.yres):
            img = img.resize((self.xres, self.yres))
        a = np.asarray(img.convert("RGB"), dtype=np.uint16)
        rgb565 = (((a[:, :, 0] >> 3) << 11) | ((a[:, :, 1] >> 2) << 5) | (a[:, :, 2] >> 3)).astype("<u2")
        row_bytes = self.xres * 2
        buf = rgb565.tobytes()
        if self.stride == row_bytes:
            self._mm.seek(0)
            self._mm.write(buf)
        else:
            for y in range(self.yres):
                self._mm.seek(y * self.stride)
                self._mm.write(buf[y * row_bytes : (y + 1) * row_bytes])

    def set_led(self, rgb: tuple[int, int, int]) -> None:
        pass  # no LED on this hardware; the header dot carries the status

    def on_input(self, short, long) -> None:
        self._short, self._long = short, long

    def _start_touch(self, spec: str) -> None:
        import threading

        def find_device() -> Optional[str]:
            if spec != "auto":
                return spec
            try:
                from evdev import InputDevice, list_devices

                for path in list_devices():
                    if "ADS7846" in InputDevice(path).name.upper():
                        return path
            except Exception:
                pass
            return None

        def loop() -> None:
            from evdev import InputDevice, ecodes

            path = find_device()
            if not path:
                print("[display] no touch device found", file=sys.stderr)
                return
            dev = InputDevice(path)
            down_at = 0.0
            for ev in dev.read_loop():
                if self._touch_stop:
                    return
                if ev.type == ecodes.EV_KEY and ev.code == ecodes.BTN_TOUCH:
                    if ev.value == 1:
                        down_at = time.time()
                    else:
                        held = time.time() - down_at
                        (self._long if held >= self.LONG_PRESS_S else self._short)()

        self._touch_thread = threading.Thread(target=loop, daemon=True)
        self._touch_thread.start()

    def set_power(self, on: bool) -> None:
        """True lights-out via the panel's registered backlight device
        (bl_power: 0 = on, 4 = FB_BLANK_POWERDOWN); fb blank as fallback."""
        import glob

        wrote = False
        for p in sorted(glob.glob("/sys/class/backlight/*/bl_power")):
            try:
                with open(p, "w") as f:
                    f.write("0" if on else "4")
                wrote = True
                break
            except OSError:
                continue
        if not wrote:
            try:
                name = os.path.basename(self._f.name)
                with open(f"/sys/class/graphics/{name}/blank", "w") as f:
                    f.write("0" if on else "1")
            except OSError as e:
                print(f"[display] set_power failed: {e}", file=sys.stderr)

    def battery_pct(self) -> Optional[int]:
        try:
            import json

            st = json.load(open(self.X1200_STATUS))
            return int(st.get("soc_pct"))
        except Exception:
            return None

    def power_label(self) -> Optional[str]:
        try:
            import json

            st = json.load(open(self.X1200_STATUS))
            return "AC" if st.get("ac_present") else "ON BATTERY"
        except Exception:
            return None

    def cleanup(self) -> None:
        self._touch_stop = True
        self._mm.close()
        self._f.close()


class MockBackend(Backend):
    """Off-device: writes each frame to a PNG; no input."""

    def __init__(self, shot_dir: str) -> None:
        self.shot_dir = shot_dir
        os.makedirs(shot_dir, exist_ok=True)
        self.frame = 0

    def blit(self, img: Image.Image) -> None:
        path = os.path.join(self.shot_dir, f"frame_{self.frame:03d}.png")
        img.save(path)
        self.last_path = path
        self.frame += 1

    def set_led(self, rgb: tuple[int, int, int]) -> None:
        self.last_led = rgb

    def on_input(self, short, long) -> None:
        pass

    def set_power(self, on: bool) -> None:
        self.power_state = on  # recorded for tests

    def cleanup(self) -> None:
        pass


# ─────────────────────────── app loop ───────────────────────────
@dataclass
class App:
    url: str
    token: str
    backend: Backend
    layout: Layout
    page_idx: int = 0
    summary: Optional[Summary] = None
    _dirty: bool = True
    # screen-sleep state
    conditions: Optional[dict] = None
    _cond_at: float = 0.0
    _mode: str = "auto"          # 'on' | 'off' | 'auto', newest writer wins
    _mode_ts: float = 0.0
    _awake: bool = True
    _temp_wake_until: float = 0.0
    _ctl_mtime: float = 0.0

    def next_page(self) -> None:
        self.page_idx = (self.page_idx + 1) % len(PAGES)
        self._dirty = True

    def refresh(self) -> None:
        try:
            data = fetch_summary(self.url, self.token)
            self.summary = Summary(raw=data, fetched_at=time.time(), ok=True)
        except Exception as e:  # never crash the display on a bad poll
            if self.summary:
                self.summary.ok = False
            else:
                self.summary = Summary(raw={}, fetched_at=time.time(), ok=False)
            print(f"[display] poll failed: {e}", file=sys.stderr)
        self._fetch_server_mode()
        self._refresh_conditions()
        self._dirty = True

    def _refresh_conditions(self) -> None:
        """Weather/AQI/alerts for the TODAY page, every 10 min, at the home
        coords the summary already carries."""
        if time.time() - self._cond_at < 600:
            return
        home = (self.summary.raw.get("home") if self.summary and self.summary.ok else None) or {}
        lat, lon = home.get("lat"), home.get("lon")
        if lat is None or lon is None:
            return
        self._cond_at = time.time()
        self.conditions = fetch_local_conditions(lat, lon)
        try:  # heartbeat sparkline for the SYSTEM page (read-only stats)
            r = requests.get(
                f"{self.url}/api/stats/traffic24h",
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=8,
            )
            r.raise_for_status()
            self.conditions["traffic"] = [p["total"] for p in r.json().get("points", [])]
        except Exception:
            pass
        self._dirty = True

    def _fetch_server_mode(self) -> None:
        """Browser chip → server pref → applied here (piggybacks the poll)."""
        try:
            r = requests.get(
                f"{self.url}/api/display",
                headers={"Authorization": f"Bearer {self.token}"},
                timeout=5,
            )
            r.raise_for_status()
            d = r.json()
            ts = float(d.get("ts", 0)) / 1000.0  # server sends ms
            mode = d.get("mode", "auto")
            if mode in ("on", "off", "auto") and ts > self._mode_ts:
                self._set_mode(mode, ts, "server")
        except Exception:
            pass  # pref is a nicety; never disturb the display over it

    def _check_ctl_file(self) -> None:
        """orrery-screen CLI writes {'mode','ts'} — instant local control."""
        try:
            mtime = os.path.getmtime(CTL_FILE)
        except OSError:
            return
        if mtime <= self._ctl_mtime:
            return
        self._ctl_mtime = mtime
        try:
            import json

            d = json.load(open(CTL_FILE))
            mode, ts = d.get("mode"), float(d.get("ts", 0))
            if mode in ("on", "off", "auto") and ts > self._mode_ts:
                self._set_mode(mode, ts, "ctl-file")
        except Exception as e:
            print(f"[display] bad ctl file: {e}", file=sys.stderr)

    def _set_mode(self, mode: str, ts: float, source: str) -> None:
        if mode != self._mode:
            print(f"[display] screen mode -> {mode} (via {source})", flush=True)
        self._mode, self._mode_ts = mode, ts

    def _apply_sleep(self) -> None:
        now = time.localtime()
        status = "stale"
        if self.summary and self.summary.ok:
            status = overall_status(self.summary.raw)
        if self.conditions:
            status = worse(status, weather_status(self.conditions.get("alerts", [])))
        awake = decide_awake(
            self._mode,
            now.tm_hour * 60 + now.tm_min,
            _parse_hhmm(SLEEP_START),
            _parse_hhmm(SLEEP_END),
            status,
            WAKE_ON_RED,
            time.time() < self._temp_wake_until,
        )
        if awake != self._awake:
            self._awake = awake
            if not awake:
                # Blit solid black BEFORE cutting power: the ILI9486 self-
                # refreshes its last frame from GRAM, and on MHS-3.5 clones
                # the backlight is hardwired on (bl_power is a stub with
                # max_brightness=0 — verified by eyeball 2026-07-20), so the
                # black frame IS the sleep visual there. On hardware with a
                # real backlight (Whisplay), set_power does the rest.
                self.backend.blit(Image.new("RGB", (self.layout.w, self.layout.h), (0, 0, 0)))
            self.backend.set_power(awake)
            print(f"[display] screen {'wake' if awake else 'sleep'}", flush=True)
            if awake:
                self._dirty = True  # repaint immediately on wake

    def sysinfo(self) -> dict:
        info = {
            "battery_pct": self.backend.battery_pct(),
            "wifi": _wifi_label(),
            "clock": time.strftime("%H:%M"),
        }
        power = getattr(self.backend, "power_label", lambda: None)()
        if power:
            info["power"] = power
        if self.conditions and self.conditions.get("traffic"):
            info["traffic"] = self.conditions["traffic"]
        return info

    def draw(self) -> None:
        img = render(self.summary, self.page_idx, self.sysinfo(), self.layout, self.conditions)
        self.backend.blit(img)
        led = STATUS_RGB["stale"]
        if self.summary and self.summary.ok:
            led = STATUS_RGB[overall_status(self.summary.raw)]
        self.backend.set_led(led)
        self._dirty = False

    def run(self) -> None:
        self._last_input = time.time()

        def on_tap() -> None:
            self._last_input = time.time()  # manual tap resets the carousel dwell
            if not self._awake:
                # tap while dark = temp wake, tap consumed (no page advance)
                self._temp_wake_until = time.time() + WAKE_MINUTES * 60
                return
            self.next_page()

        def on_hold() -> None:
            if not self._awake:
                self._temp_wake_until = time.time() + WAKE_MINUTES * 60
                return
            self.refresh()

        self.backend.on_input(on_tap, on_hold)
        self.refresh()
        self._apply_sleep()
        if self._awake:
            self.draw()
        last_poll = time.time()
        last_clock = ""
        while True:
            if time.time() - last_poll >= POLL_SEC:
                self.refresh()  # keeps polling while asleep — red-wake needs it
                last_poll = time.time()
            self._check_ctl_file()
            self._apply_sleep()
            if not self._awake:
                time.sleep(0.2)
                continue
            dwell = CAROUSEL_SEC * (2.5 if self.page_idx == 0 else 0.8) if CAROUSEL_SEC > 0 else 0
            if dwell > 0 and time.time() - self._last_input >= dwell:
                self._last_input = time.time()
                self.next_page()
            clock = time.strftime("%H:%M")
            if clock != last_clock:  # keep the footer clock honest
                last_clock = clock
                self._dirty = True
            if self._dirty:
                self.draw()
            time.sleep(0.05)


def selftest() -> int:
    """Exhaustive check of the sleep policy. Returns count of failures."""
    S, E = _parse_hhmm("23:00"), _parse_hhmm("06:30")
    m = lambda hh, mm: hh * 60 + mm
    cases = [
        # (desc, mode, minute, status, temp_wake, expect_awake)
        ("daytime auto",            "auto", m(14, 0),  "green", False, True),
        ("in window sleeps",        "auto", m(23, 30), "green", False, False),
        ("in window after midnight","auto", m(2, 0),   "green", False, False),
        ("window edge start",       "auto", m(23, 0),  "green", False, False),
        ("window edge end wakes",   "auto", m(6, 30),  "green", False, True),
        ("red overrides sleep",     "auto", m(3, 0),   "red",   False, True),
        ("amber does not override", "auto", m(3, 0),   "amber", False, False),
        ("stale does not override", "auto", m(3, 0),   "stale", False, False),
        ("temp wake in window",     "auto", m(1, 0),   "green", True,  True),
        ("manual off in daytime",   "off",  m(14, 0),  "green", False, False),
        ("manual on in window",     "on",   m(3, 0),   "green", False, True),
        ("manual off beats red",    "off",  m(3, 0),   "red",   False, False),
    ]
    fails = 0
    for desc, mode, minute, status, temp, expect in cases:
        got = decide_awake(mode, minute, S, E, status, True, temp)
        ok = got == expect
        fails += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'}  {desc}: awake={got} (want {expect})")
    # wake_on_red disabled → red no longer overrides
    got = decide_awake("auto", m(3, 0), S, E, "red", False, False)
    ok = got is False
    fails += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  WAKE_ON_RED=0 disables red override: awake={got} (want False)")
    # no-window config never sleeps (day window 09:00→17:00 boundary sanity too)
    got = decide_awake("auto", m(3, 0), None, None, "green", True, False)
    ok = got is True
    fails += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  no schedule never sleeps: awake={got} (want True)")
    S2, E2 = _parse_hhmm("09:00"), _parse_hhmm("17:00")
    got = decide_awake("auto", m(12, 0), S2, E2, "green", True, False)
    ok = got is False
    fails += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}  non-midnight-crossing window: awake={got} (want False)")
    # weather-status + combine (living-room wake semantics)
    ws_cases = [
        ("no alerts green", [], "green"),
        ("advisory amber", [{"event": "Heat Advisory", "severity": "Moderate"}], "amber"),
        ("severe red", [{"event": "High Wind Warning", "severity": "Severe"}], "red"),
        ("tornado red by name", [{"event": "Tornado Warning", "severity": "Unknown"}], "red"),
        ("flash flood red", [{"event": "Flash Flood Warning", "severity": "Moderate"}], "red"),
    ]
    for desc, alerts, expect in ws_cases:
        got = weather_status(alerts)
        ok = got == expect
        fails += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'}  {desc}: {got} (want {expect})")
    for desc, a, b, expect in [
        ("worse(green,red)", "green", "red", "red"),
        ("worse(amber,green)", "amber", "green", "amber"),
        ("worse(stale,amber)", "stale", "amber", "amber"),
    ]:
        got = worse(a, b)
        ok = got == expect
        fails += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'}  {desc}: {got} (want {expect})")
    # sky module: moon-phase anchors (lunar verify dates) + structural pass check
    try:
        import sky
        m_new = sky.moon_phase(947116800000)   # 2000-01-06 ~18:14 UTC — new moon
        m_full = sky.moon_phase(948422400000)  # 2000-01-21 ~04:40 UTC — full moon
        for desc, got, want in [
            ("moon new 2000-01-06", m_new["illumination"] < 0.05, True),
            ("moon full 2000-01-21", m_full["illumination"] > 0.95, True),
        ]:
            ok = got == want
            fails += 0 if ok else 1
            print(f"  {'PASS' if ok else 'FAIL'}  {desc}")
        # structural: sun elevation at subsolar point ≈ 90
        dec, slng = sky.subsolar_point(time.time() * 1000)
        el = sky.sun_elevation(dec, slng, time.time() * 1000)
        ok = el > 89
        fails += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'}  sun overhead at subsolar point: {el:.1f}°")
    except Exception as e:
        fails += 1
        print(f"  FAIL  sky module: {e}")
    print(f"selftest: {'ALL PASS' if fails == 0 else f'{fails} FAILURES'}")
    return fails


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
    ap.add_argument("--size", default=None, metavar="WxH",
                    help="render size (default: Whisplay 240x280, or the fb's native size)")
    ap.add_argument("--fb", metavar="/dev/fbN", help="framebuffer device (MHS-3.5 route)")
    ap.add_argument("--touch", default=None, metavar="auto|/dev/input/eventN",
                    help="XPT2046 touch device for the fb route")
    ap.add_argument("--selftest", action="store_true",
                    help="run the sleep-policy test cases and exit")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(1 if selftest() else 0)

    url = os.environ.get("ORRERY_API_URL", "http://127.0.0.1:8787").rstrip("/")
    token = os.environ.get("ORRERY_AUTH_TOKEN", "")

    if args.mock and args.shot_all:
        import json

        os.makedirs(args.mock, exist_ok=True)
        w, h = (int(v) for v in (args.size or "240x280").split("x"))
        L = make_layout(w, h)
        data = json.load(open(args.shot_all))
        summ = Summary(raw=data, fetched_at=time.time(), ok=True)
        sysinfo = {"battery_pct": 82, "wifi": "home", "clock": "07:14", "power": "AC"}
        cond_calm = {"temp": 88, "feels": 85, "cond": "partly cloudy", "wind": "9 mph SSW",
                     "hi": 96, "lo": 68, "sunrise": "05:42", "sunset": "20:27",
                     "aqi": 76, "pm25": 4.5, "alerts": []}
        cond_alerts = dict(cond_calm, alerts=[
            {"event": "Air Quality Alert", "severity": "Unknown", "until": "16:00"},
            {"event": "Heat Advisory", "severity": "Moderate", "until": "21:00"}])
        cond_tornado = dict(cond_calm, cond="thunderstorm", alerts=[
            {"event": "Tornado Warning", "severity": "Extreme", "until": "19:45"}])
        for i in range(len(PAGES)):
            render(summ, i, sysinfo, L, cond_alerts).save(os.path.join(args.mock, f"{PAGES[i].lower()}.png"))
        render(summ, 0, sysinfo, L, cond_calm).save(os.path.join(args.mock, "today_calm.png"))
        render(summ, 0, sysinfo, L, cond_tornado).save(os.path.join(args.mock, "today_tornado.png"))
        render(Summary(raw={}, fetched_at=time.time() - 500, ok=False), 0, sysinfo, L).save(
            os.path.join(args.mock, "no_contact.png"))
        print(f"wrote {len(PAGES) + 1} page PNGs to {args.mock} at {w}x{h}")
        return

    if args.fb:
        backend: Backend = FramebufferBackend(args.fb, args.touch)
        w, h = backend.xres, backend.yres  # type: ignore[attr-defined]
    elif args.mock:
        backend = MockBackend(args.mock)
        w, h = (int(v) for v in (args.size or "240x280").split("x"))
    else:
        backend = WhisplayBackend()
        w, h = 240, 280
    if args.size and not args.fb:
        w, h = (int(v) for v in args.size.split("x"))

    app = App(url=url, token=token, backend=backend, layout=make_layout(w, h))
    try:
        app.run()
    except KeyboardInterrupt:
        pass
    finally:
        backend.cleanup()


if __name__ == "__main__":
    main()
