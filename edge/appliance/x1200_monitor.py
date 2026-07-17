#!/usr/bin/env python3
"""
X1200 UPS monitor for the ORRERY Pi 5 appliance.

Watches the SupTronics X1200 (2x18650) over I2C + GPIO and protects the soak:
  - MAX17040-family fuel gauge @ I2C 0x36: VCELL (reg 0x02, 78.125 uV/LSB),
    SOC (reg 0x04, 1/256 %/LSB).
  - Power-loss detect (PLD) GPIO — HIGH when external power is present
    (expected GPIO6 per the X120x reference implementations; CONFIRM on-device
    with `pinctrl get 6` while plugging/unplugging before trusting shutdowns).
  - Writes /run/orrery-ups.json every cycle (the display's SYSTEM page and
    battery% read this).
  - On AC loss / restore: ntfy to the OPS topic (rate-limited, once per event).
  - On battery with SOC below the floor (or VCELL critically low) for two
    consecutive reads: `docker compose stop` (clean Postgres flush — the soak
    survives), then `shutdown -h now`.

Config via environment (see x1200.env.example):
  NTFY_TOPIC / NTFY_URL     ops alert channel (blank = log only)
  COMPOSE_DIR               the ORRERY checkout (docker-compose.yml location)
  SOC_SHUTDOWN_PCT          default 15
  VCELL_SHUTDOWN_V          default 3.0
  POLL_SEC                  default 10
  PLD_GPIO                  default 6

`--mock` walks a scripted AC-loss -> alert -> low-SOC -> (dry-run) shutdown
sequence with no hardware, printing every action, so the logic is testable on
the Mac before the Pi exists on the network.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Optional

I2C_ADDR = 0x36
REG_VCELL = 0x02
REG_SOC = 0x04

NTFY_TOPIC = os.environ.get("NTFY_TOPIC", "")
NTFY_URL = os.environ.get("NTFY_URL", "https://ntfy.sh").rstrip("/")
COMPOSE_DIR = os.environ.get("COMPOSE_DIR", "/home/pi/Project_Worldview")
SOC_SHUTDOWN_PCT = float(os.environ.get("SOC_SHUTDOWN_PCT", "15"))
VCELL_SHUTDOWN_V = float(os.environ.get("VCELL_SHUTDOWN_V", "3.0"))
POLL_SEC = float(os.environ.get("POLL_SEC", "10"))
PLD_GPIO = int(os.environ.get("PLD_GPIO", "6"))
STATUS_PATH = os.environ.get("STATUS_PATH", "/run/orrery-ups.json")


def log(msg: str) -> None:
    print(f"[x1200] {msg}", flush=True)


# ─────────────────────────── hardware access ───────────────────────────
class Gauge:
    """MAX17040 fuel gauge over smbus2. Word registers are big-endian."""

    def __init__(self) -> None:
        from smbus2 import SMBus

        self.bus = SMBus(1)

    def read_word(self, reg: int) -> int:
        raw = self.bus.read_word_data(I2C_ADDR, reg)
        return ((raw & 0xFF) << 8) | (raw >> 8)  # swap to big-endian

    def vcell(self) -> float:
        return (self.read_word(REG_VCELL) >> 4) * 1.25 / 1000.0  # 1.25mV/LSB after shift

    def soc(self) -> float:
        return self.read_word(REG_SOC) / 256.0


def _rp1_chip_path() -> str:
    """The 40-pin header GPIOs live on the RP1 ('pinctrl-rp1'). Its chip NUMBER
    moved between kernels (gpiochip4 on bookworm, gpiochip0 on trixie), so
    select by label, never by number."""
    import glob

    for sysdir in glob.glob("/sys/bus/gpio/devices/gpiochip*"):
        try:
            if "rp1" in open(f"{sysdir}/label").read():
                return "/dev/" + os.path.basename(sysdir)
        except OSError:
            continue
    return "/dev/gpiochip0"


class PldPin:
    """Power-loss detect: HIGH = external power present."""

    def __init__(self, gpio: int) -> None:
        import gpiod

        path = _rp1_chip_path()
        if hasattr(gpiod, "LineSettings"):  # gpiod v2
            from gpiod.line import Direction

            self.req = gpiod.request_lines(
                path,
                consumer="orrery-x1200",
                config={gpio: gpiod.LineSettings(direction=Direction.INPUT)},
            )
            self.gpio = gpio
            self.v2 = True
        else:  # gpiod v1
            chip = gpiod.Chip(path)
            self.line = chip.get_line(gpio)
            self.line.request(consumer="orrery-x1200", type=gpiod.LINE_REQ_DIR_IN)
            self.v2 = False

    def ac_present(self) -> bool:
        if self.v2:
            from gpiod.line import Value

            return self.req.get_value(self.gpio) == Value.ACTIVE
        return bool(self.line.get_value())


# ─────────────────────────── actions ───────────────────────────
def ntfy(title: str, body: str, priority: str = "default", dry: bool = False) -> None:
    if dry or not NTFY_TOPIC:
        log(f"NTFY[{priority}] {title}: {body}" + (" (dry)" if dry else " (no topic)"))
        return
    try:
        import urllib.request

        req = urllib.request.Request(
            f"{NTFY_URL}/{NTFY_TOPIC}",
            data=body.encode(),
            headers={"Title": title, "Priority": priority, "Tags": "electric_plug"},
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        log(f"ntfy failed: {e}")


def graceful_shutdown(dry: bool) -> None:
    log("LOW BATTERY — graceful shutdown: stopping the stack (clean Postgres flush)")
    if dry:
        log("(dry) docker compose stop && shutdown -h now")
        return
    subprocess.run(["docker", "compose", "stop"], cwd=COMPOSE_DIR, timeout=180)
    subprocess.run(["sudo", "shutdown", "-h", "now"])


def write_status(soc: Optional[float], vcell: Optional[float], ac: bool) -> None:
    try:
        tmp = STATUS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(
                {
                    "soc_pct": round(soc, 1) if soc is not None else None,
                    "vcell_v": round(vcell, 3) if vcell is not None else None,
                    "ac_present": ac,
                    "ts": int(time.time()),
                },
                f,
            )
        os.replace(tmp, STATUS_PATH)
    except OSError as e:
        log(f"status write failed: {e}")


# ─────────────────────────── control loop ───────────────────────────
@dataclass
class State:
    ac: bool = True
    low_strikes: int = 0


def step(state: State, soc: float, vcell: float, ac: bool, dry: bool = False) -> State:
    """One decision cycle: pure-ish (all side effects via ntfy/shutdown helpers)."""
    if state.ac and not ac:
        ntfy("ORRERY appliance on battery", f"External power lost. Battery {soc:.0f}% ({vcell:.2f}V).",
             priority="high", dry=dry)
    elif not state.ac and ac:
        ntfy("ORRERY appliance power restored", f"Back on external power. Battery {soc:.0f}%.", dry=dry)

    low = (soc <= SOC_SHUTDOWN_PCT) or (vcell <= VCELL_SHUTDOWN_V)
    strikes = state.low_strikes + 1 if (not ac and low) else 0
    if strikes >= 2:
        ntfy("ORRERY appliance shutting down", f"Battery {soc:.0f}% ({vcell:.2f}V) — stopping stack cleanly.",
             priority="urgent", dry=dry)
        graceful_shutdown(dry)
        strikes = 0  # unreachable on hardware; keeps the mock sequence going
    return State(ac=ac, low_strikes=strikes)


def run_hardware() -> None:
    gauge = Gauge()
    pld = PldPin(PLD_GPIO)
    state = State(ac=pld.ac_present())
    log(f"monitoring: SOC floor {SOC_SHUTDOWN_PCT}%, VCELL floor {VCELL_SHUTDOWN_V}V, PLD GPIO{PLD_GPIO}")
    while True:
        try:
            soc, vcell, ac = gauge.soc(), gauge.vcell(), pld.ac_present()
            write_status(soc, vcell, ac)
            state = step(state, soc, vcell, ac)
        except Exception as e:
            log(f"cycle failed: {e}")
        time.sleep(POLL_SEC)


def run_mock() -> None:
    """Scripted drill: nominal → AC loss → drain → low-SOC shutdown → restore."""
    global STATUS_PATH
    STATUS_PATH = "/tmp/orrery-ups.json"
    seq = [
        (95.0, 4.05, True),   # nominal on AC
        (95.0, 4.05, False),  # plug pulled → "on battery" alert
        (60.0, 3.75, False),
        (20.0, 3.35, False),
        (14.0, 3.20, False),  # below floor, strike 1
        (12.0, 3.15, False),  # strike 2 → shutdown (dry)
        (11.0, 3.12, True),   # power restored → all-clear alert
    ]
    state = State(ac=True)
    for soc, vcell, ac in seq:
        log(f"mock read: SOC {soc}% VCELL {vcell}V AC {'yes' if ac else 'NO'} (strikes={state.low_strikes})")
        write_status(soc, vcell, ac)
        state = step(state, soc, vcell, ac, dry=True)
    print(open(STATUS_PATH).read())
    log("mock drill complete")


if __name__ == "__main__":
    if "--mock" in sys.argv:
        run_mock()
    else:
        run_hardware()
