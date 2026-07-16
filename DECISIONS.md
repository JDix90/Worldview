# ORRERY — Decision log

Running log. Every non-obvious choice gets a line: what was decided, why, what was rejected. Newest entries at the bottom of each dated section. Reversals get a new entry, never an edit.

## 2026-07-13 — founding session

1. **Data source: hybrid.** OpenSky (registered, OAuth2) for the global picture at 90s cadence; adsb.fi public tier for squawk polling and nav-integrity watch regions. *Why:* verified live that OpenSky has no NIC/NACp/SIL fields and adsb.fi's global snapshot is feeder-gated — no single free source covers both the globe view and the GPS detector. *Rejected:* ADS-B Exchange (paid or feeder-gated, adds nothing over adsb.fi here); single-source designs (impossible without feeding).

2. **Feeder is an upgrade path, not a dependency.** Collector built behind a `SourceAdapter` seam; if the owner ever hosts a receiver, adsb.fi snapshot (30s, full fields) becomes primary via config. *Why:* don't couple the build schedule to hardware. *Rejected:* requiring a feeder before Phase 1.

3. **Globe: react-globe.gl, mirroring Borderfall — reversing the session's initial recommendation.** Initial recommendation was raw Three.js + ported controls, made on the assumption the Borderfall globe was hand-rolled. Reading the code showed it's react-globe.gl with specific interaction tuning (autoRotateSpeed 0.4, pause-on-start, 2.5s resume, 800ms pointOfView pans). The feel to preserve *is* globe.gl's tuning, so the shortest path to identical feel is the same library, same versions. *Rejected:* raw Three.js port (re-derives what globe.gl already provides); Cesium (founding brief, camera model).

4. **Squawk severity policy.** 7500 → S1 candidate only after 2+ consecutive polls (accepting ~2–3 min alert latency — fat-fingered transponders outnumber hijackings); 7700 → S3, promoted S2 only when clustered (2+ aircraft, one region, ~30 min); 7600 → S3. *Rejected:* all squawks S2 (the feed becomes a medical-diversion ticker and trust dies).

5. **Baselines: cell × hour-of-day × {weekday, weekend}, median/MAD, rolling 28 days.** *Why:* hour-only false-alarms every weekend; 7 distinct day-of-week bins are statistically thin at 2 weeks of history (2 samples/bin); pooling gives ~5–10. Median/MAD because one holiday shreds a mean. *Rejected:* hour-only; full day-of-week split; mean/σ.

6. **Data-health guard (D0) is a first-class detector.** Runs before D1; correlated coverage drops emit an S3 `data_health` signal and suppress traffic-collapse evaluation for affected cells. *Why:* receiver dropout is indistinguishable from regional traffic collapse per-region, and it's the #1 false-positive source for the flagship detector.

7. **GPS watch regions (config): Baltic/Kaliningrad, Black Sea, eastern Mediterranean, Persian Gulf.** *Why:* chronic, documented interference — real signal to calibrate against. Global sweep deferred to the feeder path.

8. **Push: ntfy.sh, single channel.** Topic = generated 32-char random string, treated as a credential. *Rejected:* Discord webhook (second channel, more setup); building both.

9. **Analyst: Haiku triage + Sonnet briefing (Claude API).** ≤10 web searches/day, S1/S2 only; monthly token circuit breaker that degrades to "briefing unavailable." Briefing 07:00 America/Denver; Sunday briefing appends the week's shadow S1 log. *Rejected:* one model for everything (Sonnet-for-triage wastes money, Haiku-for-briefing wastes the voice).

10. **Voice honesty rule.** Analyst names only sources actually consulted; never claims NOTAM checks (no NOTAM access exists in Phase 1). The founding brief's example phrase "No NOTAM I can find" is amended to "No public reporting I can find." *Why:* a duty officer claiming checks he can't perform is worse than one who doesn't mention them.

