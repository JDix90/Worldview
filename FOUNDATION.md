# ORRERY — Foundation

**Status: canonical.** This document is the source of truth. Architectural decisions recorded here are not re-litigated without explicitly amending this file (and logging the amendment in [DECISIONS.md](DECISIONS.md)). Last amended: 2026-07-13.

---

## 1. What this is

A personal instrument: a 3D globe rendering live world conditions from public data feeds, watched by an AI analyst that reports anomalies in plain language. Built for one person, maybe a handful of friends.

**Goals**
- Signal quality over coverage. One trustworthy detector beats five noisy ones.
- Low operating cost. Target: pennies per day for the analyst, $0 for data.
- Something worth opening daily, unprompted. The Go/No-Go gate (§10) measures exactly this.
- A globe that feels good before it does anything else.

**Non-goals**
- Not a product. No scale, no SEO, no onboarding, no public polish, no anonymous users. If a design choice is optimizing for someone who isn't the owner or a friend, it is wrong.
- No street-level mapping. Zoom floor is country/region. High-res Earth texture + night lights + bump map; no tile streaming, ever.
- No mobile push infrastructure. ntfy.sh only.
- No deployment to the existing DigitalOcean droplet. It hosts an unrelated project pending launch. A dedicated droplet is a later decision, not a now decision.

---

## 2. Architecture — four stages, strictly separated

The core insight: **an LLM cannot detect anomalies by staring at raw coordinates.** Each stage distills, so the model only ever sees small, structured, already-suspicious inputs. Do not collapse these stages. The separation is the whole design.

```
 public APIs ──▶ [1 COLLECTOR] ──▶ Redis hot state ──▶ WS ──▶ globe
    (code)            │
                      ├──▶ raw JSONL (48h, debug only)
                      └──▶ Postgres rollups
                                │
                      [2 BASELINE] (code)
                       rolling stats per cell × hour × daytype
                                │
                      [3 DETECTOR] (code, no AI)
                       threshold/delta checks each poll cycle
                                │
                          Signal events (small, structured)
                                │
                      [4 ANALYST] (LLM)
                       correlation + narrative + web check
                                │
                    briefing / feed / shadow S1 log
```

**Stage 1 — Collector (code).** Polls public APIs at their natural cadence via BullMQ repeatable jobs. Writes hot state to Redis (what the globe renders), rollups to Postgres (what baselines are computed from), and raw poll snapshots to compressed JSONL on disk (48h TTL, debugging only — deletable machinery). Sources sit behind a `SourceAdapter` interface so a source swap is config, not a rewrite.

**Stage 2 — Baseline (code).** Rolling statistics per grid cell per hour-of-day per day-type (weekday/weekend), using **median/MAD over a rolling 28-day window** — not mean/σ; one holiday shreds a mean. Every baseline bin carries a maturity state derived from the *fraction of theoretically available days* it has observed (20 weekdays / 8 weekend days fit in 28): `warmup` (< 25%) → `partial` (< 75%) → `mature` (≥ 75%) — fractions, not absolute day counts, so weekend bins aren't stuck in permanent warmup (amended 2026-07-15, DECISIONS #33). Detectors and the analyst must surface maturity honestly rather than fabricate confidence. Without baselines, "anomaly" is a meaningless word: no baseline-dependent detector runs before its baseline exists.

**Stage 3 — Detector (code, no AI).** Cheap deterministic checks on each poll cycle. Emits Signal events (§6) — never raw data. Severity is assigned here, deterministically and auditably. Includes a **data-health guard** (§7, detector D0): the dominant failure mode of receiver-network data is receivers going away, not the world changing, and the detectors must know the difference.

**Stage 4 — Analyst (LLM).** Consumes Signals plus compact context. Does correlation and narrative — the thing thresholds cannot do. May web-search to check whether news explains a signal, converting "weird datapoint" into "explained" or "genuinely unexplained, flag it." Runs only when S1/S2 signals fire, plus one scheduled daily briefing. May **downgrade** a signal's severity, never upgrade. Cost controls in §8.

