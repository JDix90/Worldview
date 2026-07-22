# ORRERY — fresh-eyes review, 2026-07-22

Reviewer: first contact with the project. Read-only throughout; nothing on the
Pi was stopped, restarted, or reconfigured. FIRMS was never called. Findings
below come from running/observing the live system (globe at `10.0.0.177:8787`,
Pi over ssh, the four verify suites, direct reads of the source) — not from
reading the docs' own claims back at you.

---

## 1. Executive summary

This is a genuinely impressive solo build, and the engineering discipline is
real, not performed: four-stage separation actually holds in code, detectors are
pure functions, the downgrade-only clamp exists, the replay/verify harnesses are
load-bearing, and the appliance has survived a real power-cut drill. Typecheck is
clean across all four packages; every verify suite I could run offline passed.
The globe itself is beautiful and the click-cards are legible.

The problems are not architectural rot — they're **accretion** (20 layers, 19
default-on, four different right-docked panels), **a handful of real correctness
holes** in exactly the paths the Go/No-Go gate depends on, and **a cost run-rate
tracking ~4× over target**. None are emergencies for a private LAN instrument;
three are worth fixing before the gate.

Top three, in order: (1) a transient Anthropic failure on an S1 silently drops it
from the shadow log — the one dataset the gate is staked on; (2) analyst spend is
running ~$16/mo against a $2–4 target and a $10 breaker that will trip mid-month;
(3) the auth token is baked into an unauthenticated bundle, so on the LAN it gates
nothing. Verdict: **strong instrument, gate-worthy soon — but fix #1 and #2 first,
because both quietly corrupt the evidence the gate reads.**

---

## 2. First-touch log (verbatim, before reading any docs)

Fifteen minutes as a curious stranger with no context:

- **"1 FPS." "0 FPS."** The HUD's third header field cycles between 0 and 1. My
  first read was "this thing is broken / hard-locked." (It's the render pane being
  rAF-throttled in the background; a real foreground viewer sees 60. But a
  prominent "0 FPS" on load reads as a crash, not telemetry.)