11. **"Baselines before detectors" amended to "baselines before baseline-dependent detectors."** D2 (squawks) is set-membership, needs no baseline, and runs from day one — giving the shadow log and analyst real material during warm-up. D1/D3 still wait for baseline maturity ≥ partial.

12. **S1 cap ordering: first-fired keeps S1; later signals demote with `demoted_from` recorded.** *Why:* the only ordering auditable after the fact. *Rejected:* highest-magnitude-wins (requires retroactively un-pushing).

13. **Workspace: pnpm@10.9.0, packages mirrored from Borderfall** (fastify ^4.27, bullmq ^5.73, ioredis ^5.3, pg ^8.11, react ^18.3, react-globe.gl ^2.37, three ^0.183.2, TS ^5.4, Vite ^5). Layout: `apps/web`, `apps/server` (Fastify + WS), `apps/worker` (all four pipeline stages as BullMQ processors), `packages/shared`. Server and worker are separate processes from day one so collector load never contends with the render path.

14. **Raw retention: 48h of compressed JSONL poll snapshots on disk** (not Postgres), TTL-cleaned by a worker job. *Why:* the only way to replay what a misfiring detector actually saw during calibration. Explicitly deletable machinery — remove after Go/No-Go if never used.

15. **Docker Compose host ports: Postgres 5435, Redis 6380** (env-overridable). *Why:* solo dev with multiple local stacks; 5432, 5433, and 5434 were all occupied on the dev machine at scaffold time.

16. **`@anthropic-ai/sdk` not added to the scaffold.** Pinned when the analyst chunk starts, to avoid shipping a stale pin months early.

## 2026-07-14 — chunk 1 (globe)

17. **Textures: three-globe's 4096×2048 NASA Blue Marble / night / topology set, vendored** into `apps/web/public/textures/` (~2.5 MB). *Why:* it's the exact imagery Borderfall renders, so the feel reference matches; NASA imagery, no license friction. 4k is adequate at the country/region zoom floor; a switch to NASA's 8k originals is a drop-in polish item if min-zoom looks soft. *Rejected:* hotlinking the CDN (violates local-first), 8k now (bigger repo for unproven need).

18. **Terminator: pure `THREE.ShaderMaterial` swapped in via globe.gl's `globeMaterial`**, day/night blend by `dot(normal, sunDir)` with a ~7°-of-arc twilight smoothstep, city-lights gain 2.1, faint warm band, and topology-derived relief via tangent-frame finite differences. Sun direction is computed with the NOAA low-precision solar algorithm ([solar.ts](apps/web/src/globe/solar.ts)) and mapped through the globe's own `getCoords()`, so the terminator cannot drift from the texture's coordinate convention. Verified against ephemeris references by `verify:solar` (9 checks, all within ~0.05°). *Rejected:* `onBeforeCompile` surgery on MeshPhongMaterial (brittle across three versions); scene-light-driven terminator (couples sun position to globe.gl's internal lighting).

19. **Zoom clamps: camera distance 115–480** (globe radius 100), i.e. altitude ~0.15–3.8. *Why:* enforces the country/region zoom floor from FOUNDATION §1 at the controls level, and 4k texture stays acceptable down to that floor.

20. **`window.__ORRERY__` dev handle** (globe instance) exposed on ready. *Why:* the embedded verification browser throttles requestAnimationFrame, so real render cost is measured by forced-render timing through this handle; also used to drive the camera in checks. Measured: 0.12 ms/frame bare globe, 0.65 ms/frame with 12,000 instanced markers (~25× headroom on the 60fps gate).

21. **Perf harness doubles as the aircraft-rendering prototype:** `?perf=<n>` adds n heading-oriented instanced cone markers ([perfMarkers.ts](apps/web/src/globe/perfMarkers.ts)) — the same InstancedMesh + tangent-frame-orientation approach chunk 3 will use for real aircraft.

## 2026-07-15 — chunk 2 (collector)

