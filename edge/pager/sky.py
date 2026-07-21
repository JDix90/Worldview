"""
Sky Tonight for the appliance display: ISS visible passes, moon phase, and
solar elevation — Python ports of the web client's solar.ts/lunar.ts (same
NOAA/Meeus truncations, same accuracy class) plus SGP4 via the `sgp4` package.

TLEs come from CelesTrak's stations group with a 12 h on-disk cache
(~/.cache/orrery-tle-stations.txt) per the project's CelesTrak etiquette
(DECISIONS #53): never refetch inside the TTL, serve stale on failure.
"""
from __future__ import annotations

import math
import os
import time
from typing import Optional

DEG = math.pi / 180
TLE_CACHE = os.path.expanduser("~/.cache/orrery-tle-stations.txt")
TLE_TTL_S = 12 * 3600
TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle"


def _norm360(x: float) -> float:
    return x % 360


def subsolar_point(t_ms: float) -> tuple:
    """(declination_deg, lng_east_deg) — port of solar.ts (NOAA low-precision)."""
    jd = t_ms / 86400000 + 2440587.5
    T = (jd - 2451545.0) / 36525
    L0 = _norm360(280.46646 + T * (36000.76983 + T * 0.0003032))
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    C = (
        (1.914602 - T * (0.004817 + 0.000014 * T)) * math.sin(M * DEG)
        + (0.019993 - 0.000101 * T) * math.sin(2 * M * DEG)
        + 0.000289 * math.sin(3 * M * DEG)
    )
    omega = 125.04 - 1934.136 * T
    lam = L0 + C - 0.00569 - 0.00478 * math.sin(omega * DEG)
    e0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    eps = e0 + 0.00256 * math.cos(omega * DEG)
    dec = math.asin(math.sin(eps * DEG) * math.sin(lam * DEG)) / DEG
    y = math.tan((eps / 2) * DEG) ** 2
    eot = (
        y * math.sin(2 * L0 * DEG)
        - 2 * e * math.sin(M * DEG)
        + 4 * e * y * math.sin(M * DEG) * math.cos(2 * L0 * DEG)
        - 0.5 * y * y * math.sin(4 * L0 * DEG)
        - 1.25 * e * e * math.sin(2 * M * DEG)
    ) / DEG * 4
    ut = (t_ms / 3600000) % 24
    lng = ((12 - ut - eot / 60) * 15 + 540) % 360 - 180
    return dec, lng


def sun_elevation(lat: float, lon: float, t_ms: float) -> float:
    """Sun elevation at observer, degrees."""
    dec, slng = subsolar_point(t_ms)
    cos_z = (
        math.sin(lat * DEG) * math.sin(dec * DEG)
        + math.cos(lat * DEG) * math.cos(dec * DEG) * math.cos((lon - slng) * DEG)
    )
    return 90 - math.acos(max(-1, min(1, cos_z))) / DEG


def moon_phase(t_ms: float) -> dict:
    """{'name', 'illumination', 'waxing'} — port of lunar.ts phase math."""
    jd = t_ms / 86400000 + 2440587.5
    T = (jd - 2451545.0) / 36525
    s = lambda x: math.sin(x * DEG)
    c = lambda x: math.cos(x * DEG)
    Lp = _norm360(218.3164477 + 481267.88123421 * T)
    D = _norm360(297.8501921 + 445267.1114034 * T)
    M = _norm360(357.5291092 + 35999.0502909 * T)
    Mp = _norm360(134.9633964 + 477198.8675055 * T)
    F = _norm360(93.272095 + 483202.0175233 * T)
    lam = (
        Lp + 6.288774 * s(Mp) + 1.274027 * s(2 * D - Mp) + 0.658314 * s(2 * D)
        + 0.213618 * s(2 * Mp) - 0.185116 * s(M) - 0.114332 * s(2 * F)
    )
    beta = 5.128122 * s(F) + 0.280602 * s(Mp + F) + 0.277693 * s(Mp - F)
    sun_l0 = _norm360(280.46646 + T * (36000.76983 + T * 0.0003032))
    sun_c = (
        (1.914602 - T * (0.004817 + 0.000014 * T)) * s(M)
        + (0.019993 - 0.000101 * T) * s(2 * M)
        + 0.000289 * s(3 * M)
    )
    sun_lam = sun_l0 + sun_c
    cos_e = c(beta) * c(lam - sun_lam)
    illum = (1 - cos_e) / 2
    waxing = s(lam - sun_lam) > 0
    name = (
        "new moon" if illum < 0.03 else "full moon" if illum > 0.97
        else ("waxing crescent" if waxing else "waning crescent") if illum < 0.47
        else ("waxing gibbous" if waxing else "waning gibbous") if illum > 0.53
        else "first quarter" if waxing else "last quarter"
    )
    return {"name": name, "illumination": illum, "waxing": waxing}


