# Runbook — move the ORRERY appliance backend to a Pi 5

> **2026-07-17 hardware addendum — the actual build.** Owner's parts: Pi 5 +
> active cooler + **SupTronics X1200 UPS** (2×18650, pogo-pin power, MAX17040
> fuel gauge @ I2C 0x36, PLD GPIO) + **MHS-3.5" display** (ILI9486 480×320 SPI,
> XPT2046 touch). Storage decision: **microSD + nightly dumps** (skip §0's
> SSD steps; SSD later if wear shows). Supplemental steps: **§A–§D below.**

Goal: run the always-on pipeline (postgres, redis, worker, server) on an always-on Pi 5 on the
LAN, **preserving the soak history** (baselines, rollups, signals, briefings, shadow log). The
Mac becomes just a viewer that points its browser at the Pi. Rationale + BOM: [EDGE.md](EDGE.md).

Non-goals: nothing public-facing, no port-forwarding, DO droplet untouched (FOUNDATION §1).

---

## 0. Hardware (once)
- Pi 5 (4 GB), active cooler, 27 W USB-C PSU, microSD (OS only).
- **NVMe via PCIe HAT, or a USB-3 SSD** — Postgres/Redis volumes live here, never the microSD.

## 1. Base OS
1. Flash **Raspberry Pi OS Lite (64-bit)** to the microSD (Raspberry Pi Imager). Preset:
   hostname `orrery`, enable SSH, set WiFi/user. Boot, `ssh orrery@orrery.local`.
2. Mount the SSD and give Docker a home on it:
   ```bash
   sudo mkfs.ext4 /dev/nvme0n1   # or the USB SSD device — CHECK lsblk first
   sudo mkdir -p /mnt/ssd && echo '/dev/nvme0n1 /mnt/ssd ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
   sudo mount -a
   ```
