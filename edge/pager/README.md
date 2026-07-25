# ORRERY appliance display (a.k.a. the pager)

The living-room status panel for ORRERY. Deployed on a **Pi 5 + MHS-3.5"
(ILI9486) 480×320 landscape** framebuffer with XPT2046 resistive touch; it
renders the Stage-4 digest from `GET /api/pager/summary` and **never touches raw
data** (four-stage rule). The name "pager" is historical — the original target
was a Pi Zero 2 W + PiSugar Whisplay HAT (240×280), shelved because the globe
can't run in 512 MB; the renderer still supports that geometry (`--size`).
Rationale: [`../../docs/EDGE.md`](../../docs/EDGE.md). Appliance install +
deploy: [`../../docs/RUNBOOK-PI5.md`](../../docs/RUNBOOK-PI5.md).

## The carousel (DECISIONS #115, #135, #136)
A short glance loop, event-driven (repaints only when dirty — no marquee, to
spare SPI writes). Four standing content screens plus SYSTEM, ~50 s a cycle:

- **NOW** — big-type weather + AQI + the folded top hazard (or `✓ nothing
  active near you`).
- **BRIEFING** — the analyst's lead verdict, prominent, with the paged digest.
- **OVERHEAD** — aircraft over the house, home-centered.
- **SKY** — tonight's ISS pass + moon (+ aurora when visible); 15:00–07:00 only.
- **SYSTEM** — panel-only vitals (feed, UPS/battery, wifi, uptime), rides last.

Everything else is an **exception insert** — present only when it fires, slotted
after NOW: **HAZARDS** (extreme weather / IPAWS civil emergency / nearby
earthquake / airport ground-stop), **NEARBY SIGNALS** (a near S1), **RADAR**
(precip near), **TRAFFIC** (a road closure within ~25 mi), **CRIME** (a violent
incident within ~1 mi / 24 h). Red pages promote to the front with a red edge
bar and 1.5× dwell; a civil emergency, severe weather, feed-down, or S1 also
**wakes the sleeping screen** (TRAFFIC/RADAR/CRIME insert but don't promote).

Touch: short tap → next page; long-press (≥0.6 s) → force refresh. The RGB LED
(Whisplay only) mirrors the header dot: green nominal · amber elevated/open-S2 ·
red S1/feed-down/civil-emergency · dim when stale.

## Run it off-device (no hardware needed)
The renderer is pure PIL, so every page can be produced as a PNG:

```bash
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
# a live summary from the backend (or use a captured fixture json):
curl -s -H "Authorization: Bearer $TOKEN" http://orrery.local:8787/api/pager/summary > summary.json
# render the rotation every fixture would produce, at the real panel size:
./venv/bin/python orrery_pager.py --mock ./shots --shot-all summary.json --size 480x320
open ./shots           # one subdir per fixture: NN_<page>.png (00_now.png, …)
./venv/bin/python orrery_pager.py --selftest    # pure sleep/rotation/promotion logic
```

`--fixture NAME` renders a single named world-state (`calm, alerts, tornado,
battery, critical, aurora, emergency, quake, traffic, offline, radar, dusk`) —
the states that can't be summoned on demand from the real world (DECISIONS #119).

## Config (`pager.env`)
| var | meaning |
|---|---|
| `ORRERY_API_URL` | backend base URL — the Pi 5 appliance (`http://orrery.local:8787`) |
| `ORRERY_AUTH_TOKEN` | same static token as the web client |
| `POLL_SEC` | summary poll interval (default 90) |
| `SLEEP_START` / `SLEEP_END` | nightly dark window (local `HH:MM`; empty = never) |
| `WAKE_ON_RED` | let a red status light the sleeping screen (default on) |
| `NTFY_TOPIC` | optional — instant S1/S2 via the existing ntfy topic (SSE) |

## Install / deploy
The Pi 5 appliance runs as the **`orrery-display`** systemd unit
(`../appliance/orrery-display.service`, `--fb /dev/fb0`); a display change is an
rsync + `systemctl restart orrery-display`, separate from the worker/postgres
soak. Full steps: [`../../docs/RUNBOOK-PI5.md`](../../docs/RUNBOOK-PI5.md).

## Notes
- Degrades gracefully: a failed poll shows the last-good data with a stale dot,
  a total outage shows a red **no contact** screen — it never crashes on the net.
- Near-home emergencies (IPAWS civil alerts via `/api/proxy/ipaws`; significant
  earthquakes via USGS direct) and crime/weather/radar are fetched best-effort;
  a failed fetch leaves the state absent, never a stale alarm.
- Battery % comes from the PiSugar/X1200 server (local TCP); WiFi SSID from
  `iwgetid`. Both best-effort and absent off-device.
- Voice briefing (WM8960 speaker + Piper TTS reading the 07:00 briefing) is a
  documented future option, not built — see EDGE.md.