**Data stores:** Redis = current world state + signal stream + queues. Postgres = rollups, baselines, signals, assessments, briefings. Disk = 48h raw JSONL. Nothing else is durable.

---

## 3. Data sources (verified 2026-07-13)

Findings from checking current docs and making live test calls — not remembered API shapes:

| | OpenSky | adsb.fi | ADS-B Exchange |
|---|---|---|---|
| Auth | OAuth2 client-credentials only (basic auth removed; tokens expire 30 min) | none (public tier) | RapidAPI key |
| Cost | free, credit-based: 400/day anon, 4,000 registered, 8,000 feeder | free | ~$10/mo or feeder-gated |
| Global snapshot | `/states/all` = 4 credits → ~1 per 90s on registered tier | `/v2/snapshot` (30s refresh) — **feeder-only** | feeder/paid only |
| Nav-integrity fields (NIC/NACp/SIL) | **absent** | **present** (ADSBx v2 format, confirmed live) | present |
| Targeted queries | bbox (cheaper credits) | `/v2/sqk/{code}`, `/v2/mil`, point-radius ≤250 NM @ 1 req/s | similar |
| Terms | non-commercial ok | personal non-commercial, attribution required | non-commercial |

**Decision: hybrid.**
- **OpenSky (registered, free)** — primary for the global picture: rendering, density rollups, baselines, traffic-collapse detection. One global `/states/all` every **90s** (~960 calls/day against a 1,000-call budget). 18-field state vectors include position, velocity, true track, squawk.
- **adsb.fi (public tier)** — the sharp-edged detectors: squawk polling (`7500`/`7600`/`7700`, 3 calls/min) and navigation-integrity sampling over the GPS watch regions (§7), well inside the 1 req/s limit. Attribution to adsb.fi in the UI footer.
- **ADS-B Exchange** — not used. Adds nothing over adsb.fi at this scale unless paying or feeding.
- **airplanes.live** — documented fallback mirror for adsb.fi (same v2 format, 1 req/s, currently no feeder gate). Not wired up unless adsb.fi becomes unavailable.

**Feeder upgrade path (optional, standing offer):** hosting an ADS-B receiver (~$40 RTL-SDR) unlocks adsb.fi's 30-second global snapshot *with* integrity fields — at which point adsb.fi becomes primary and OpenSky the fallback, via config change on the adapter seam. Also raises OpenSky to 8,000 credits/day. Not a Phase 1 dependency.

**Client rendering consequence:** at 90s cadence the client dead-reckons aircraft between polls using velocity + track. This is a feature of the design, not a workaround.

---

## 4. Severity model

Three tiers. **Assigned by the detector — deterministic, auditable. The analyst may downgrade, never upgrade.**

| Tier | Behavior | Bar |
|---|---|---|
| **S1 — PUSH** | Interrupts the owner (ntfy.sh) | Rare, high-confidence, materially significant. Expected < 1/week. |
| **S2 — FEED** | In-app feed with badge | Notable deviation. Looked at when wanted. |
| **S3 — DIGEST** | Daily briefing only | Low-salience curiosity. Never badged, never pushed. |

**Hard rate limit:** 3 S1 pushes per rolling 24h. First-fired keeps S1; anything after the cap demotes to S2 with `demoted_from: "S1"` recorded on the signal, and the next briefing explains the demotions. First-fired-wins because it is the only ordering that is auditable after the fact.

**Calibration gate:** push ships **disabled**. The system runs in shadow mode for a minimum of 7 days, logging every signal that *would* have pushed — full signal plus the context the analyst saw, so the review judges what would have actually arrived. Push is enabled only after the owner reviews the shadow log and finds it worth having been interrupted for. A system that cries wolf once is a system that stops being trusted.

**Push delivery:** ntfy.sh. The topic name is a generated 32-char random string and is treated as a credential (ntfy topics are public-by-obscurity). Discord webhook rejected as a second channel; one channel, done well.

---

## 5. Phase 1 scope — FLIGHTS ONLY