3. Docker CE (arm64):
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```

## 2. The repo on the Pi
- Private repo → add a **read-only deploy key** (Settings → Deploy keys) for this Pi; `git clone`.
- Copy the real `.env` from the Mac (it is gitignored):
  ```bash
  scp /Users/jefe/Downloads/Project_Worldview/.env orrery@orrery.local:~/Project_Worldview/.env
  ```
- Edit the Pi's `.env`:
  - `ORRERY_BIND_HOST=0.0.0.0`  ← makes the server LAN-reachable (Mac browser + pager).
  - Keep `ORRERY_AUTH_TOKEN` identical (the Mac client and pager already hold it).
- Point Docker volumes at the SSD — create `docker-compose.override.yml` (gitignored) on the Pi:
  ```yaml
  services:
    postgres: { volumes: ["/mnt/ssd/orrery/pg:/var/lib/postgresql/data"] }
    redis:    { volumes: ["/mnt/ssd/orrery/redis:/data"] }
  ```
  `mkdir -p /mnt/ssd/orrery/{pg,redis}`.

## 3. Soak-preserving data migration
The crown is Postgres (28-day baselines, rollups, signals, assessments, briefings, shadow log).
Redis hot state is **not** migrated — it rebuilds from the first 90 s OpenSky poll, and BullMQ
repeatable jobs re-register on worker boot.

**Cutover choreography** (do it in one sitting; a few minutes' gap is fine — same ≤1-bucket
standard as the Docker-wedge recoveries, DECISIONS #59):

1. **Freeze the Mac writer** so the dump is consistent:
   ```bash
   docker compose -f <mac>/docker-compose.yml stop worker
   ```
2. **Dump on the Mac** (server still up for reads is fine):
   ```bash
   docker compose exec -T postgres pg_dump -U orrery -Fc orrery > ~/orrery-soak.dump
   scp ~/orrery-soak.dump orrery@orrery.local:~/
   ```
3. **On the Pi**: bring up postgres + redis only, restore, then the app:
   ```bash
   docker compose up -d postgres redis           # waits healthy
   docker compose exec -T postgres pg_restore -U orrery -d orrery --clean --if-exists < ~/orrery-soak.dump
   docker compose up -d worker server
   ```
4. **Verify continuity** (the go/no-go):
   ```bash
   docker compose exec -T postgres psql -U orrery -d orrery -c \
     "select max(bucket_ts) at time zone 'UTC', count(*) from rollup_run;"   # count ≈ Mac's, max advancing
   docker compose logs worker --since 3m | grep -E "global poll|integrity sweep"  # collector alive
   curl -s -H "Authorization: Bearer $TOKEN" http://orrery.local:8787/api/rollups/status | jq  # bucketsLast24h sane
   ```
   New buckets should resume on the 5-min boundary with **no gap > 1 bucket**.
5. **Retire the Mac stack**: `docker compose -f <mac> down` (keep the `.dump` a few days).

## 4. Point the Mac viewer at the Pi
In the Mac repo `.env`: `ORRERY_API_HOST=orrery.local` (or the Pi's IP). `pnpm dev:web` — the
globe now streams from the Pi's WebSocket. (The Pi runs no web client; the browser stays on the
Mac where the GPU lives.)

## 5. Operational notes
- **Soak clock**: the platform move does **not** reset it — the Go/No-Go window (FOUNDATION §11)
  counts by unattended-daily briefings + bucket continuity, both of which survive the dump. Log
  the migration date in DECISIONS so the clock's provenance is auditable.
- **Backups**: nightly `pg_dump` to the SSD (or the Mac) via cron — the soak is now the Pi's
  responsibility, and SSDs fail too.
- **Ops alerts**: this is exactly when `OPS_ALERTS_ENABLED=true` earns its keep — a headless Pi
  that goes silent should ping ntfy. Flip it on at cutover.
- **Firewall**: the Pi's `8787` is LAN-only by virtue of your router. Never forward it.

---

# Hardware addendum (X1200 UPS + MHS-3.5" display, microSD build)

## §A. Assembly & flash
- **Stacking**: X1200 mounts **under** the Pi (pogo-pin power to the bottom pads) —
  the 40-pin header stays free; the MHS-3.5" seats on the header **on top**.
  Cooler between them. Insert both 18650s (mind polarity), power via USB-C
  **into the X1200**, not the Pi.
- **Imager** (Raspberry Pi OS **Lite 64-bit** — no desktop; the display is
  driven directly via the framebuffer): hostname `orrery`, ssh on, WiFi + user
  (`pi`) preset. Boot; from the Mac: `ssh pi@orrery.local`. Everything from
  here is done over ssh.

## §B. MHS-3.5" display (piscreen overlay — no goodtft legacy scripts)
1. `/boot/firmware/config.txt`, add:
   ```
   dtparam=spi=on
   dtparam=i2c_arm=on
   dtoverlay=piscreen,speed=18000000,rotate=90
   ```
   (`rotate=90` = landscape 480×320. If the panel misbehaves on the fbtft
   route, the DRM fallback is `dtoverlay=piscreen,drm` — then the display
   service needs the DRM variant instead of `/dev/fbN`.)
2. Reboot; confirm: `ls /sys/class/graphics/` → expect `fb1` (SPI panel);
   `cat /sys/class/graphics/fb1/virtual_size` → `480,320`.
3. Display service (renders the pager pages to the framebuffer, touch = page
   cycle):
   ```bash
   sudo apt install -y python3-venv fonts-dejavu-core
   python3 -m venv ~/pager-venv && ~/pager-venv/bin/pip install -r ~/Project_Worldview/edge/pager/requirements.txt evdev
   cp ~/Project_Worldview/edge/pager/pager.env.example ~/Project_Worldview/edge/pager/pager.env  # URL=http://127.0.0.1:8787, token
   sudo cp ~/Project_Worldview/edge/appliance/orrery-display.service /etc/systemd/system/
   sudo systemctl enable --now orrery-display
   ```
4. Verify without a camera: `sudo cat /dev/fb1 > /tmp/fb.raw` then convert
   RGB565→PNG on the Mac (or just eyeball the panel).

## §C. X1200 UPS monitor
1. `sudo apt install -y python3-smbus2 python3-libgpiod i2c-tools`
2. `i2cdetect -y 1` → expect `36` (MAX17040 fuel gauge).
3. **Confirm the PLD pin before trusting shutdowns**: watch `pinctrl get 6`
   while plugging/unplugging USB-C — it should follow external power. If it
   doesn't, check the X1200 wiki pinout and set `PLD_GPIO` accordingly.
4. ```bash
   cp ~/Project_Worldview/edge/appliance/x1200.env.example ~/Project_Worldview/edge/appliance/x1200.env  # set NTFY_TOPIC
   sudo cp ~/Project_Worldview/edge/appliance/orrery-x1200.service /etc/systemd/system/
   sudo systemctl enable --now orrery-x1200
   ```
5. The monitor writes `/run/orrery-ups.json`; the display's SYSTEM page picks
   up battery % and AC/ON-BATTERY automatically.
6. **The drill** (do it once, on purpose): pull the USB-C → ntfy "on battery"
   within ~20s, buckets keep accumulating → replug → all-clear. Then lower
   `SOC_SHUTDOWN_PCT` temporarily to force the graceful-stop path and confirm
   Postgres comes back clean (`docker compose up -d`, rollup continuity).
   Log the drill result in DECISIONS.

## §E. Serving the globe from the appliance
The Pi hosts the built web client at **http://10.0.0.177:8787** (server registers
`@fastify/static` when `./webdist` exists — `ORRERY_WEB_DIST` in compose). Deploy
a new client build from the Mac:
```bash
pnpm --filter @orrery/web build
rsync -a --delete apps/web/dist/ pi@orrery.local:~/Project_Worldview/webdist/
# no restart needed — static files are read per-request
```
**⚠ Full-repo rsync rule:** never `--delete` the repo root without excluding the
device-local files (`webdist/`, `edge/pager/pager.env`, `edge/appliance/x1200.env`)
and remember the Pi's `.env` carries appliance-specific values
(`ORRERY_BIND_HOST=0.0.0.0`, `OPS_ALERTS_ENABLED=true`) that a Mac copy will
clobber. (Learned the hard way — DECISIONS #87.)

## §D. Nightly backups (microSD endurance)
```bash
sudo cp ~/Project_Worldview/edge/appliance/orrery-backup.{service,timer} /etc/systemd/system/
sudo systemctl enable --now orrery-backup.timer
systemctl list-timers | grep orrery   # next run 03:30
```
Restore path = §3's `pg_restore` with any `~/backups/orrery-YYYY-MM-DD.dump`.