22. **Collector cadences:** OpenSky global 90s (~3,840 credits/day, self-accounted via a Redis daily counter rather than trusting response headers), squawks 60s, integrity sweeps 120s (6 tiles), raw TTL clean 15min. All BullMQ repeatable jobs on one `collector` queue, worker concurrency 2 so a slow OpenSky poll can't delay squawk polls.

23. **`OPENSKY_ALLOW_ANONYMOUS=1` escape hatch** — anonymous polling (400 credits/day) when credentials are absent or rejected, clearly logged. *Why:* the owner's first credentials were rejected by OpenSky (`unauthorized_client`, verified against both OAuth styles); the collector should degrade loudly, not block. Anonymous exhausts its budget in ~2.5h at the 90s cadence — test-only, never steady state.

24. **adsb.fi point-radius queries use the `/v3/lat/…/lon/…/dist/…` path** — it's the documented endpoint, and the legacy `/v2/lat/…` form returns empty responses (verified live). All adsb.fi calls serialize through a shared gate with a 1.2s minimum gap — a deliberate 20% margin under their 1 req/s limit (measured: 2 calls = 2,230ms).

25. **ioredis pinned to one version via pnpm override.** BullMQ's lockfile copy (5.10.1) and our direct dep (5.11.1) had incompatible nominal types (`protected` member clash). *Rejected:* casting at the `connection:` boundary (hides real version skew).

## 2026-07-15 — chunk 3 (live globe)

26. **WS protocol: one socket, three frame types (`snapshot`/`delta`/`meta`), types in `packages/shared/src/ws.ts`.** Deltas are changed-field diffs (a re-polled parked aircraft sends nothing; a squawk-only change always propagates). The server detects new polls by polling one Redis hash field every 3s rather than pub/sub. *Why:* zero worker changes (the 24h soak keeps running), no subscription state to resync after a Redis hiccup, and 0–3s latency is invisible against a 90s collection cadence. *Rejected:* pub/sub (more moving parts for no user-visible gain).

27. **WS auth via `?token=` query param; token injected into the dev bundle by Vite `define` from the root `.env`.** Accepted trade-offs for a localhost single-user instrument (URL never leaves the machine, request logging off, bundle never served publicly). Bad token → close 1008. Server binds 127.0.0.1 only and refuses to start without a token. Revisit both at Phase 4.

28. **Client position model: dead reckoning + exponential correction blending.** Positions extrapolate from the last fix along velocity+track (capped at 300s), and the rendered position converges to the moving target at ~86%/s — a fresh poll bends the path instead of teleporting the marker. Removed aircraft get a 180s grace (OpenSky coverage flickers), hard-drop at 360s data age; ground traffic isn't rendered. *Rejected:* rendering raw poll positions (90s teleports), server-side interpolation (the client has the frame clock).

29. **Selection is nearest-projected-aircraft-within-18px, not a raycast.** Uniformly forgiving at every zoom (fixed pixel radius), with a silhouette-plane test so aircraft behind the globe can't be picked; 6px pointer-travel slop separates clicks from drags. *Rejected:* InstancedMesh raycasting (exact-hit precision is hostile at 10k-marker density).

30. **Instance matrices are hand-packed into the buffer** (tangent-frame basis + track rotation, no per-instance Object3D), with the lat/lng→world convention asserted against `globe.getCoords()` at mount so a globe.gl upgrade can't silently skew the layer. Measured: 3.28 ms/frame total (1.9 JS + 1.4 GPU) with 9,160 live aircraft — ~5× headroom on 60fps.

## 2026-07-15 — chunk 4 (rollups & baselines)

31. **Grid: fixed 5°×5° lat/lon cells, id'd by SW corner** (`N50E000`), in [grid.ts](packages/shared/src/grid.ts). *Why:* regional-scale detection needs stable cells and decent per-cell counts, not geometric elegance; ~334 cells carried traffic on the first live rollup; the polar area distortion sits where there is no traffic. *Rejected:* H3 (a WASM dependency for benefits detectors don't need yet — revisit if a detector ever needs sub-regional grain).

