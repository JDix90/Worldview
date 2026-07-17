# Runbook — move the ORRERY appliance backend to a Pi 5

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