Hard boundary. **No satellites, no weather, no earthquakes, no air quality — regardless of how easy they look.** Those are Phase 2+, and only if Phase 1 passes the gate (§10). Phase 1 is a complete vertical slice through all four stages for the single flights source; chunks and definitions of done live in [PHASES.md](PHASES.md).

Build the seams for more collectors (the `SourceAdapter` interface, the `source` field on Signals) but no plumbing for collectors that may never exist.

---

## 6. Signal schema

The only thing Stage 3 is allowed to emit, and the only operational data Stage 4 is allowed to see. Canonical TypeScript lives in [`packages/shared/src/signal.ts`](packages/shared/src/signal.ts); this section is the specification.

```ts
interface Signal {
  id: string;                        // ULID
  ts: string;                        // ISO 8601 UTC, emission time
  source: 'flights';                 // Phase 1: only value; the Phase 2 seam
  detector: 'data_health' | 'traffic_collapse' | 'emergency_squawk' | 'gps_interference';
  severity: 'S1' | 'S2' | 'S3';      // detector-assigned; analyst may only lower
  demoted_from?: 'S1';               // set when the 24h push cap forced demotion

  what: string;                      // one plain-language sentence, machine-generated
  where: {
    region: string;                  // human name, e.g. "Baltic — Kaliningrad corridor"
    lat: number; lon: number;        // representative center
    radius_km?: number;
    cells?: string[];                // affected grid cell ids
  };
  magnitude: {
    metric: string;                  // e.g. "aircraft_count", "low_nic_fraction"
    observed: number;
    baseline: number;                // median for this cell × hour × daytype
    deviation: number;               // (observed − baseline) / MAD, sign preserved
  };
  confidence: number;                // 0–1, per-detector deterministic formula
  baseline_maturity: 'warmup' | 'partial' | 'mature' | 'n/a';  // n/a: baseline-free detectors
  data_health: {
    coverage_ok: boolean;            // false ⇒ detectors must not claim real-world cause
    global_count_delta_pct: number;  // global aircraft count vs 1h ago
  };
  evidence: {
    window_start: string; window_end: string;
    aircraft_count?: number;
    sample_hexes?: string[];         // ≤ 5 ICAO24 hexes, for manual lookup — never full dumps
  };
  dedupe_key: string;                // detector + region + condition; suppresses repeats while a condition persists
}
```

The analyst's structured output is an `Assessment`: `{ signal_id, disposition: 'explained' | 'unexplained' | 'noise', severity_final (≤ severity), narrative, sources_consulted: string[], confidence: number }`.

---

## 7. Phase 1 detectors

**D0 — data health (guard, runs first).** Compares global aircraft count and per-region receiver coverage against short-horizon history. On a correlated drop (global count falls with the region, or neighboring cells fall together), emits a single S3 `data_health` signal and **suppresses traffic-collapse evaluation** for affected cells that cycle. Receiver dropout is the #1 false-positive source for D1 and is treated as a first-class condition, not an edge case.

**D1 — regional traffic collapse.** Density per cell vs baseline (median/MAD, cell × hour × daytype). Requires `data_health.coverage_ok` and baseline maturity ≥ `partial`. Severity by deviation magnitude and persistence across consecutive cycles.

**D2 — emergency squawks** (baseline-free; runs from day one).
- `7500` (hijack) → **S1 candidate** only after persisting 2+ consecutive polls (~2–3 min latency accepted — fat-fingered transponders outnumber hijackings).
- `7700` (general emergency) → **S3**; promoted to **S2** only when clustered: 2+ aircraft, same region, within ~30 min — that's when it stops being a routine medical diversion.
- `7600` (radio failure) → **S3**.

**D3 — GPS interference.** Fraction of aircraft with degraded nav integrity (low NIC / large RC) per **watch region**, vs that region's own baseline. Phase 1 watch regions (config, not code): **Baltic/Kaliningrad, Black Sea, eastern Mediterranean, Persian Gulf** — chosen because interference there is chronic and documented, so the detector calibrates against real signal. Global GPS coverage requires the feeder upgrade path (§3); until then this detector is honest about being a watchlist, not a world sweep.

---