32. **Rollup semantics: absent, never zero.** If the hot snapshot is stale (>5 min) at rollup time, the bucket is skipped entirely — an absent bucket means "wasn't looking," a zero would mean "sky was empty" and poison baselines into false collapse alarms. `rollup_run` records one row per successful run as D0's ground truth. Retention 60 days (baseline window is 28).

33. **Maturity = fraction of theoretically available days per daytype** (20 weekdays / 8 weekend days per 28-day window): <25% warmup, <75% partial, ≥75% mature. **Amends FOUNDATION §2**, which had rough absolute thresholds ("<7 days") — absolutes would leave weekend bins in permanent warmup since only 8 weekend days can ever exist in the window.

34. **Baseline recompute is a full atomic replace** (DELETE + INSERT in one transaction on one dedicated client) every 6h, plus compute-at-boot when the table is empty. *Why:* stale bins for cells that stopped reporting must fall out, and `pg.Pool.query` transactions silently span different connections — transactions always get a dedicated client. Verified by 11 synthetic checks in [verifyBaselines.ts](apps/worker/scripts/verifyBaselines.ts) (exact median/MAD, maturity ladder both daytypes, rollback-clean).

## 2026-07-15 — always-on pipeline + chunk 5 first half (D0, D2, Signal infrastructure)

35. **Worker and server are Compose services** (`restart: unless-stopped`, shared Dockerfile, server port bound to loopback only). *Why:* the baseline warm-up needs uninterrupted collection, and `tsx watch` in a terminal dies with the terminal. The web client stays host-run — it's a viewer. Remote monitoring, if ever wanted, is Tailscale to the loopback services — never public exposure (FOUNDATION §1). Dev iteration: rebuild with `docker compose up -d --build worker server`, or stop a container and run the pnpm script on the host.

