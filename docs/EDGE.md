# ORRERY on the edge — Pi Zero 2 W & Pi 5 assessment

_Assessment date 2026-07-17. Facts tagged **[verified]** were checked live; **[spec]** are
stable vendor specs; **[on-hardware]** must be measured on the device before trusting._

ORRERY is two things wearing one name: a **light data pipeline** (Collector → Baseline →
Detector → Analyst; Node + Postgres + Redis + BullMQ) and a **heavy WebGL client** (Three.js,
8K textures, 50k-instance fire fields, 20k vessels, two particle systems). They have opposite
hardware appetites, so "can it run on a Pi?" has to be answered per-component, not per-device.

## The two devices

| | **Pi Zero 2 W** | **Pi 5** |
|---|---|---|
| SoC / CPU | BCM2710A1, 4× Cortex-A53 @ 1 GHz [spec] | BCM2712, 4× Cortex-A76 @ 2.4 GHz [spec] |
| RAM | **512 MB** LPDDR2 (shared with GPU) [spec] | 2 / 4 / 8 / 16 GB LPDDR4X [spec] |
| GPU | VideoCore IV, GLES 2.0 [spec] | VideoCore VII, GLES 3.1 + Vulkan [spec] |
| Storage | microSD only [spec] | microSD + **PCIe/NVMe** + USB 3 [spec] |
| Net | WiFi 2.4 GHz, BT [spec] | WiFi 5 (2.4/5), GbE, BT [spec] |
| Attached | **PiSugar Whisplay HAT + PiSugar battery** (owner's) | (headless, or HDMI) |

**Whisplay HAT** [verified — `runtime/whisplay.py`]: 240×280 SPI color LCD (SPI0 @ 100 MHz),
**one** GPIO push-button (BOARD pin 11, press/release callbacks), RGB status LED (soft-PWM,
pins 22/18/16), PWM backlight, WM8960 audio codec (speaker + mic over I2S). Battery state via
the PiSugar software API. → A pocket screen with **one button**, a color LED, and audio. The
pager UI must be designed for single-button navigation.

---

## Pi Zero 2 W — role by role

### ✗ Globe client — not feasible, and not close
The blocker is memory, before GPU generation even matters. The globe's steady-state GPU
texture budget:

| texture | size | +mipmaps |
|---|---|---|
| day 8192×4096 RGBA | 128 MiB | ~170 MiB |
| night 8192×4096 RGBA | 128 MiB | ~170 MiB |
| topo 4096×2048 | 32 MiB | ~43 MiB |
| ship-density 8192×4096 | 128 MiB | ~170 MiB |
| + aerosol / SST / aurora / AOD drapes | — | tens more |

That is **~550 MiB of texture memory alone** — on a board with **512 MB of total system RAM**,
of which the VideoCore GPU can be assigned at most ~128 MB, and before Chromium (which is
unhappy in 512 MB), Three.js, the instanced geometry, or the OS. VideoCore IV is also a
pre-WebGL2 GPU; browser WebGL2 is unreliable under load. **No trimming closes a 4–5× memory
gap.** A bespoke 2D canvas "mini-map" could run, but that's a different product, not this
client. **Verdict: never the globe.**

### ✓✓ Duty-officer pager — the natural fit (BUILT: `edge/pager/`)
Everything the handheld needs, ORRERY already emits as tiny Stage-4 text: the S2 feed, the
07:00 briefing, integrity verdicts, the S1 shadow log, the next launch. A single ~2 KB JSON
pull every 90 s plus an ntfy subscription for instant S1/S2 is trivial for the Zero 2 W and
kind to the PiSugar battery. The globe stays on the desk; the **watch** goes in the pocket.
This honors the four-stage rule perfectly — the pager consumes only analyst/detector outputs,
never raw data. **Verdict: build it.** (See `/api/pager/summary` + `edge/pager/`.)

### ○ Voice briefing endpoint — plausible stretch, not built
The WM8960 speaker + a local Piper TTS voice could read the morning briefing aloud on a
button-press. Piper runs on an A53 (slowly). Documented as a future option; the pager exposes
the briefing text, so this is additive, not blocking.

### ✗ Local pipeline/backend — disqualified
Postgres + Redis + two Node processes in 512 MB, with the 28-day baseline window and 48 h raw
JSONL on a microSD (write-endurance) over 2.4 GHz WiFi: fragile on every axis. The Pi 5 exists
for exactly this. **Verdict: no.**

---

## Pi 5 — role by role

### ✓✓ Appliance backend — highest value, lowest risk (PREPPED: `docs/RUNBOOK-PI5.md`)
The pipeline is light: OpenSky 90 s polls, adsb.fi sweeps, 5-min rollups, a nightly analyst
call. A Pi 5 (4 GB+) runs this with the CPU near-idle and gigabytes to spare. Two real problems
it solves:
1. **Soak fragility.** Docker Desktop on the Mac has wedged **four times** mid-soak (DECISIONS
   #59/#73), and the soak depends on the Mac staying awake. Linux Docker on an always-on Pi is
   appliance-grade — restart-on-boot, no desktop VM.
2. **The DO-droplet rule stays intact.** This is the owner's own LAN hardware, not a public
   server and not the droplet (FOUNDATION §1).

- **arm64 images [verified]:** `postgres:16-alpine`, `redis:7-alpine`, `node:22-alpine` all
  publish `linux/arm64/v8` manifests — the existing Dockerfile/compose build **natively** on a
  Pi 5, no cross-build, no image changes.
- **Storage:** put the Postgres + Redis volumes on an **NVMe (PCIe HAT) or USB-3 SSD**, never
  the microSD — Postgres write patterns kill SD cards. This is the one BOM must-have.
- **OS:** Raspberry Pi OS Lite (64-bit) + Docker CE. Headless.
- **Power:** ~5–10 W idle-ish; fine for 24/7.
- **Soak continuity:** migrate with `pg_dump` (baselines/rollups/signals/briefings/shadow log
  are the crown; Redis hot state rebuilds in one 90 s poll). The soak clock does **not** reset
  if bucket continuity holds through cutover (same ≤1-bucket standard as the Docker-wedge
  recoveries). Runbook in `docs/RUNBOOK-PI5.md`.

**Verdict: do this. It's the single biggest reliability win available.**

### ○ Globe display (kiosk) — probably good, measure first [on-hardware]
VideoCore VII does real WebGL2 (GLES 3.1). A 1080p globe with a **trimmed preset** — Starlink
off, fire cap lowered, textures at the GPU's `MAX_TEXTURE_SIZE` (the terminator material
**already probes and adapts** this, and warns below 8192) — should land ~20–40 fps: fine for an
ambient wall display, short of the Mac's 60. Unknowns that need a real device: sustained
thermals, Chromium WebGL2 stability with our instancing, actual `MAX_TEXTURE_SIZE`. **Verdict:
a measured go/no-go spike, not a commitment.** No repo work until the owner wants to try it.

### △ Hybrid (backend + kiosk on one Pi 5) — possible, watch the budget
An 8 GB Pi 5 could run the stack *and* a kiosk globe. Backend RAM is small; the globe wants
~1 GB and the GPU. Thermals under a pinned GPU + 24/7 pipeline need a fan/heatsink and
measurement. Reasonable later; keep them separate first.

---

## Recommendation

1. **Pi 5 as the appliance backend** — retire the Mac's soak fragility. Highest value. _(prepped)_
2. **Zero 2 W + Whisplay as the duty-officer pager** — the handheld's ideal role. _(built)_
3. **Pi 5 globe kiosk** — a hardware spike when curiosity strikes; not scheduled.
4. Zero 2 W as backend, or the globe on either Zero — **no**.

## BOM for the Pi 5 appliance (owner purchases)
- Raspberry Pi 5, **4 GB** (8 GB only if the kiosk hybrid is wanted)
- Active cooler (official) — 24/7 duty
- **NVMe** via a PCIe HAT **or** a USB-3 SSD — Postgres/Redis volumes (the non-negotiable)
- 27 W USB-C PSU; a microSD for the OS only

## Non-goals (unchanged from FOUNDATION §1)
- Nothing public-facing. LAN only, static-token auth as today.
- The DigitalOcean droplet is never involved.
- No per-user accounts; single operator.
