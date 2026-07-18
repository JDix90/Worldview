# ORRERY — Phases

Phase 1 is chunked so each chunk is independently implementable and has a definition of done. Chunks are ordered by dependency; 2 and 3 can interleave with 1 once the scaffold exists.

---

## Phase 1 — Flights (the vertical slice)

### Chunk 0 — Scaffold & infrastructure ✅ (this session)
Repo, workspace, Docker Compose (Postgres + Redis), foundation documents.
**Done when:** `docker compose up -d` yields healthy Postgres + Redis; `pnpm install` resolves; `pnpm -r typecheck` passes; FOUNDATION/DECISIONS/PHASES exist.

### Chunk 1 — The globe (feel first) — built 2026-07-14; ✅ owner feel sign-off 2026-07-15 ("the globe's feel is great") — gate closed
react-globe.gl scene in `apps/web`, transplanting Borderfall's interaction tuning (FOUNDATION §10): auto-rotate 0.4 with pause/resume, damped orbit, distance-scaled zoom. Vendored NASA day/night/bump textures. Day/night terminator as a custom shader on `globeMaterial()`, blending by computed solar position. No data on the globe yet.
**Done when:** the owner says it feels identical to Borderfall's globe (hard gate — nothing renders on it before this passes); terminator position matches the real sun to within ~1°; 60fps on the dev machine with 12k dummy instanced markers.

### Chunk 2 — Collector — built and fully verified 2026-07-15 on the registered OpenSky tier (credential reset resolved the 401s); ⏳ 24h unattended soak running from 2026-07-15 22:24Z
`SourceAdapter` interface in `packages/shared`. OpenSky adapter: OAuth2 client-credentials with 30-min token refresh, global `/states/all` every 90s → Redis hot state. adsb.fi adapter: squawk polls (3/min) + watch-region integrity sweep. Raw JSONL writer with 48h TTL job. Credit-budget accounting logged. All as BullMQ repeatable jobs in `apps/worker`.
**Done when:** 24h unattended run with zero unhandled rejections; OpenSky credits consumed ≤ 4,000/day by its own accounting; Redis hot state never staler than 2× poll cadence; raw JSONL rotating and TTL-cleaning; adsb.fi request rate provably < 1/s.

### Chunk 3 — Live globe — built and verified 2026-07-15 (auth, snapshot/delta stream, 9k+ aircraft at ~3.3ms/frame, selection, reconnect+recovery); ⏳ motion-smoothness eyeball check is the owner's, on real hardware
Fastify server: static-token auth, one WebSocket pushing hot-state deltas. Client renders aircraft as heading-oriented instanced markers with dead reckoning between polls (velocity + track). Click → aircraft card (callsign, altitude, speed, origin country, squawk). Forgiving click targets.
**Done when:** aircraft move smoothly (no 90s teleporting); selection works at all zoom levels; WS auto-reconnects and recovers state; renders the real global picture (~8–12k aircraft) at 60fps.

### Chunk 4 — Rollups & baselines — built and verified 2026-07-15 (buckets across restarts, exact median/MAD + maturity ladder via synthetic checks, API live, busiest-cells spot-check sane); baselines now warming toward the 28-day window
Grid-cell density rollups (5-min) from hot state → Postgres. Baseline job: median/MAD per cell × hour × daytype over rolling 28 days, with maturity states (warmup/partial/mature). Small internal API to query a cell's baseline.
**Done when:** rollups accumulate across restarts; baseline query returns stats + maturity for any cell; maturity transitions provably follow data volume; a spot-check of ~5 known-busy cells looks sane against reality.