def _fetch_stations_tle() -> Optional[str]:
    """CelesTrak stations TLEs with 12h disk cache + stale-serve (etiquette)."""
    try:
        st = os.stat(TLE_CACHE)
        if time.time() - st.st_mtime < TLE_TTL_S:
            return open(TLE_CACHE).read()
    except OSError:
        pass
    try:
        import requests

        r = requests.get(TLE_URL, timeout=15, headers={"User-Agent": "ORRERY display (personal)"})
        r.raise_for_status()
        text = r.text
        if "ISS" in text or "ZARYA" in text:
            os.makedirs(os.path.dirname(TLE_CACHE), exist_ok=True)
            open(TLE_CACHE, "w").write(text)
            return text
    except Exception:
        pass
    try:  # stale beats nothing
        return open(TLE_CACHE).read()
    except OSError:
        return None


def _gmst_rad(jd: float) -> float:
    return _norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0)) * DEG


def next_iss_passes(lat: float, lon: float, hours: float = 24, now_ms: Optional[float] = None,
                    tle_text: Optional[str] = None) -> list:
    """Visible ISS passes: elevation >10°, satellite sunlit, observer in dark.
    Returns [{'rise_ms','rise_dir','max_el','duration_s','bright'}]."""
    from sgp4.api import Satrec, jday

    text = tle_text if tle_text is not None else _fetch_stations_tle()
    if not text:
        return []
    lines = text.splitlines()
    l1 = l2 = None
    for i, ln in enumerate(lines):
        if ("ISS" in ln.upper() or "ZARYA" in ln.upper()) and i + 2 < len(lines):
            l1, l2 = lines[i + 1].strip(), lines[i + 2].strip()
            break
    if not l1 or not l2:
        return []
    sat = Satrec.twoline2rv(l1, l2)

    start = now_ms if now_ms is not None else time.time() * 1000
    step_ms = 30_000
    obs_lat, obs_lon = lat * DEG, lon * DEG
    passes = []
    in_pass = False
    rise = rise_az = 0.0
    max_el = -90.0
    vis = tot = 0

    t = start
    while t < start + hours * 3600_000:
        dt = time.gmtime(t / 1000)
        jd, fr = jday(dt.tm_year, dt.tm_mon, dt.tm_mday, dt.tm_hour, dt.tm_min, dt.tm_sec)
        err, r, _v = sat.sgp4(jd, fr)
        if err == 0:
            gmst = _gmst_rad(jd + fr)
            # TEME → ECEF (ignore polar motion; fine at pass scale)
            x = r[0] * math.cos(gmst) + r[1] * math.sin(gmst)
            y = -r[0] * math.sin(gmst) + r[1] * math.cos(gmst)
            z = r[2]
            # observer ECEF (spherical earth adequate here)
            RE = 6371.0
            ox = RE * math.cos(obs_lat) * math.cos(obs_lon)
            oy = RE * math.cos(obs_lat) * math.sin(obs_lon)
            oz = RE * math.sin(obs_lat)
            rx, ry, rz = x - ox, y - oy, z - oz
            # ENU
            e = -math.sin(obs_lon) * rx + math.cos(obs_lon) * ry
            n = (
                -math.sin(obs_lat) * math.cos(obs_lon) * rx
                - math.sin(obs_lat) * math.sin(obs_lon) * ry
                + math.cos(obs_lat) * rz
            )
            u = (
                math.cos(obs_lat) * math.cos(obs_lon) * rx
                + math.cos(obs_lat) * math.sin(obs_lon) * ry
                + math.sin(obs_lat) * rz
            )
            rng = math.sqrt(e * e + n * n + u * u)
            el = math.asin(u / rng) / DEG
            az = _norm360(math.atan2(e, n) / DEG)

            if el > 10:
                if not in_pass:
                    in_pass, rise, rise_az, max_el, vis, tot = True, t, az, el, 0, 0
                max_el = max(max_el, el)
                tot += 1
                # visibility: sat sunlit + observer dark
                dec, slng = subsolar_point(t)
                sun_lon_ecef = slng * DEG
                sx = math.cos(dec * DEG) * math.cos(sun_lon_ecef)
                sy = math.cos(dec * DEG) * math.sin(sun_lon_ecef)
                sz = math.sin(dec * DEG)
                dot = x * sx + y * sy + z * sz
                perp = math.sqrt(max(0.0, x * x + y * y + z * z - dot * dot))
                sunlit = dot > 0 or perp > 6371
                if sunlit and sun_elevation(lat, lon, t) < -6:
                    vis += 1
            elif in_pass:
                in_pass = False
                if tot > 0 and vis / tot > 0.4:
                    pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]
                    passes.append({
                        "rise_ms": rise,
                        "rise_dir": pts[round(rise_az / 22.5) % 16],
                        "max_el": round(max_el),
                        "duration_s": round((t - rise) / 1000),
                        "bright": max_el >= 40,
                    })
        t += step_ms
    return passes
