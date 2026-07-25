# ORRERY — comprehensive design + value review

**2026-07-24 · independent, read-only · all three surfaces (globe · city · Pi appliance) + the pipeline behind them**

> Method note: nothing on the Pi was stopped, restarted, or reconfigured; the soak is untouched.
> All API access was read-only GET. The Anthropic key, OpenSky secret, and FIRMS key were never
> exercised beyond what the running instrument does itself. Findings come from rendered pixels and
> live instrument data, not from reading the docs' claims back at you — and I reached my own
> verdicts rather than inheriting the three prior reviews'.

---

## 1 · Scope & method — what I actually exercised

- **Read** FOUNDATION, DECISIONS (#1–#137), PHASES, EDGE, RUNBOOK-PI5, and all three prior reviews
  (fresh-eyes 2026-07-22, design + pi-display 2026-07-24), then re-derived rather than inherited.
- **Globe, live** in the browser against the Pi's real backend (local dev preview, its proxy bridged
  to the Pi over a local forwarder — the sandboxed dev server can't reach the LAN directly): flagship
  flights streaming (`LIVE · 6,820 AIRCRAFT`), the full furniture composite, the FEED panel
  (SIGNALS/BRIEFING/JOURNAL/GATE), the GATE modal, layer roster, mobile width.
- **CITY map, live**: full-viewport Denver, RainViewer radar, crime/camera/alert dots, the enriched
  crime card, the bottom-right cluster, top-bar status chips.
- **Pi appliance, off-device**: a throwaway venv rendered all 11 fixtures × the real carousel at
  480×320 (69 PNGs, from the **live** `/api/pager/summary`), plus `--selftest` (**ALL PASS**). I read
  the rendered PNGs (NOW, OVERHEAD, SKY, BRIEFING, RADAR, SYSTEM, tornado HAZARDS, offline).
- **Instrument honesty data**, pulled live read-only: `/api/stats/gate`, `/api/health/upstreams`,
  `/api/stats/learning`, `/api/analyst/usage`, `/api/shadow-log`, `/api/signals`, `/api/briefings`,
  `/api/integrity/now`. Cross-read against the detector/analyst source.

Live snapshot timestamp: **2026-07-25 ~02:30Z** (evening 07-24 America/Denver).

---

## 2 · Headline — does the instrument earn its place?

**Yes, and it is close to gate-ready — but the flagship's own feed is being diluted by one
detector firing noise, and the gate's Q3 evidence is still a single row.** Three things are true at
once and the review has to hold all three:

1. **The spine is excellent and the discipline is real.** Four-stage separation holds in code;
   detectors are pure functions; the downgrade-only clamp, the corroboration bar, and the replay
   harness are load-bearing. The globe *feels* good and is beautiful. The briefing voice is the best
   single thing in the project. The GATE review tool is intellectually honest to a fault.
2. **The project actively closes its own findings.** Every top item from the 2026-07-22 fresh-eyes
   review is **already fixed or bounded** (see §3) — the shadow-log-drop bug, the 4× cost overrun,
   the HUD telemetry leak, the find-a-flight discoverability gap, the thin crime card. This is a
   codebase that reviews land in, not bounce off.
3. **The remaining problems are about *value density*, not correctness** — a noisy detector, layer
   accretion, cross-surface content triplication, and quiet-day sparsity on the Pi. None is an
   emergency; two touch the gate.

The honest gate read (§8): the instrument's own GATE tool says **Q1 = "not yet"**, and I agree — the
world has been genuinely quiet, which is a finding, not a defect. But **treat ~Jul 30 as a checkpoint
to decide whether there's enough signal to decide, not as the hard gate** — n=1 in the shadow log
can't answer "worth being interrupted for."

---

## 3 · What the prior reviews flagged that is now CLOSED (verified this pass)

Credit where due — I verified each of these fixed, so they are *not* re-raised below:

| Prior finding | Status now | Evidence |
|---|---|---|
| Fresh-eyes HIGH-1: transient analyst failure drops an S1 from the shadow log | **FIXED** | `apps/worker/src/analyst/jobs.ts:134-146` writes the untriaged S1 in the `catch`, comment cites "fresh-eyes review HIGH-1" |
| Fresh-eyes HIGH-2: analyst spend ~4× target, breaker trips mid-month | **BOUNDED** | `apps/worker/src/analyst/triagePolicy.ts` caps S2 triage at `triagePerDay=10` + 6h per-condition cooldown; calls fell ~81→~11/day; MTD now $4.42 |
| Fresh-eyes quick-win: alert at ~70% of the spend cap | **DONE** | `jobs.ts:226-237` `jobOpsWatch` pushes at 0.7×cap; also a missing-briefing alert (`:210-224`) |
| Fresh-eyes: 19-of-20 layers default-on buries the flagship | **DONE** | globe default roster trimmed to **13/21** (DECISIONS #109); confirmed live `LAYERS 13/21` |
| Fresh-eyes: "0 FPS"/"$3.33 mtd" builder telemetry on viewer HUD | **DONE** | HUD now reads `LIVE · N AIRCRAFT · DATA Ns`; no FPS/mtd on the default header |
| Fresh-eyes MED-8: `sgp4` missing from pager requirements | **DONE** | `edge/pager/requirements.txt` lists `sgp4>=2.23` |
| Design-review P0 #2: crime card is a thin one-liner | **DONE** | enriched card verified live: group name + `occurred`/`reported` + neighborhood + `‹ 2/2 ›` sibling pager |
| Design-review #3: find-a-flight invisible (only `/`) | **DONE** | a `SEARCH / ›` chip is now in the cluster (touch path + hint) |
| Design-review #1: no way back from CITY except top-left | **PARTIAL** | CITY now has the bottom-right cluster with `‹ GLOBE ›` (exit where entry was) + FEED/HOME/LOCATION/LAYERS |
| Pi-review #1/#2 (#134–#136): chronic Baltic red owns the room; portrait pages | **MOSTLY DONE** | local/instrument red split shipped (dot amber on calm, verified); footer clock `07:14 · 82%`; NOW folds the top hazard (`_page_now:838-848`); tornado escalates via red band + promote (`_page_hazards:851-876`); 5-screen re-scope live |

---

## 4 · The one active pipeline problem — the flagship feed is diluted by D1 noise (P1)

This is the most important *new* finding, and it cuts against FOUNDATION's stated #1 goal ("signal
quality over coverage").

**What I saw, live:** the SIGNALS feed (31 open) is dominated by `traffic_collapse` S2s in sparse,
remote/ocean cells — e.g. `S40E145` 20 vs median 42, `N20E115` 16 vs 37, `S40E175` **5 vs 24**,
`N30W105` 15 vs 44. Interspersed are the genuinely valuable `gps_interference` S2s (Baltic 59%,
Black Sea 26%, Persian Gulf 43% — 2.2–2.6× regional norms). The analyst's own inline triage labels
the collapses **"noise (75%)"** and **"consistent with transient coverage artifact,"** and the
nightly briefing explains them away every single night ("more likely the instrument still finding
its diurnal floor than a genuine event").

**Why it happens, in code:**
- `detect/d1Collapse.ts:64` `MIN_CELL_MEDIAN = 20` — a 5° ocean cell with a median of 24–44 aircraft
  clears the floor, but that is exactly the regime where receiver coverage is thin and volatile, so
  a 50–80% "drop" is far more likely a receiver blip than a real collapse.
- `detect/d0DataHealth.ts` only guards a **global** count drop (`MIN_MEDIAN = 1000`) + staleness; its
  regional neighbor-cell correlation guard is **still unimplemented** (the header admits it: "arrives
  with D1"). So a localized oceanic coverage loss passes `coverageOk = true` and D1 fires.
- Baselines are **0% mature** after ~10 days (`/api/stats/learning`: `mature:0, partial:19321`), so
  the median D1 compares against is itself provisional — the briefing says as much.

**Consequence:** the S2 badge (the "notable" tier a viewer is trained to look at) is mostly noise,
which is the feed-side version of the very cry-wolf failure FOUNDATION §4 designs the *push* tier to
avoid. It also spends Haiku triage calls to dismiss signals the detector shouldn't have raised.

**Recommendation (owner's call on which):** keep D1 out of the S2 *feed* until its baselines reach
`mature` (emit as S3/digest meanwhile — the analyst already treats it as digest-grade); **or** raise
`MIN_CELL_MEDIAN` substantially and/or require `mature` maturity for an S2; **or** implement D0's
regional neighbor-correlation guard so oceanic coverage loss suppresses D1 the way global loss does.
Any of these raises feed signal quality directly. (Lower priority, same family: the 7700-cluster S2
fires at a loose 500 km/30 min radius — coincidental in busy airspace, as the 07-22 briefing itself
conceded; `d2Squawks.ts:87`.)

Everything *else* in the pipeline is sound: D2's corroboration bar (`d2Squawks.ts:132-158`) correctly
keeps single-network 7500s at S2 "watching" (why zero S1 has fired since 07-16); 7600/7700 singles
are correctly S3 digest-only (not feed noise); the analyst honesty rules and voice are exemplary.

---

## 5 · Per-surface layer inventory + value verdicts

Every layer judged on uniqueness / locality-to-Denver / actionability / glance-cost / frequency-of-
value / honesty-and-degradation / cost-vs-payoff. Verdicts: **KEEP** (earns its place as-is),
**ENHANCE** (keep, improve as noted), **DEMOTE** (keep the code, take it off the default roster /
off the flagship), **CUT** (doesn't earn maintenance — shelve behind a flag). Tally across 33
entries: **KEEP 13 · ENHANCE 5 · DEMOTE 11 · CUT 4.**

### 5a · Globe (21 layers)

**KEEP** — the flagship, its readouts, and the layers with real local/event value:

| Layer | Def | Verdict | Why + evidence |
|---|---|---|---|
| **CIVIL AIR** (flights) | ON | KEEP | The flagship substrate — live ADS-B is the whole point and the surface D0–D3 run on. `AircraftLayer.tsx:71-174` (20k InstancedMesh, forgiving picker). |
| **AircraftCard** | — | KEEP | Turns a dart into an identified flight; 7500/7600/7700 decode + SIGNAL-LOST are genuine signal. `AircraftCard.tsx:47-153`, `format.ts:55-57`. |
| **Flight-path** (RouteLayer) | — | KEEP | Gated behind an explicit per-aircraft toggle, cheap, zero default cost. `RouteLayer.tsx:69-133`. |
| **BORDERS** | ON | KEEP | Cartographic substrate the rasters can't give up close; what makes every other layer placeable. `borders.ts:100-121`. |
| **AIRPORT DELAYS** (FAA/DEN) | ON | KEEP | Strongest local relevance + actionability of the furniture — answers "why is the flight late?"; stale-serves. `airportDelays.ts:5-6,24,175-177`. |
| **CYCLONES** (NHC) | ON | KEEP | US-basin, empty-when-quiet, authoritative, real advisory timestamps. `cyclones.ts:73-88,228-230`. |
| **EARTHQUAKES** (USGS) | ON | KEEP | Cheap, authoritative, high-signal exactly when a big quake hits; magScale suppresses daily noise. `earthquakes.ts:44-46,77`. |
| **SATELLITES** (curated) | off | KEEP | Correctly opt-in; a study-heavy swarm rightly off the flagship, degrades honestly. `satellites.ts:47-53`, `index.ts:35`. |

**ENHANCE** — keep, but a small change converts ambient furniture into a local signal:

| Layer | Def | Enhancement |
|---|---|---|
| **MILITARY AIR** | ON | Real SA signal, cheap reuse of civil infra — but its card is a frozen click-time snapshot; give it the civil card's 1 Hz refresh + SIGNAL-LOST. `milAircraft.ts:69`. |
| **LAUNCHES** | ON | Best "worth opening unprompted" layer (live countdown); surface the T-1h imminent state as a briefing line, optional visible-from-Denver filter. `launches.ts:172-233`. |
| **WILDFIRES** | off | The one CUT-adjacent layer with real Denver value (CO fire season); add a Front-Range fetch/FRP-floor and wire a large nearby fire into the Signal pipeline — note the global top-50k-FRP cap (`wildfires.ts:70-74`) can *evict* a small nearby ignition for a huge Siberian one. |
| **AEROSOL / SMOKE** | off | Front-Range smoke is genuinely "wouldn't-otherwise-know"; wire smoke-over-Denver into the briefing instead of a silent veil. `aerosol.ts:60-66`. |

**DEMOTE** — keep the code, take it off the default roster (it dilutes the flagship or duplicates the phone):

| Layer | Def | Why demote |
|---|---|---|
| **CLOUDS** | **ON** | Presents 1–3-day-old mosaic as current (`clouds.ts:117-131` prefers completeness over currency), duplicates the phone. Realism drape → opt-in. |
| **RAIN & STORMS** | **ON** | Best honesty engineering in the group, but ≥4 h IMERG latency labeled "STORMS" shows where storms *were*; duplicates live phone radar + the CITY RADAR layer. `rain.ts:20`. *(Caveat: it's part of the living-planet composite's beauty — a legitimate reason to keep on, but make it a chosen one.)* |
| **GPS JAMMING** | **ON** | Honest + globally unique, but all four watch regions are overseas (`watchRegions.ts:19-46` — no Denver tile), and **D3 already delivers this as a briefing Signal** — the always-on overseas tiles don't earn a flagship default. *(Demote the globe overlay; the detector is high-value — see §4.)* |
| **AURORA** | **ON** | Rarely concerns 40°N, no Kp/picker, amplifies probabilities — and the actionable "visible from Denver tonight" verdict **already ships** on HOME (`HomeDashboard.tsx:701-710`) and Pi SKY (`orrery_pager.py:299-305`). The globe oval is pure furniture; demote, no new signal work needed. `aurora.ts:88-114`. |
| **SUN & MOON** | **ON** | Accurate + near-free, but pure global furniture: the subsolar/sublunar points are admitted filler and the moon phase is **already** on HOME SKY TONIGHT + Pi. Same bar that demoted CLOUDS/RAIN/AURORA. Demote off the globe default; the one *missing* piece (Denver moonrise/set + "dark hours tonight") belongs on HOME/Pi, not the globe. `sunmoon.ts:91-128`. |
| **WORLD EVENTS** (GDACS) | **ON** | Well-built and non-redundant, but global floods/droughts/volcanoes are ambient wallpaper a Denver owner can't act on; emits no Signal. `worldEvents.ts:98`. |
| **WIND** | off | Correctly off; 10° grid (~1100 km cells) can't resolve Denver wind, heaviest per-frame CPU in the group. Never promote. `wind.ts:133-177`. |

**CUT** — doesn't earn ongoing maintenance for a landlocked signal-quality instrument (shelve behind a flag):

| Layer | Def | Why cut |
|---|---|---|
| **OCEAN CURRENTS** | off | Clearest coverage-not-signal: nearest current ~1500 km away, zero locality/actionability. `oceanField.ts:19-21`. |
| **SHIPPING LANES** | off | A static 2015–2021 baked PNG — a googleable textbook image that can never surface anything new. `shippingLanes.ts:1-8,73`. |
| **VESSELS** | off | The most expensive furniture by far (~380-line WS worker, 20–60k instances, key-gated + unverified live) spent on ocean texture a landlocked owner won't act on. `vessels.ts:48-57`, `ais.worker.ts:44-61`. |
| **STARLINK SHELL** | off | 9000 interchangeable dots, identical cards, no locality, heaviest fetch — even as opt-in it barely earns it. Keep the reusable factory `sats` uses; drop the instance. `index.ts:42-49`. |

### 5b · CITY (10 layers)

| Layer | Def | Verdict | Why + evidence |
|---|---|---|---|
| **LOITER** | ON | **KEEP** | Strongest CITY layer vs the thesis — "why is that helicopter circling?" is answerable by nothing else, reuses the flights flagship for ~zero cost, silent until something dwells. `loiterHeuristic.ts:42-70`. |
| **ALERTS** (NWS) | ON | **KEEP** | Thesis-ideal: silent for weeks, then the actual polygon shape of a tornado/flash-flood warning over your house. ENHANCE: distinguish an NWS outage from all-clear. `alertsLayer.tsx:29-33`. |
| **EMERGENCY** (IPAWS) | ON | **KEEP** | Rare-but-critical civil alerts you'd otherwise miss. ENHANCE: surface dropped-alert count + outage-vs-quiet (two honesty gaps let real alerts go unseen). `emergencyLayer.tsx:27-36`. |
| **RADAR** (precip) | ON | **KEEP** | Duplicates any phone, but "is that storm going to hit *my streets*?" framing + ~zero cost earns it; a picture beats a text line. `radarLayer.tsx:49-81`. |
| **CRIME** (DPD) | ON | **KEEP** | Founding, genuinely local, honest; ambient rather than actionable, but block-level crime near home is exactly the CITY-surface "wouldn't otherwise know." *(Note: surfaces publication-recent events that occurred weeks earlier — verified live: a Jun 30 theft shown as "reported 3d ago." The occurred/reported split already labels this honestly.)* `crimeLayer.tsx:55-57`. |
| **TRAFFIC** (CDOT) | ON | **ENHANCE** | Useful "is my route a mess?" glance, but a 25 mi radius surfaces closures you'll never drive; narrow to likely corridors so it fires on relevant incidents. `trafficLayer.tsx:53-56`. |
| **CAMERAS** (ALPR) | ON | **DEMOTE** | Unique + impeccably honest, but static infrastructure (24 h TTL) with near-zero repeat value — high novelty once, then filler. Opt-in reference lens. `camerasLayer.tsx:20-22`. |
| **OEM** | ON | **DEMOTE** | Thesis-aligned *if it works*, but "structurally verified only" — never seen with a live incident, and its exception-based path makes a broken feed indistinguishable from a calm city. Off default until a first real incident proves it populates. `oemLayer.tsx:2-8`. |
| **TRANSIT** (RTD) | off | **DEMOTE** | Correctly off; no arrival predictions, RTD/Google do it strictly better. Borderline CUT on maintenance. `transitLayer.tsx:39-40`. |
| **311** | off | **DEMOTE** | Correctly off; low-signal neighborhood haze, nothing to act on, not glanceable. Cheap/honest enough to keep as an opt-in curiosity. `threeOneOneLayer.tsx:82`. |

**Net:** on the globe, the flagship + 6 local/event layers earn their place; **six default-on layers
(CLOUDS, RAIN, GPS JAMMING, AURORA, WORLD EVENTS, SUN & MOON) are ambient/global and should come off
the default roster** — each is either duplicated by a more-current/home-relative readout on HOME/Pi or
is admitted filler — trimming the default from 13 to ~7 and letting the flagship + anomalies +
local-events be the voice. On CITY, the default set is already close to right — the two demotions
(CAMERAS, OEM) sharpen it.

---

## 6 · Cross-cutting findings

**C1 · The one stated value (signal quality) is undercut by one detector.** Everything in the
pipeline is built to protect signal quality — the corroboration bar, the downgrade-only clamp, the
S1/S2/S3 tiers, the digest relegation of routine squawks. Then D1 on immature baselines floods the
S2 "notable" feed with ocean-cell artifacts the analyst itself labels noise (§4). It is the single
place where the instrument contradicts its own thesis, and the highest-leverage fix in the review.

**C2 · Redundancy — separate the *justified* device-copies from the *stale globe copies*.** Two very
different things get lumped together as "duplication":

- **Justified (keep):** briefing, overhead traffic, crime, and anomaly-signals each render on
  FEED + HOME + Pi, but every copy reads the *one* Stage-4 source and each is the right surface for
  its context (globe = full feed, HOME/Pi = home-filtered digest, LOITER = dwell heuristic; NEARBY
  SIGNALS even carries an explicit "see FEED" pointer for the far ones, `HomeDashboard.tsx:568`).
  Keep these — just guarantee a single canonical lead so the three can't diverge.
- **Unjustified (the real finding):** the globe layers that are *stale copies of a better,
  home-relative readout that already exists*. Precipitation shows on **four** surfaces (globe RAIN
  4 h-old, globe CLOUDS 1–3 day-old, city RADAR live, HOME NOW) — the two globe copies are the
  stalest. The aurora oval duplicates the HOME/Pi "visible-from-Denver" verdict. The moon phase is on
  globe SUN & MOON *and* HOME SKY *and* Pi SKY. These are the §5a DEMOTE candidates: the globe is
  carrying the worst copy of data a better surface already owns.

And where copies genuinely differ, they **drift**: the Pi CRIME ticker counts a 25 mi radius ("932")
while the browser CITY counts a ±8 mi box ("758") for the same week (pi-display-review §6 — still
true), and the browser crime card gained occurred-vs-reported enrichment the Pi ticker lacks. Unify
the *data contract and formatting* (one crime fetch shape, one radius label, one card vocabulary).

**C3 · A degradation-honesty gap on the safety-adjacent layers (P1).** Most layers degrade
beautifully (stale-serve, "unavailable", empty-when-quiet). But several **exception-based** layers
cannot distinguish "upstream failed" from "genuinely nothing near you" — `oemLayer`, `emergencyLayer`,
`alertsLayer`, `airportDelays`. For a curiosity layer that's fine; for a **tornado/civil-emergency**
layer it means a silent NWS/IPAWS outage reads identically to all-clear. Four independent finder
verdicts flagged this; it's the most safety-relevant cross-cutting item. Add an outage sentinel
(last-successful-fetch age) so a dead feed shows as degraded, never as calm.

**C4 · The default globe roster still over-weights ambient furniture.** Even after the #109 trim to
13/21, six default-on layers are global/ambient (CLOUDS, RAIN, GPS JAMMING, AURORA, WORLD EVENTS,
SUN & MOON, §5a). The flagship (flights + anomalies) is still one voice among the always-on composite.
Demoting those six to opt-in makes the *default* view read as "aircraft + what's locally happening,"
which is the instrument's actual point — everything remains one toggle away.

**C5 · The navigation grammar is converging but not unified** (design-review #1, partially closed).
CITY now carries the bottom-right cluster with a `‹ GLOBE` exit, but two idioms still coexist (the
top-left status chips and the cluster), Escape closes modals but not globe panels (verified — two
Escapes left the FEED panel open), and every control is a click-only `<span>` with no button/focus
semantics (the ✕ isn't even in the a11y tree). For a single-user instrument these are legitimately
P2, but they are the last of the design-review's structural asks still open.

**C6 · The instrument's best signals are buried below the fold on HOME.** The genuinely actionable,
home-relative readouts — aurora-visible-tonight, the next ISS pass, the home-airport delay, the
nearby-fire count with distance/bearing — all live in the HOME dashboard, but at the *bottom* of a
~78vh scrolling panel that already needed a "⌄ more" cue and a review-#114 "went unfound" fix
(`HomeDashboard.tsx:329-343,718-741`). The single densest concentration of "worth opening for" value
in the whole instrument sits where it's least seen. A compact top-of-panel summary (the two or three
things that are *actually* true right now) would surface them.

**C7 · One shared honesty gap has one shared fix.** Two related client-direct patterns recur across
many layers: (a) the exception-based safety layers vanish their chip on fetch failure, so outage ≡
all-clear (§C3); (b) the keep-last-texture globe feeds (CLOUDS, AURORA, EARTHQUAKES, WORLD EVENTS)
hold stale data with no freshness label. Both are the same missing primitive — a **shared staleness /
last-successful-fetch badge** — and fixing it once is cleaner than per-layer patches (and shouldn't,
by itself, swing individual value verdicts).

### What's genuinely missing (a Denver owner would want, no layer provides)

- **Sunrise/sunset + moonrise/moonset + "dark hours tonight."** SUN & MOON owns the ephemeris math but
  HOME SKY shows only moon *phase*, not the rise/set/darkness window a stargazing owner acts on
  (`HomeDashboard.tsx:637-668`). The single highest-value small add, and it retires the SUN & MOON
  globe layer's only unique claim.
- **A local-wildfire Signal in the briefing.** A large fire near Denver is textbook "worth being
  interrupted for," yet it appears only as a passive HOME fire-count and a silent globe layer — never
  as an emitted Signal (ties to §4's flights-only pipeline and the WILDFIRES ENHANCE).
- **Route/commute-aware traffic.** TRAFFIC fires on any incident in a ~25 mi disc; nothing narrows to
  the corridors actually driven — the line between signal and ambient noise for a driver.
- **A "visible-from-Denver" launch filter.** LAUNCHES shows the entire global 7-day schedule with no
  significance/visibility filter — no "a launch may be visible tonight" the way ISS passes get one.
- **An outage-vs-quiet indicator** for the safety layers (= the §C7 badge).
- *(Speculative)* a Front-Range **pollen/allergy index** — a recurring local-health signal a Denver
  owner routinely acts on; fits the locality+actionability thesis, out of current scope.

---

## 7 · The Pi appliance — in good shape; residual is quiet-day sparsity (P2)

The panel's engineering discipline remains the best in the project (fail-static rotation, pure
self-tested sleep policy, honest offline state, an off-device harness that renders the *actual*
carousel). Since the 2026-07-24 pi-display-review, most of its recommendations **shipped** (#134–136,
verified in pixels this pass): local/instrument red split, footer clock, NOW folding the top hazard,
the tornado red-band escalation, and the 5-screen re-scope (NOW → BRIEFING → OVERHEAD → SKY → SYSTEM,
with HAZARDS/RADAR/CRIME/NEARBY-SIGNALS as exception inserts). CRIME was demoted from a standing
screen to an insert — a defensible divergence from the review's 5-screen-with-CRIME.

**Residual (P2):** on a *quiet* day — the common case — NOW, SKY, and SYSTEM still leave the entire
right column and much of the lower half black (verified: `calm/00_now.png`, `04_sky.png`,
`05_system.png`). NOW fills its lower-left only when a hazard is folded in; on the calm majority it
shows one green "✓ nothing active near you" line over ~40% dead space (`_page_now:840-848`). The
always-available context the review suggested (next ISS pass, moon %, tomorrow H/L — data already in
hand) would fill that void and make the landing page dense every day, not only on alert days. The
tornado escalation is real but the event renders in `L.lg`, not `L.huge`, over a mostly-empty body
(`_page_hazards:864-865`) — a shout, not yet the loudest shout available.

---

## 8 · The Go/No-Go gate — honest read

The instrument's **own** GATE tool (verified live) is the right way to grade this, and it is candid:

- **Q1 — surfaced something genuinely informative?** The tool says *"not yet — no S1 survived triage
  as unexplained; the instrument has been correctly quiet, which is a finding about the world, not a
  defect."* I agree. The one class of genuinely-informative output is the recurring GPS-interference
  read cross-referenced to real reporting (EASA/Spire/press) — real, but arguably something a
  geopolitically-aware owner half-expects. **Leaning weak-yes on Q1**, carried by the GPS signal and
  the briefing's daily judgment, not by any single alert.
- **Q2 — opened voluntarily on quiet days?** Not instrumented, by choice — the owner's to answer.
  The raw material: 4 of 14 days had nothing above S3. (A one-line "last-opened" counter would make
  this answerable next window without tracking the owner meaningfully.)
- **Q3 — was the shadow-mode S1 log worth being interrupted for?** **This is the weak leg.** The
  shadow log is still **n=1** (RPA4359, 7500, 2026-07-16, *untriaged*) — unchanged since the
  fresh-eyes review 8+ days ago, because the #52 corroboration bar (correctly) keeps single-network
  7500s at S2. You cannot answer "worth being interrupted for" from one row, and that row has no
  analyst assessment attached.

**Continuity is real** (`/api/rollups/status`: 288 buckets/24h, 23,068 baseline bins; briefing streak
5 days, 2 missed 07-17/07-19). **Cost is now bounded** (MTD $4.42, ~$0.28/day recent, under the $10
breaker with a 70% alert) — the residual gap vs the "$2–4/month" FOUNDATION target is a conscious
`triagePerDay=10` policy, i.e. a decision to make, not a defect.

**Verdict: not No-Go, not yet Go.** The evidence trail is finally clean (HIGH-1 fixed, cost bounded),
but it is *thin* by design — the world hasn't handed the shadow log anything to grade. Recommend the
owner treat the ~Jul 30 mark as "decide whether there's enough to decide," and, if fixing the D1 feed
noise (§4), do it *before* the window closes so the S2 feed the gate reviewer skims is signal, not
diurnal artifact.

---

## 9 · Prioritized recommendations

Nothing here is a correctness emergency — the gate-critical bug is already fixed (§3). Priority is by
*value-per-effort against the gate and the thesis*. "Pipeline" changes are frozen mid-soak, so they
are post-soak or owner-gated; the rest are client/Pi-only.

| P | # | Recommendation | Surface | Size | Why |
|---|---|---|---|---|---|
| **P0** | 1 | **Hold D1 `traffic_collapse` out of the S2 feed until baselines mature** (emit S3/digest meanwhile), OR raise `MIN_CELL_MEDIAN` + require `mature`, OR implement D0's regional neighbor guard | pipeline | S–M | The S2 feed the gate reviewer skims is currently mostly diurnal artifact the analyst calls "noise"; this is the thesis (§4, §C1) |
| **P0** | 2 | **Demote CLOUDS, RAIN, GPS JAMMING, AURORA, WORLD EVENTS, SUN & MOON off the default roster** (13→~7) | globe | S | Lets the flagship + anomalies + local events be the default voice; each is a stale copy of a better home-relative readout or admitted filler; all stay one toggle away (§5a, §C2, §C4) |
| **P1** | 3 | **One shared staleness/outage badge**: (a) safety layers (ALERTS/EMERGENCY/OEM/AIRPORT DELAYS) render "degraded" not all-clear on fetch fail; (b) keep-last globe feeds show a freshness cue | city/globe | S | A silent NWS/IPAWS outage currently reads identically to "nothing near you"; fixes §C3 + §C7 in one primitive |
| **P1** | 4 | **Fill the Pi's quiet-day space**: NOW/SKY right column takes always-available context (next ISS pass, moon %, tomorrow H/L) | Pi | M | On the calm majority NOW/SKY/SYSTEM are ~40–50% black; the data is already fetched (§7) |
| **P1** | 5 | **Turn three ambient layers into local signals**: LAUNCHES T-1h → briefing line; WILDFIRES/AEROSOL smoke-over-Denver → Signal; MILITARY card → live refresh + SIGNAL-LOST | globe | M | Converts "silent global furniture" into "worth being interrupted for" (§5a ENHANCE) |
| **P1** | 6 | **Surface HOME's best signals**: a compact top-of-panel summary (aurora-visible, next ISS pass, home-airport delay, nearby-fire) + add Denver moonrise/set + "dark hours tonight" | client | S–M | The densest "worth opening for" value sits at the bottom of a ~78vh scroll (§C6); the moon-times add retires SUN & MOON's last unique claim |
| **P1** | 7 | **Unify the cross-surface crime data** (one radius + label + card vocabulary across Pi ticker and browser card) | city/Pi | S | The 932-vs-758 drift is one instrument telling two truths (§C2) |
| **P2** | 8 | **CUT the four dead-weight layers** (SHIPPING LANES, OCEAN CURRENTS, STARLINK SHELL, VESSELS) behind a dev flag | globe | S | Static/landlocked/key-gated furniture that can't surface anything new; keep the reusable sat factory (§5a) |
| **P2** | 9 | **Finish the navigation grammar**: one `Chip` component both views, Escape closes globe panels, real `<button>`/focus on the ~10 shared controls, hover states | both | M | Closes the last of the design-review's structural asks (§C5) |
| **P2** | 10 | **Add a "last-opened" counter** so gate Q2 is answerable next window without tracking the owner | client | S | The gate's own tool admits Q2 is un-instrumented (§8) |
| **P2** | 11 | **Escalate the Pi tornado body**: event name in `huge`, NWS headline text in the empty body below the red band | Pi | S | The escalation shouts but the page is still mostly empty (`_page_hazards:864`) (§7) |

**If only three things happen before the gate window closes:** #1 (so the feed is signal), #2 (so the
default view is the flagship), and #3 (so a safety layer can't go dark silently). All three are small,
and #2/#3 are client-only — no soak risk.

---

## 10 · Questions for the owner (value is a judgment call, not a fact)

1. **D1 traffic-collapse (§4):** are the nightly ocean-cell "collapse" S2s ever worth a look to you,
   or should D1 be held to S3/digest until its baselines mature? (I believe the latter; it's your
   call on whether the flagship feed should carry provisional signals at all.)
2. **Cost target:** is ~$8–13/month acceptable (amend the "$2–4" FOUNDATION line), or should
   `triagePerDay` drop to pull it under? The bound is now conscious either way.
3. **Q2 (gate):** do you actually open it on quiet days? Only you know — worth a "last-opened" counter
   before the next window so it's answerable.
4. **RPA4359 (the one shadow entry):** would you have wanted a 2am push for that single persistent
   7500? That *is* Q3 at n=1.
5. **Layer accretion:** which of the ambient/global layers do you actually *look at* vs. leave on for
   the composite's beauty? (Beauty is a legitimate answer — but it should be a chosen one; see §5.)
6. **VESSELS / WILDFIRES:** still key-gated and unverified live — keep shipped-but-dark, or shelve
   behind a flag until the keys land?