### Chunk 5 — Detectors & Signals — COMPLETE 2026-07-16: D0+D2 built 2026-07-15 (live-calibrated same night, DECISIONS #42); D1+D3 built 2026-07-16 with the replay harness passing all 14 scenarios against recorded raw data (every DoD bullet: injected collapse → D1 S2→S1; injected coverage drop → D0 fires, D1 suppressed; same-observation ≠ persistence; injected low-NIC cluster → D3 S2; cap demotes with audit). D1/D3 are live but self-gated: D1 until density baselines reach partial (~Jul 20), D3 until 3 days of integrity history (~Jul 19). — first half built and verified 2026-07-15: Signal schema/emitter (dedupe latch, S1 cap with demotion audit), D0 data-health v1, D2 squawks — 17 pure checks passing, live 7600 signals caught on deploy day; ⏳ remaining: D1 traffic collapse + D3 GPS interference (gated on baseline maturity ≥ partial, ~5 days out) + the raw-JSONL replay harness
`Signal` schema in `packages/shared` (FOUNDATION §6). Detectors D0–D3 (FOUNDATION §7) as post-poll pipeline steps: data-health guard, traffic collapse, emergency squawks, GPS interference. Dedupe keys, severity assignment, S1 24h cap with first-fired-wins demotion. Signals → Postgres + Redis stream.
**Done when:** a replay harness can run detectors against recorded raw JSONL with injected anomalies, and: injected regional collapse fires D1; injected coverage drop fires D0 and does **not** fire D1; persistent 7500 fires S1 candidate while a single-poll 7500 does not; injected low-NIC cluster in a watch region fires D3; the S1 cap demotes correctly with `demoted_from` set.

### Chunk 6 — Analyst, briefing, feed — built 2026-07-16; verified LIVE same night: real Haiku triage with 2 web searches and citation-derived sources (Baltic GPS signal → "explained", $0.045), Sonnet briefing voice passing on both real quiet-ish data and a synthetic busy day ($0.018 each), and the shadow log capturing its first REAL S1 (RPA4359, persistent 7500 at 01:36Z, untriaged path, pushed=false). ⏳ remaining: 7 consecutive unattended daily briefings — clock starts 2026-07-16 07:00 America/Denver
Haiku triage on S1/S2 fire (web check ≤10/day, Assessment output). Sonnet daily briefing at 07:00 America/Denver implementing the voice spec (FOUNDATION §9), warm-up disclaimers included; Sunday edition appends the shadow S1 log. ntfy.sh wiring present but **push disabled — shadow mode**. Feed panel in the client: S2 badges, briefing view. Cost telemetry + monthly circuit breaker.
**Done when:** 7 consecutive daily briefings generated unattended; a fired signal produces an Assessment with only-actually-consulted sources; shadow S1 log captures full signal + analyst context; token spend telemetry visible and under target; the voice reads like FOUNDATION §9 on both a quiet day ("nothing of note") and a synthetic busy day.

### Chunk 7 — Calibration soak & gate
14-day live soak, shadow mode throughout (≥7 days minimum before any push enablement). Owner reviews the shadow log weekly. Then the Go/No-Go questions (FOUNDATION §11) get answered honestly.
**Done when:** the gate has a written yes/no per question in DECISIONS.md, and push is enabled only if the shadow log earned it.

---

## Phase 1.5 — Globe furniture (built 2026-07-16, during baseline warm-up)

Render-only layers behind a client layer registry ([registry.ts](apps/web/src/layers/registry.ts), toggles in LayersPanel, localStorage persistence, centralized picking). No Signals, no Stage 2–4 involvement — see FOUNDATION §5 amendment and DECISIONS #46–51.

| Layer | Source | Status |
|---|---|---|
| Satellites (curated ~400) | CelesTrak GP, SGP4 in Web Worker | ✅ ISS validated to 0.03°; GNSS + GEO shells at correct radii |
| Starlink shell (~9k, off-default) | CelesTrak | ✅ renders; 1.43ms/frame with everything on |
| Earthquakes | USGS 2.5_day GeoJSON | ✅ 56 events, magnitude-scaled pulses, cards |
| Aurora | NOAA SWPC OVATION | ✅ night-side polar glow, correct hemisphere placement |
| Military air | adsb.fi /v2/mil via collector→WS | ✅ ~130–140 airborne, distinct markers, registry cards |
| GPS jamming | own integrity sweeps via /api/integrity/now | ✅ region discs tint with live NIC fractions |

**Done when:** all layers toggle cleanly and render within perf budget (✅ measured); cards open from clicks (✅ satellite + quake verified); owner re-verifies zoom feel at the 720 ceiling (✅ 2026-07-16 — "works and feels natural"). **Phase 1.5 complete.**

## Phase 1.5b — Second furniture wave (2026-07-16, during soak; DECISIONS #55–59)

