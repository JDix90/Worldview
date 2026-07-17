# ORRERY duty-officer pager

A pocket status watch for ORRERY, for the **Pi Zero 2 W + PiSugar Whisplay HAT**
(240×280 LCD, one button, RGB LED, battery). It renders the Stage-4 digest from
`GET /api/pager/summary` — feed health, open signals, the morning briefing, GPS
integrity, and system status — and **never touches raw data** (four-stage rule).
Rationale and the "why not the globe" analysis: [`../../docs/EDGE.md`](../../docs/EDGE.md).

## Interaction (one button, by necessity)
- **Short press** → next page: STATUS · SIGNALS · BRIEFING · INTEGRITY · SYSTEM.
- **Long press** (≥0.6 s) → force a refresh.
- **RGB LED** = at-a-glance status: green nominal · amber elevated / open S2 ·
  red S1 or feed-down · dim when the last poll is stale.

## Run it off-device (no hardware needed)
The renderer is pure PIL, so every page can be produced as a PNG:

```bash
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
# capture a live summary from the backend:
curl -s -H "Authorization: Bearer $TOKEN" http://orrery.local:8787/api/pager/summary > summary.json
./venv/bin/python orrery_pager.py --mock ./shots --shot-all summary.json
open ./shots           # status.png, signals.png, briefing.png, integrity.png, system.png, no_contact.png
```

## Install on the Pi Zero 2 W
1. **Whisplay driver** (not on pip): `git clone https://github.com/PiSugar/whisplay`
   and follow its install (enables SPI/I2C/I2S, installs `spidev`/`gpiod`). The
   runtime dir (`whisplay/runtime`) must be on `PYTHONPATH` — the systemd unit
   sets this.
2. **This pager**:
   ```bash
   python3 -m venv ~/pager-venv
   ~/pager-venv/bin/pip install -r requirements.txt
   cp pager.env.example pager.env    # set ORRERY_API_URL + ORRERY_AUTH_TOKEN
   ```
3. **Service**: edit paths/user in `orrery-pager.service`, then
   ```bash
   sudo cp orrery-pager.service /etc/systemd/system/
   sudo systemctl enable --now orrery-pager
   ```

## Config (`pager.env`)
| var | meaning |
|---|---|
| `ORRERY_API_URL` | backend base URL — the Pi 5 appliance (`http://orrery.local:8787`) |
| `ORRERY_AUTH_TOKEN` | same static token as the web client |
| `POLL_SEC` | summary poll interval (default 90) |
| `NTFY_TOPIC` | optional — instant S1/S2 via the existing ntfy topic (SSE) |

## Notes
- The pager degrades gracefully: a failed poll shows the last-good data with a
  stale dot, and a total outage shows a red **no contact** screen — it never
  crashes on the network.
- Battery % comes from the PiSugar server (local TCP `127.0.0.1:8423`); WiFi
  SSID from `iwgetid`. Both are best-effort and absent off-device.
- Voice briefing (WM8960 speaker + Piper TTS reading the 07:00 briefing) is a
  documented future option, not built — see EDGE.md.