## 8. Analyst

**Models:** Claude API. Haiku (current generation) for signal triage — classification over tiny structured inputs. Sonnet (current generation) for the daily briefing — the voice is the product; prose quality is worth it.

**Runs:** on S1/S2 signal fire (triage, possible web check), and once daily at **07:00 America/Denver** (the briefing — night watch handing over at dawn, after Europe/Asia's busy hours). During shadow mode, the **Sunday** briefing appends the week's would-have-pushed S1 log for calibration review.

**Cost controls (in code, not intentions):** ≤ 10 web searches/day, spent only on S1/S2 — never digest filler. Monthly token-spend circuit breaker; on trip, degrade to "briefing unavailable — spend cap," never a surprise invoice. Target: pennies per day (realistically $2–4/month).

**Honesty rule:** the analyst names only sources it actually consulted. It has web search; it does **not** have NOTAM access in Phase 1 and must never claim a NOTAM check. "No public reporting found" is what web search truthfully supports. Real NOTAM integration is a named Phase 2+ item.

---

## 9. The voice

The briefing's editorial voice is a **night-watch duty officer**: laconic, dry, unhurried, faintly wry. It has seen a lot of quiet nights and is not impressed by much.

Rules:
1. Leads with what changed, then what it might mean, then what it explicitly does not know.
2. Never breathless. Never "BREAKING." Never speculation dressed as fact. No siren emojis.
3. Explicitly distinguishes **observed** (the data says) / **inferred** (this pattern usually means) / **unknown** (no explanation found).
4. Says "nothing of note" often and without apology. A briefing that manufactures interest every day is a briefing that stops being read.
5. Confidence is stated, not implied.
6. Names only sources actually consulted (§8).
7. During baseline warm-up, says so plainly rather than dressing thin statistics as findings.

Bad: "🚨 MAJOR ANOMALY DETECTED — airspace activity plummets in dramatic development!"

Good: "Commercial traffic over the eastern corridor thinned by roughly 40% against baseline around 03:00Z and hasn't recovered. No public reporting I can find accounts for it. Could be weather routing. Could be nothing. Worth a second look tonight."

---

## 10. Globe feel specification

The globe must feel good before it does anything else. **The reference implementation is Borderfall's `frontend/src/components/game/GlobeMap.tsx`** (local: `~/Downloads/borderfall`, remote: `JDix90/EmpireCities`) — which is **react-globe.gl**, so ORRERY uses react-globe.gl too (pinned to Borderfall's versions: `react-globe.gl ^2.37.0`, `three ^0.183.2`). Porting to raw Three.js was considered and rejected: the feel being preserved *is* globe.gl's control tuning, and re-deriving it is exactly the work the brief forbids. Direct access to camera/controls/scene is retained via globe.gl's `controls()` / `scene()` / `camera()` accessors — this access is a hard requirement.

Feel parameters transplanted from Borderfall:
- Inertial auto-rotation, `autoRotateSpeed = 0.4`.
- Auto-rotate pauses on the controls' own `start` event; resumes **2.5s** after `end`.
- Camera pans via `pointOfView(…, 800ms)`.
- globe.gl's distance-scaled rotate/zoom speeds provide the zoom curve that slows near the surface.

Phase 1 rendering (all custom, on top of the scaffold): day/night terminator via custom shader on `globeMaterial()` blending day texture and night-lights texture by computed solar position (the terminator is cheap and sells realism harder than anything else — Phase 1, not polish); aircraft as heading-oriented instanced markers with client-side dead reckoning; forgiving click targets.

Acceptance test for the port: the owner, hands on it, says it feels identical. Nothing renders on the globe until that passes.

---

## 11. Go/No-Go gate

After Phase 1 ships, the owner lives with it for 14 days. Then:
1. Did the analyst surface at least one thing genuinely informative that the owner would not otherwise have known?
2. Was it opened voluntarily on days when nothing pushed?
3. Was the shadow-mode S1 log something worth having been interrupted for?

Any "no" → ORRERY stops at one layer or stops entirely. Nothing in the codebase may presume this gate is passed.