| Layer | Source / path | Status |
|---|---|---|
| A1 Cyclones | NHC via server proxy `/api/proxy/storms` | ✅ verified live — Elida (TS, 55kt, 995mb) card matches NHC |
| A2 Wildfires | FIRMS VIIRS, client-direct + proxy fallback | ⏳ code complete, **blocked on owner's `FIRMS_MAP_KEY`** |
| A3 Launches | Launch Library 2, client-direct | ✅ verified live — Starship Flight 13 card + T-minus correct |
| A4 Sun & Moon | pure ephemeris (solar.ts + lunar.ts) | ✅ verified — markers placed correctly, `verify:lunar` passes |
| B1 Aerosol/smoke | NASA GIBS AOD via WMS GetMap (one global image) | ✅ verified live — smoke-grey haze veils over the fire fields |
| C Wind particles | Open-Meteo JSON (GFS-derived; GRIB2 template 5.3 avoided) | ✅ verified — flowing North Pacific streamlines, physics correct |

**Perf:** 1.41 ms/frame typical with all layers on (wind, fires, aerosol, satellites, …); 4.24 ms worst-case zoomed into the fire overdraw — both under the 5 ms budget. **Phase 1.5b complete: all six second-wave layers built and verified.** Owner eyeball pass on the composite is the remaining courtesy gate.

## Phase 1.5c — UX polish from living with it (2026-07-16, DECISIONS #65–67)

Owner feedback after the composite shipped: spin frustration, flight clutter, close-zoom blur.

| Item | What shipped | Status |
|---|---|---|
| SPIN pause chip | persisted pref; drag-resume can't override a manual pause | ✅ verified incl. timer race |
| CIVIL AIR toggle | flag-only LayerDef; store purge/smoothing continue while hidden | ✅ verified on/off/persist |
| 8K textures | NASA Blue Marble NG + Black Marble 2016 + GEBCO topo; shader texel/anisotropy made resolution-independent | ✅ zoom floor crisp (Sierra Nevada test) |
| BORDERS layer | Natural Earth 50m vector hairlines, slerp-subdivided, distance-faded | ✅ verified incl. antimeridian |
| Aerosol close-zoom fade | AOD veil fades out under camDist ~210 | ✅ verified over Siberia |

Perf all-on at the fire worst case: 3.1 ms — under the 5 ms gate.

## Phase 1.5d — Detail-card clarity (2026-07-17, DECISIONS #68–70)

Owner: the click cards were "unintelligible to the average viewer". Every card now leads with a plain-language `note`, uses full-word labels, relative+UTC times, dual kt·mph speeds, and hemisphere coordinates (shared `format.ts`). Surfaced already-fetched-but-dropped fields (LL2 mission/status/orbit, USGS felt/alert/tsunami, TLE inclination). Military cards enriched with adsb.fi `desc`/`ownOp` (worker rebuilt, soak intact) → "Boeing C-17A Globemaster III"; civil cards get an airline name from a curated ICAO-prefix map. Verified live: civil, military, sun, and launch cards. **Phase 1.5d complete.**

## Phase 1.5e — Flight route + path (2026-07-17, DECISIONS #71–72)

Civil aircraft cards now show FROM/TO airports (adsbdb callsign lookup, client-direct, cached) and a SHOW/HIDE FLIGHT PATH button that draws the great-circle route (departure→aircraft→destination) as a visible tube with airport dots. The old registration-country row was relabeled REGISTRY. Verified live: ACA844 Montréal→Frankfurt. Client-only, soak untouched. **Phase 1.5e complete.**

## Phase 1.5f — The ocean (2026-07-17, DECISIONS #73–75)

| Layer | Source / path | Status |
|---|---|---|
| M1 Shipping lanes | World Bank AIS density → one-time GDAL bake → 7MB vendored PNG drape | ✅ verified — Malacca/Singapore corridors blaze, geographically aligned with borders |
| M2 Ocean currents | Open-Meteo Marine (10° grid, km/h + flowing-TOWARD conventions verified) | ✅ verified — field byte-faithful to source; streamline cadence designed for 60fps displays |
| M3 Live vessels | aisstream.io WebSocket (global AIS) | ⏳ code complete (worker + renderer + card, no-key idle verified); **live stream verification awaits owner's free AISSTREAM_KEY in .env** |