- **"DATA 87s … 105s … 20s."** A number that climbs then resets. Is the data
  stale? Am I looking at something 105 seconds old or 105 minutes? No unit-context
  for a newcomer. (It's snapshot age against the 90s poll — fine once you know.)
- **Four different panels all dock to the right and overlap.** FEED (top-right)
  opens SIGNALS/BRIEFING. HOME opens a dashboard. LAYERS opens the layer list.
  LOCATION opens a city input. I opened them in sequence and they kept replacing
  each other in the same region of screen; it took a while to realize they're four
  separate surfaces, not one panel with tabs.
- **"$3.33 mtd" in the SIGNALS header.** Month-to-date analyst API spend, surfaced
  in the feed a viewer looks at. That's builder-telemetry leaking into the product
  surface; a friend you showed this to would have no idea what it means.
- **LAYERS says "19" but lists 20 rows**, two of them greyed (STARLINK SHELL,
  SHIPPING LANES). Why are two greyed? Off-by-default isn't visually distinct from
  disabled/unavailable. The count and the list disagree.
- **Nineteen layers on by default.** Wind, currents, clouds, rain, aerosol,
  borders, quakes, events, cyclones, fires, airports, launches, jamming, aurora,
  sun/moon, civil air, military air, satellites, vessels — all lit at once. The
  globe is stunning but it's also *everything, always*; I couldn't tell the
  instrument's flagship (flights + anomalies) from the furniture.
- **The good, unprompted:** the terminator + city lights + live storm cells are
  gorgeous. Clicking an aircraft gave a clean card ("SkyWest flight", FROM/TO, a
  SHOW FLIGHT PATH button that drew a real great-circle). The HOME dashboard's
  "nothing near you · 5 signals elsewhere" empty state is exactly right. This half
  of the UX is polished and confident.
- **The signals prose is half plain, half jargon.** "2 aircraft squawking 7700
  within 500 km … not a routine diversion pattern" — great. "unexplained (58%) —
  Observed 2.1× elevation in low-NIC fraction" — that's the instrument talking to
  its builder, not to a person.

The through-line: the *globe* and the *cards* were designed for a stranger; the
*panels and HUD* were designed for the author. That's the IA gap in one sentence.

---

## 3. Top issues, ranked

Correctness first, then architecture, then polish.

### HIGH-1 — A transient analyst failure on an S1 drops it from the shadow log
`apps/worker/src/analyst/jobs.ts:91-113` · fix size: ~10 lines

The no-API-key path is carefully handled: an untriaged S1 is force-written to
`shadow_push` with a comment explaining exactly why ("no analyst means no
downgrade… MUST reach the shadow log"), `jobs.ts:82-90`. But when the key *is*
present and `triageSignal` throws — Anthropic timeout, 429, 5xx, malformed reply —
control jumps to the catch at `:108`, the cursor advances at `:112`
("advance even on failure — no poison-pill loops"), and the `shadow_push` insert
at `:98-103` never runs. The S1 lives in the `signal` table but never reaches the
shadow log, and the Sunday calibration digest (`briefing.ts` `appendShadowWeek`)
reads only `shadow_push`.

Why it matters *here*: this is the single dataset FOUNDATION §4 and the §11 Q3
gate question ("was the shadow log worth being interrupted for?") are staked on.
The code guards the rare case (no key) and forgets the likely one (a hiccup on a
real emergency squawk). I confirmed the path by reading it; I also cross-checked
the 5 S1s in the DB — the 4 not in `shadow_push` are explainable (2 predate the
force-write fix, 2 were legitimately downgraded to S2), so **the bug is real in
code but has not yet demonstrably bitten**. It will the first time an S1 coincides
with an API blip. Fix: in the `catch`, if `signal.severity === 'S1'`, write the
untriaged shadow row before advancing — the same branch the no-key path already
has.

### HIGH-2 — Analyst spend is ~4× target and will trip the breaker mid-month
observed from `analyst_usage` on the Pi · env: `apps/worker/src/env.ts:29-30` · fix: policy, not lines

Measured month-to-date (07-16→07-21, six days): **$3.33**, i.e. ~$0.55/day →
**~$16.5/month projected**. FOUNDATION §8 targets "pennies per day, realistically
$2–4/month"; the configured breaker is `$10` (`ANALYST_MONTHLY_SPEND_CAP_USD`,
default 10). Per-day breakdown (triage + briefing): 0.37, 0.54, 0.44, 0.51, **0.95**,
0.52. The driver is triage volume — 30–83 triage calls/day because **every S2 is
triaged** and S2 emergency-squawks are firing constantly (232 S2 squawk rows in
the table). A full August at this rate trips the $10 breaker around the 18th, at
which point the analyst degrades to "unavailable — spend cap" and the daily
briefing goes dark for the rest of the month — during the exact window the gate
needs unattended-daily continuity.

Corroborating overage: web-searches/day hit **12 on 07-17**, above the ≤10/day
budget (`ANALYST_WEB_SEARCHES_PER_DAY`) — consistent with the audit note that the
budget counter is Redis-only with a short TTL, so a reset re-opens it.

Why it matters: cost discipline is a stated FOUNDATION goal *and* the breaker
tripping silently kills the briefing streak. Fix options (owner's call, and the
analyst is frozen mid-calibration so this is a post-soak change): triage only a
sample of S2s, or gate triage behind corroboration the way S1 already is, or raise
the cap consciously and re-baseline the "$2–4" claim. At minimum, alert when MTD
crosses ~70% of the cap so the streak-killer isn't a surprise.

### HIGH-3 — The auth token is baked into an unauthenticated bundle
`apps/web/vite.config.ts:23-27` bakes `ORRERY_AUTH_TOKEN`; `apps/server/src/index.ts:42-45` serves `webDist` outside the auth scope · fix size: small

I verified this end-to-end: fetched `/` with no credentials, pulled
`assets/index-*.js`, and grep'd the live token straight out of it (present).
`FIRMS_MAP_KEY` is baked too (`__FIRMS_KEY__`, used client-direct in
`wildfires.ts`). So in appliance mode (`0.0.0.0` LAN bind + web dist), the single
token that gates every `/api` route and the WS is downloadable by anyone who can
load the page — "the token never leaves this machine" stopped being true the
moment the Pi served the bundle to other LAN devices. `ANTHROPIC_API_KEY` and the
OpenSky secret are correctly *not* baked (I checked — zero hits).

Why it matters *here*: the whole threat model is "trusted LAN," so this is a
documented Phase-4 deferral, not a live breach. But it's worth being honest that
the auth model is currently decorative on the LAN. The client-direct FIRMS path
also makes `/api/proxy/fires`'s key-hiding pointless (`wildfires.ts:161-180`).
Cheapest honest fix: gate the static route behind the same token, or accept it and
write down that appliance mode = LAN-readable, and move per-device tokens up the
Phase-4 list.

### MED-4 — `feed/routes.ts` localStorage cache grows unbounded, O(n)-rewritten per lookup
`apps/web/src/feed/routes.ts:40-56, 81-116` · fix size: ~15 lines

`loadPersisted()` never prunes — the 24h TTL gates *reads* only, never eviction.
Every unique callsign ever clicked is appended to one JSON blob, and `persist()`
re-`JSON.stringify`s the entire cache on every positive hit. Over weeks of a
living-room appliance this is real memory growth plus rising parse/stringify cost
per selection, ending in a silent quota failure. It's the clearest latent bug in
the web subtree. Fix: prune expired entries on write, cap the entry count.

### MED-5 — Massive layer duplication: ~600–700 near-copy lines, no shared helper
`apps/web/src/layers/*` · fix size: large but mechanical

Two families are copy-paste:
- **Drape layers** (aerosol/clouds/rain/shippingLanes): the vertex shader,
  uv-from-normal fragment preamble, WMS-URL builder, and the whole
  init/loadAsync-walkback/fade/dispose scaffold are ~55% duplicated — **~300 of
  554 LOC**. A `makeDrapeLayer({radius, opacity, fade, source, fragmentBody})`
  collapses all four to config.
- **Marker+picker layers** (quakes/events/cyclones/fires/launches/airports/mil/
  ships/sats): the 12-line screen-projection pick loop is repeated **verbatim in
  11 places** (~130 LOC), the marker-packing `rebuild()` 6× (~110 LOC), the
  init/scratch/dispose scaffold across ~9 layers (~120 LOC).

This has already produced live drift: the silhouette-cull constant is hardcoded
`100 * 100` in 6 layers but `GLOBE_RADIUS * GLOBE_RADIUS` in the others — identical
today (radius is 100), silently broken the day the radius changes. Extracting
`nearestOnScreen()` + `placeSurfaceInstances()` + `makeDrapeLayer()` reclaims ~500
lines and kills the drift class. This is the dominant code-health liability, but
it's maintainability, not correctness — hence MED.

### MED-6 — No outbound timeout on any worker or proxy `fetch`
worker: `opensky.ts:32,68`, `adsbfi.ts:100`, `notify.ts:15` · server: `api.ts:352` · fix size: one line each

None of the collector fetches nor the server proxy sets an `AbortSignal`. undici's
defaults are long; a hung upstream ties up a BullMQ worker slot, and with worker
`concurrency: 2` two hangs stall the whole pipeline. On the server side,
`/api/pager/summary` awaits the FAA proxy, so a stalled FAA host degrades the
pager poll into a hang instead of the graceful null it was designed to give.
`routes.ts:31` already shows the pattern (`AbortSignal.timeout(6000)`) — apply it
to the other five. Highest reliability-per-line fix in the tree.

### MED-7 — UPS monitor can, in principle, shut down a healthy appliance
`edge/appliance/x1200_monitor.py` (Gauge read ~59-75; step ~179-194; graceful_shutdown ~145-151)

The two-strike low-battery gate is only ~10s of debounce (`POLL_SEC=10`), there's
no plausibility clamp on the I2C SOC/VCELL reads (a bus glitch or ungauged
MAX17040 at boot can read SOC≈0, which passes `≤15`), and the PLD GPIO pin/polarity
ships **explicitly unconfirmed** (the source comment says "CONFIRM on-device before
trusting shutdowns"). An inverted AC read + one garbage low reading twice = a
`docker compose stop` + `shutdown -h now` on a plugged-in box. Secondary: if
`docker compose stop` times out (no `check`, 180s), the exception propagates and
`shutdown -h now` is never reached, so a *real* low battery leaves a stopped stack
that then drains to an unclean cutoff. The 07-20 drill passed, so the happy path
works; these are the unverified-pin and bad-read edges. Add a sanity floor on
gauge reads and confirm the pin, since a false shutdown ends the soak.

### MED-8 — `sgp4` missing from pager requirements (reproducibility, not live)
`edge/pager/sky.py:136` imports `sgp4`; `edge/pager/requirements.txt` lists only
requests/Pillow/numpy. I checked the live Pi — **sgp4 2.27 is installed**, so the
ISS-pass line works today. But a clean venv rebuild per the runbook would silently
lose it (`ImportError` is swallowed at `orrery_pager.py:348`, and the selftest
never calls `next_iss_passes` despite a comment claiming a "structural pass
check"). One line in requirements.txt closes it.

### LOW-9 — Constitutional soft-spots the docs already half-concede
- **Demotions recorded but not surfaced.** `emit.ts` writes `demoted_from`, but
  `briefing.ts:40-86` hands the model S2 payloads with no demoted flag, so the
  briefing can't "explain the demotions" §4 promises. The audit trail is in
  Postgres; the surfacing isn't.
- **D0 regional guard unimplemented.** `d0DataHealth.ts` does global-count-drop +
  staleness only; the neighbor-cell correlation §7 describes (and the file header
  concedes is missing) isn't there, and D1 gates on the *global* verdict — so a
  localized receiver outage can still false-fire D1, the exact case D0 exists to
  suppress. Mitigated by D1's median floor + 2-breach persistence, not closed.
- **`EMERGENCY_SQUAWKS` duplicated** between `packages/shared/src/redisKeys.ts`
  and `api.ts:22` — the one drift nit in an otherwise clean shared package.

### LOW-10 — `shippingLanes.ts:72` unhandled promise rejection
The one layer whose texture load has a `.then()` with no `.catch()` — a 404 on the
vendored PNG throws an unhandled rejection instead of the uniform
`warn → stale-serve` every other layer does. One line.

---

## 4. Quick wins (< 1 hour each)

1. **HIGH-1's shadow-log fix** — ~10 lines in the `catch`, and it protects the
   gate's core dataset. Do this one first.
2. **Timeouts on the five fetches** (MED-6) — one `AbortSignal.timeout()` each.
3. **`sgp4` into requirements.txt** (MED-8) — one line, saves a future silent loss.
4. **`shippingLanes.ts` `.catch()`** (LOW-10) — one line.
5. **Drop "$3.33 mtd" and "0 FPS" from the default HUD/feed** — builder telemetry
   on a viewer surface; move behind a debug toggle.
6. **De-import the duplicated `EMERGENCY_SQUAWKS`** — use the shared constant.
7. **MTD-cost alert at ~70% of the cap** — turns HIGH-2's silent streak-killer
   into a heads-up (the ops-alert plumbing already exists).

## 5. What I would cut

Accretion is the project's own stated main risk, so be brave here:

- **Demote most layers from default-on.** 19-of-20 lit at once buries the
  flagship. Default set should be flights + anomalies + terminator + maybe one
  weather drape; everything else opt-in. The instrument's *point* (aircraft +
  the analyst's signals) is currently one voice in a 19-part chorus.
- **Collapse the four right-docked panels into one surface with tabs.** FEED,
  HOME, LAYERS, LOCATION all fight for the same screen region. HOME dashboard and
  the FEED and the Pi panel triplicate the same content (overhead aircraft,
  nearby signals, weather). Pick one home for "local glance."
- **Cut, or clearly defer, the layers that don't earn the maintenance.** VESSELS
  and FIRMS are both key-blocked and unverified live; the drape family is 55%
  duplicated. If a layer can't be exercised end-to-end, it's carrying weight
  without paying rent — shelve it behind a flag rather than shipping it default-on.
- **Consider whether every S2 needs LLM triage at all.** 232 S2 squawk rows →
  hundreds of Haiku calls is what's blowing the cost target. Many are the same
  cache-artifact class DECISIONS #52 already identified. A cheaper deterministic
  pre-filter before spending a triage call would cut cost *and* feed noise.

I would **not** cut: the four-stage pipeline, the detectors, the verify/replay
harnesses, the terminator/globe feel, or the click-cards. Those are the spine and
they're excellent.

## 6. Gate-readiness opinion

**Leaning No-Go on the current evidence trail — not because the instrument is
bad, but because two of the three gate questions can't be answered honestly with
the data as it's being collected.**

Evidence I could see (read-only):
- **Continuity is real.** `rollup_run`: 1,587 buckets, continuous 07-15→07-21, no
  gap. Containers up 4 days, backups nightly (5 dumps, 732K→2.3M), UPS drill
  passed. The soak infrastructure is sound.
- **Q1 (surfaced something genuinely informative):** plausibly yes — the Baltic
  GPS-degradation signal cross-referenced to real reporting is the kind of thing
  the analyst is *for*. But it's one instance; the rest of the feed is squawk
  noise the system itself keeps triaging to "noise/unexplained."
- **Q2 (opened voluntarily on quiet days):** unmeasurable from here; that's the
  owner's honest self-report.
- **Q3 (was the shadow log worth being interrupted for?):** **this is the weak
  one.** The shadow log has exactly **1 real entry** (RPA4359, untriaged) plus
  design-correct exclusions of downgraded S1s. After the #52 corroboration rule,
  **zero S1 candidates have fired in 5+ days**. So the gate's headline dataset is a
  single row — thin, and *made thinner* by HIGH-1, which would silently delete any
  future S1 that coincides with an API hiccup. You cannot answer "worth being
  interrupted for" from n=1, and the collection path has a hole in it.

Two more timing facts: the "7 consecutive unattended briefings" clock legitimately
restarted at 07-21 (07-17 and 07-19 are permanently missing per DECISIONS #93), so
it completes 07-27 — inside the ~Jul 30 window but with **zero slack**; one more
miss slips it. And HIGH-2's breaker could dark the briefing before then.

Honest recommendation: **fix HIGH-1 and HIGH-2 now** (they corrupt gate evidence),
let the corrected shadow log accumulate, and treat ~Jul 30 as a checkpoint to
*decide whether there's enough signal to decide* — not as a hard gate. The
instrument is close; the evidence isn't quite ready to be graded.

## 7. Questions for the owner (couldn't determine read-only)

1. **Is ~$16/mo actually acceptable**, and should the "$2–4/month" FOUNDATION
   target be amended — or is the intent to cut triage volume back under it?
2. **Do you actually open it on quiet days?** (Gate Q2 — only you know.) A tiny
   "last-opened" counter would make this answerable next time.
3. **Was RPA4359 — the one real shadow-log S1 — something you'd have wanted a 2am
   push for?** That's the whole Q3, and n=1 makes it your judgment call.
4. **The PLD GPIO pin (MED-7): has `pinctrl get 6` actually been confirmed to
   follow AC?** The code still says it hasn't; a false shutdown ends the soak.
5. **Is VESSELS/FIRMS worth keeping default-on** given both are key-blocked and
   unverified live, or should they be shelved behind a flag until real keys land?
6. **Was the FPS/mtd HUD telemetry meant to be viewer-facing**, or is that just
   dev instrumentation that never got a debug gate?

---

*Verified via: globe UI (Chrome, live), `pnpm -r typecheck` (clean, 4/4),
verify:lunar/solar/detectors/replay (all pass), ssh observation of containers/
timers/logs/framebuffer, read-only psql on the Pi, direct source reads for every
`file:line` above, and pulling the token out of the served bundle. Could NOT
verify: live foreground FPS (render pane was rAF-throttled), verify:baselines
(needs a local Postgres; the Mac stack is retired — ECONNREFUSED), and live
VESSELS/FIRMS (key-blocked; FIRMS deliberately not called per the brief).*