36. **Detect job runs every 60s. D0 v1 = snapshot staleness (>5 min) + correlated global count drop** (>30% below the last hour's median; requires ≥6 buckets of history and median ≥1000 — no verdicts from thin evidence). Its verdict is published to Redis (`health:coverage_ok`) for D1/D3 gating, and every emitted signal embeds the cycle's data-health. Regional receiver-loss correlation (neighbor cells) lands with D1, which is what it exists to protect.

37. **Emission mechanics:** per-condition Redis NX latch (30 min, refreshed while the condition persists) suppresses duplicate signals; S1 cap is a rolling-24h ZSET, first-fired keeps S1, later demote with `demoted_from` (pure `decideSeverity`, unit-checked). Signals persist to Postgres (jsonb payload + indexed columns) and to a capped Redis stream for the chunk 6 analyst. IDs are ULIDs (tiny in-house impl, no dep).

38. **D2 merges adsb.fi targeted squawk polls with an OpenSky snapshot scan** (union by hex, adsb.fi wins on conflict — fresher and richer; the snapshot catches aircraft outside adsb.fi coverage). Verified live within minutes of deploy: two real 7600s (UAL1845, AZU8747) emitted as S3 with correct regions, then dedupe-suppressed on subsequent cycles.

## 2026-07-16 — chunk 6 (analyst, briefing, feed)

39. **Analyst client: injectable transport behind a Postgres cost ledger.** Every call is priced (per-MTok table + $0.01/web-search) and recorded before the next is allowed; the monthly breaker degrades to "briefing unavailable — spend cap" without calling the API. `sources_consulted` is extracted **by code from the response's citation blocks** — the §8 honesty rule is mechanical, not prompted. `severity_final` is clamped in code so the model cannot upgrade. Assessment output is a JSON fence parsed from text. *Rejected:* forced tool-choice for structure (interacts badly with server-side web search).

40. **Briefing: BullMQ cron with `tz: America/Denver`** (duty officer keeps local dawn through DST). Input assembly is pure code — the model sees a compact structured summary, never raw data. No web search in briefings (searches are S1/S2 triage budget only, ≤10/day via Redis daily counter, ≤3 per triage). Sunday edition appends the week's shadow log for calibration review. One row per local date, UPSERT.

41. **Two independent push gates:** `PUSH_ENABLED` (anomaly push — ships false, the FOUNDATION §4 calibration gate) and `OPS_ALERTS_ENABLED` (infrastructure alerts like "collector silent 30 min" — health, not anomaly judgment, so separately opt-in). **The shadow log is written even when the analyst is unavailable** — no analyst means no downgrade, so the S1 stands and must be reviewable; found as a gap when the first S1s fired with no API key configured.

42. **Deploy-day calibration find: two false 7500 S1s within 30 minutes.** Root cause: the detect job (60s) outpaces the OpenSky snapshot (90s), so two cycles could read the same observation and one transient 7500 counted as "persistent across 2 cycles." Fixed: persistence now counts strictly-advancing `seenAt` observations, and on-ground aircraft are excluded from D2 entirely (ramp transponder tests are the classic 7500 false positive). Regression checks added; the poisoned S1-cap state was cleared. The bogus S1 rows stay in the signal table as honest history.

## 2026-07-16 — chunk 5 completed (D1, D3, replay harness)

43. **D1 (traffic collapse): breach = drop ≥40% AND robust-z ≤ −3, persistent across ≥2 independent snapshots**, evaluated only for cells with baseline maturity ≥ partial and median ≥ 20 aircraft, and only when D0 says coverage is OK. MAD gets a Poisson-ish floor (`max(mad, √median, 1)`) so steady cells can't yield infinite z-scores. Coverage-not-OK **freezes** persistence counts rather than resetting them — a receiver blip must neither fire D1 nor erase legitimate progress. S1 escalation requires drop ≥60%, median ≥50, and 3+ observations. *Rejected:* percentage-only threshold (fires on quiet cells), evaluating during coverage incidents (the whole point of D0).

44. **D3 (GPS interference): per-region low-NIC fraction vs the region's own 14-day median** from the new `integrity_rollup` table (written by the sweep job — Stage 1 owns rollups). Fire threshold is the max of 2× the norm, norm + 15 points, and 25% absolute; ≥20 NIC-carrying aircraft required; <3 days of history → silent (warmup honesty); persistent across 2+ independent sweeps. **D3 never self-assigns S1 in Phase 1** — the Baltic idles at ~40-50% degraded, and until the calibration soak shows what "unusual for a jammed corridor" looks like, interference stays feed-tier. *Rejected:* absolute thresholds (scream constantly in the Baltic or never fire anywhere), density-style hour×daytype bins (4 regions × thin data; region-level norm suffices for v1).

45. **Replay harness ([replayDetectors.ts](apps/worker/scripts/replayDetectors.ts)) closes the chunk 5 DoD** by running the pure detectors against *recorded* raw files from `data/raw/` with injected anomalies — 14 scenarios covering every DoD bullet, no network/DB/Redis. This is the payoff of two structural choices: detectors as pure functions (state in, events out) and the 48h raw store (DECISIONS #14 — first concrete use).

## 2026-07-16 — Phase 1.5 (globe furniture, built during baseline warm-up)

46. **Furniture vs vertical is the governing distinction.** Render-only layers (no Signals, no Stages 2–4, no analyst cost) don't presume the Go/No-Go gate; anomaly verticals do. Approved furniture: satellites, earthquakes, aurora, military air, GPS-jamming overlay. Deferred: wind particles (project-sized, deserves its own phase), lightning (Blitzortung ToS/fragility), ships (no viable free source; aisstream.io noted), air quality and wildfires (post-gate vertical candidates — fires should debut as the analyst's second vertical, not as dots). Gate questions stay a test of the flights vertical.

47. **Client-direct fetch policy for keyless, CORS-open public feeds** (CelesTrak, USGS, SWPC) — no backend plumbing for render-only layers. Promotion path: a layer that earns vertical status post-gate moves its fetcher server-side into the four-stage pipeline; the renderer doesn't change. mil/jamming layers ride existing backend (adsb.fi collector, hot integrity keys) since those sources already live there.

48. **Satellites: SGP4 in a Web Worker at 1–2s ticks, main thread lerps world positions between frames.** 8k × SGP4 on the render loop would cost ~100ms/frame; the worker makes it ~zero (measured: 15,613 total instances render at 1.43ms/frame GPU-synced). satellite.js pinned to **v5** (pure JS) — v7 ships a WASM/pthreads build with top-level await that breaks esbuild dep-optimization and module workers. `optimizeDeps.include` pins pre-bundling so workers never race a mid-session re-optimization (504 Outdated Optimize Dep → opaque worker error). Propagation validated live: ISS within 0.03° of wheretheiss.at; GNSS shell at r≈417; GEO ring at r≈661.4, world-stationary. `verify:iss` script guards the math.

49. **Curated satellite default (~400: stations, GNSS constellations, brightest, weather) with Starlink (~9k) as an off-default toggle.** `weather` group added so the GEO ring is populated (GOES/Meteosat/Himawari). TLE etiquette: 6h cache in localStorage for ALL groups including bulky ones, stale-cache fallback on fetch failure — CelesTrak 403'd repeat Starlink pulls during testing, which is exactly the throttle the cache now respects.

50. **Central picking arbitration.** One pointer handler (GlobeView) collects candidates from per-layer Pickers; globally nearest within each layer's forgiving radius wins; empty click clears selection and card. AircraftLayer's private listeners refactored into the same mechanism. Shared tangent-frame math extracted to [surfaceMath.ts](apps/web/src/globe/surfaceMath.ts).

51. **Zoom ceiling 480 → 720** ("space band") so GEO is visible; inner zoom curve untouched. Owner re-verification of feel at the outer band pending (the one human gate in Phase 1.5).

## 2026-07-16 — first shadow-calibration amendment

52. **7500 → S1 now requires cross-network corroboration (amends #4; owner-ratified).** Day-one shadow data: ~12 distinct aircraft/day flagged as "persistent 7500" against a design bar of <1 S1/week — all single-network, clustered over US coverage. Root cause: aggregator caches update `seenAt` on any message (mostly position) while a stale/garbled squawk value lingers, so the independent-observation persistence test passes trivially. New rule: **S1 only when BOTH OpenSky and adsb.fi report the squawk within the window, across ≥3 independent observations spanning ≥3 minutes** — a cache artifact lives in one aggregator; a real hijack transponder shows in both. Uncorroborated or shorter persistence (≥2 obs) → S2 feed. Distinct dedupe keys so S2→S1 escalation isn't latch-suppressed. Side benefit: cuts analyst triage spend (~12/day × ~$0.04 was tracking past the $10/mo cap). The downgrade risk — a real hijack in single-network coverage pages as S2 not S1 — is accepted during calibration; push is shadowed anyway. Verified: 4 new regression scenarios in verify:detectors + verify:replay. *Also noteworthy: the containment layers worked exactly as designed while the rule was wrong — cap demoted after 3, analyst triaged the rest to noise/unexplained-low, and only 1 signal would have actually pushed.*

## 2026-07-16 — furniture layer fixes (owner-reported: Starlink + aurora invisible)

53. **Starlink TLE caching moved to IndexedDB (was localStorage).** CelesTrak answers a re-download inside its 2-hour refresh window with **HTTP 403** whose body is "GP data has not updated since your last successful download" — a bandwidth-saver, not a block. The old code treated it as a hard error, and the ~1.9MB Starlink set never persisted (localStorage quota, shared across all groups + app state), so every reload re-fetched → re-403'd → rendered nothing. Fix: durable IndexedDB cache (verified: 2MB round-trip persists where the combined localStorage set failed), 12h TTL (comfortably inside orbital accuracy, well past CelesTrak's 2h window so we never re-trigger the 403), and graceful stale-serve on any fetch error. Cold-start caveat (documented, not a bug): if the very first fetch lands inside a 403 window with no cache anywhere, the group is empty until CelesTrak's next refresh — self-heals within ≤2h, then persists. Curated groups were unaffected (small enough to have cached).

54. **Aurora shader boosted for visibility.** Data and placement were correct all along (OVATION oval verified at 60–75°N / 60–90°S), just too faint to notice over city lights. Raised canvas gain 2.2→3.0, added `pow(p,0.65)` to lift the faint majority of the oval, widened the night mask slightly into twilight, and multiplied the additive output 2.4×. Verified visibly rendering on the night-side auroral zone. Pure tuning — no logic change.

## 2026-07-16 — Phase 1.5b (second furniture wave: fast set + aerosol + wind)

55. **Six more furniture layers approved during the soak** (same DECISIONS #46 rule — render-only, gate untouched). Fast set built + verified live this session: **cyclones** (A1), **wildfires** (A2, key-blocked), **launches** (A3), **sun/moon** (A4). Aerosol (B) and wind (C) still to come. Every source re-verified live before building, not from memory — the discipline paid off twice (see #56, #57).

56. **NOAA retired OPeNDAP in 2025 (Service Change Notice 25-81)** — the "clean GFS wind" path I'd have built from memory is dead (returns a 301 to a retirement notice). Recorded so the wind layer (Phase C) is planned against reality: it now needs a GRIB2-decode spike (gribberish-WASM in the worker, or ECMWF open-data, or an Open-Meteo coarse-grid fallback), which is why wind is timeboxed and built last. *Lesson reinforced: verify every source live; a remembered API is a stale API.*

57. **Per-source data-path decisions (all verified live 2026-07-16):** NHC CurrentStorms.json has **no CORS** → server proxy `/api/proxy/storms` (15-min in-memory cache, **stale-serve on upstream error** — furniture degrades, never errors). Launch Library 2 is **CORS-open** → client-direct, 20-min refresh + localStorage cache (15 req/hr free tier). NASA GIBS WMTS is **CORS-open** → client-direct daily AOD tiles. FIRMS needs a key → client-direct via `__FIRMS_KEY__` **with automatic fallback to `/api/proxy/fires`** (server reads `FIRMS_MAP_KEY`) if the browser origin is blocked. Sun/moon need **no source** — pure ephemeris ([solar.ts](apps/web/src/globe/solar.ts) + new [lunar.ts](apps/web/src/globe/lunar.ts), truncated Meeus, verified against J2000 syzygies by `verify:lunar`).

58. **GIBS aerosol tiles are the aurora texture pattern, not tile streaming.** Phase B fetches ≤8 static low-zoom AOD tiles once daily to stitch one global equirect texture draped on an overlay sphere — no interactive zoom tiles, no per-frame requests. FOUNDATION's "no tile streaming, ever" non-goal targets street-level interactive tiles; this doesn't cross it. (Documented pre-emptively; B not yet built.)

59. **Docker AOF-corruption recovery (operational note).** A Docker Desktop engine hang required a force-kill (`pkill -9 com.docker`), which truncated Redis's incremental AOF mid-write → Redis restart-looped with "Bad file format". Fix: `redis-check-aof --fix` on the multi-part manifest via a throwaway container against the `orrery_redisdata` volume — truncated 22KB of the last partial write out of 49MB. **Zero real loss**: Redis holds only ephemeral hot state (rebuilt by the collector every poll) + rebuildable detector/cap state; all durable data (baselines 8,041 bins, briefings, signals) is in Postgres, which survived cleanly. Docker instability has now recurred 3×; strengthens the eventual dedicated-box argument (Phase 4) and the "keep the Mac awake, Docker start-at-login" advice.

60. **Aerosol/smoke (Phase B) uses GIBS WMS GetMap, not WMTS tiles.** Verified live that GIBS's WMS endpoint returns a single global 2048×1024 AOD PNG in one CORS-open request — dramatically simpler and more robust than stitching WMTS tiles (the plan's original approach; DECISIONS #58's "8 tiles" is moot). One `TextureLoader.loadAsync`, draped on a low overlay sphere (r≈100.35) with aurora's uv-from-normal projection. Requests **yesterday** (MODIS lags ~1 day) and steps back up to 3 days if unprocessed. Still not tile streaming — one image, daily.

61. **AOD magnitude derives from `r − g`, not `max(r,g,b)`; recolored to smoke-grey.** GIBS renders low AOD as *yellow* (max-channel ≈ 1), so an intensity threshold washed the whole globe and competed with the amber fires. The colormap runs yellow→orange→red, so `(r − g)` orders aerosol low→high monotonically. Then recolored to a desaturated warm-grey→off-white haze — deliberately un-amber so it reads as an atmospheric layer distinct from fire/aircraft marks. Result: smoke veils over the fire fields and China, the pairing the owner asked for. Perf 4.24ms/frame all-layers (fires still dominate; the aerosol sphere is ~free).

## 2026-07-16 — Phase C (wind particles) — the crown jewel

62. **Wind source: Open-Meteo JSON, not GFS GRIB2 — decided by the C0 spike, not preference.** The spike inspected a live NOMADS GFS 10m u/v file: data-representation **template 5.3 (complex packing + spatial differencing)**, the hardest common GRIB2 encoding — a correct pure-JS decoder is high-effort/high-risk and the WASM alternative (gribberish) is the class that burned us with satellite.js v7. Open-Meteo serves the *same GFS data* as CORS-open JSON. Since particle-advection beauty comes from bilinear interpolation + density, not raw grid resolution, JSON is the *right* call, not a downgrade. NOMADS grib_filter DID survive OPeNDAP's retirement (#56) — noted for a future feeder-grade upgrade, not used now.

63. **10° single-request grid, cached 6h.** Open-Meteo rate-limits by *location count*, so a fine multi-request grid 429s (learned live — my own spike testing exhausted the window). A 10° grid is 612 points in ONE lightweight request, cached in localStorage (6h TTL, stale-serve on failure like the TLE/launch layers). Physics verified: Southern Ocean −50° shows mean u=+2.1 m/s (eastward roaring-forties westerlies); equatorial Pacific reads easterly. Coarse grid + advection still reads as smooth flow.

64. **Renderer: 6,000 particles, 14-point world-space trails as additive LineSegments**, bright head → faint tail, deep-cyan → white by speed, at r≈100.45 (below aircraft). Client-only — no worker/server touch, so the flight soak stayed pristine through all of Phase C. Tuning lesson: the first pass had sub-pixel trails (invisible); SPEED 0.10→0.55 and TRAIL_LEN 6→14 gave visible streamlines (verified: 123k cyan pixels in the native buffer, flowing North Pacific field on zoom-in — the far-out downscaled screenshot washes thin additive lines out). Negligible perf cost: 1.41ms/frame all-layers typical, 4.24ms worst-case (zoomed into the fire overdraw), both under the 5ms gate.

### Assumptions pending owner confirmation

- OpenSky registered account + API client will be created by the owner; credentials into `.env`. **Blocks the collector chunk.**
- Personal, non-commercial use satisfies both OpenSky and adsb.fi terms for this project (reading of both says yes; adsb.fi attribution goes in the UI footer).
- Earth textures: NASA Blue Marble (day), Black Marble (night lights), topology bump — public domain, vendored into the repo rather than hotlinked from the three-globe CDN Borderfall uses.
- "The globe feel" means Borderfall's **world-map mode** of `GlobeMap.tsx` — not the regional locked-camera or galaxy variants.
- Single-user auth = one static bearer token in `.env`, checked by server HTTP + WS. No user table.
- Desktop-first; no mobile layout work in Phase 1.
- Postgres 16 / Redis 7 in Compose.
- An Anthropic API key is available for the analyst chunk.
- The 7-day shadow minimum runs inside the 14-day Go/No-Go soak, not before it.