Perf: lanes+currents cost below measurement noise (delta A/B — see #75 on in-pane absolute numbers).

## Phase 1.5g — Edge hardware (2026-07-17, DECISIONS #77–79; docs/EDGE.md)

Assessment + build in response to "Pi Zero 2 W handheld or Pi 5?". Verdicts: globe **cannot** run on the Zero 2 W (RAM); the handheld is the **duty-officer pager**; the Pi 5 is the **appliance backend** (ends Mac/Docker soak fragility).

| Deliverable | What shipped | Status |
|---|---|---|
| EDGE.md assessment | Role-by-role analysis, arm64 verification, BOM, non-goals | ✅ |
| Pi 5 appliance prep | Compose LAN bind + web proxy target parametrized (Mac default unchanged); RUNBOOK-PI5.md with soak-preserving `pg_dump` migration | ✅ prepped (build when hardware arrives) |
| Zero 2 W pager | `GET /api/pager/summary` (~1.8KB, authed, four-stage-clean) + `edge/pager/` Python client (5 pages, 1-button, RGB LED); all pages verified off-device via PNG render | ✅ code complete (on-device bring-up when handheld is connected) |

## Phase 1.5h — Pi 5 appliance build (2026-07-17, DECISIONS #80–81)

Hardware on hand: Pi 5 + cooler + X1200 UPS (2×18650) + MHS-3.5" (480×320). Zero 2 W shelved; the panel takes the pager role.

| Step | What | Status |
|---|---|---|
| H0 Mac-side | 480×320 landscape renderer + fb/touch backends (PNG-verified live); X1200 monitor (mock drill passes); nightly-dump timer; runbook §A–§D | ✅ |
| H1 Flash | Pi OS **trixie** Lite 64-bit; WiFi needed a cloud-init re-arm + **5 GHz band pin** (display SPI desenses 2.4 GHz — DECISIONS #83) | ✅ 2026-07-17 |
| H2 Migration | 5-second cutover, 1 bucket lost (within standard); stack self-heals on boot; Mac retired to viewer; OPS alerts on | ✅ — soak clock intact |
| H3 Display | fb0 @ 480×320 live dashboard; touch electrically marginal → **carousel mode** (15s auto-cycle); verified by fb readback | ✅ |
| H4 UPS drill | Monitor live (gauge + PLD + status file); **drill deferred until cells charge** (arrived at 0%) | ⏳ owner runs when SOC > 50% |

## Phase 1.5i — Living planet + world events (2026-07-18, DECISIONS #89–91)

| Layer | Source | Status |
|---|---|---|
| CLOUDS | GIBS MODIS true-color, cloud-keyed + terminator-faded | ✅ verified (Pacific storm systems; seam fixed via yesterday-first) |
| WORLD EVENTS | GDACS client-direct, scoped to FL/VO/DR + non-NHC TCs | ✅ verified (53 events; East Africa drought card) |
| SST / snow | GIBS | ❌ deferred on evidence — L2 SST 21.9% swath coverage, NDSI 0.8% |
| Analyst world-context | GDACS → triage/briefing prompts | ⏸ deferred until the flights Go/No-Go gate closes (DECISIONS #89; briefing seam first when built) |

Perf: 2.77 ms/frame, 18 layers. Both deployed to the appliance.

## Phases 2+ — sketches only (one paragraph each, contingent on the gate)

**Phase 2 — Second layer.** Add one more collector through the existing seams — candidate chosen *at the time* by what Phase 1 taught us (likely candidates: earthquakes/USGS for its clean feed, or weather overlay for globe beauty; but the gate review decides). The test of the architecture: a new source should be an adapter, a baseline config, and detectors — no changes to stages' contracts. Real NOTAM integration for the analyst belongs here if the traffic-collapse detector proved useful.

**Phase 3 — Analyst depth.** Cross-layer correlation (the actual reason an LLM is in the loop), longer analyst memory of past signals and their resolutions ("this corridor does this every Ramadan"), and briefing continuity so the duty officer remembers last week. Only worth building once two layers exist and shadow logs prove single-layer judgment is sound.

**Phase 4 — Off the desk.** A dedicated small droplet (never the existing one), friends' access via shared token or trivially simple accounts, ntfy topics per person. Explicitly last: the instrument must earn daily use by its owner on a desk before it earns a server bill.
