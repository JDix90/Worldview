# ORRERY — Pi appliance display design review
**2026-07-24 · companion to the browser review (2026-07-24-design-review.md)**

> **Update 2026-07-24 (DECISIONS #134):** priority items **1 (local/instrument red split)** and
> **2 (footer clock)** are now implemented + selftest-covered + verified off-device — see §9's
> closing note. The rest of this report stands as the review; §10 adds the requested layer-by-layer
> analysis and a 5-screen recommendation.

Method — real pixels, not code imagination (the #118/#115 discipline): all 9 fixtures rendered
off-device at 480×320 (90 PNGs, exit 0), a render from the **live** `/api/pager/summary` fetched
read-only from the appliance, a 240×280 portrait spot-check, dusk dimming verified numerically
(0.66× luminance, blue pulled harder — matches the coded 0.72 × 0.90), the 4px promotion bar
verified by pixel sampling, and `--selftest` run: **ALL PASS (38 cases, exit 0)**. Harness caveats
honored in the findings: `--shot-all` renders synthetic weather (live conditions aren't fetched),
the SYSTEM sparkline needs the stats endpoint so it's absent in mocks, and the Mac render uses
Menlo (the ⚠ glyph fell back to a box — re-verify on-device DejaVu before treating as a bug).

The panel's engineering discipline is the best in the project: a pure, self-tested sleep policy;
fail-static rotation; an off-device harness that renders the *actual* rotation; honest empty and
offline states ("no contact with backend · last ok 8m ago"); the battery header takeover on every
page with zero reflow. Nothing below proposes softening any of that. The findings are about what
the screen *says*, not how reliably it says it.

---

## 1 · Chronic red: a Baltic jamming verdict owns the living room (P0)

`overall_status` (orrery_pager.py:166-182) returns **red** when any integrity region reads
`severe`. The Baltic/Kaliningrad corridor has read severe for days — it's severe in the 07-20
fixture summary (51%) *and* in today's live summary (46%). Three compounding consequences, all
verified in renders:

- **The header dot is red on every page of a "calm" day** (all 90 fixture PNGs + all 10 live).
- **NOW — the local weather glance — is promoted to red-first** (`_page_is_red:523-524`), edge-bar
  and 1.5× dwell included, for a phenomenon 4,800 miles away.
- **The panel never sleeps.** `decide_awake` wakes on red (`WAKE_ON_RED=1` default), and red is
  this same chronic verdict — so while Baltic jamming persists (weeks, historically), the
  23:00–06:30 sleep window is effectively disabled and the screen glows all night.

This is the exact tension #101 already resolved once — GPS jamming was *removed from the panel*
as not locally relevant — but it still drives the panel's most intrusive behaviors. The red
grammar ("first + barred = urgent", #121) only works if red is rare; a permanent red teaches the
household to ignore it, which is the one thing a warning system cannot afford.

**Recommend:** split *instrument red* from *world red*. Feed-down, shadow-S1, and a red local
weather event stay red (dot + promotion + wake). A distant `severe` integrity verdict renders
amber at most, and **never wakes the screen**. One helper (`overall_status` gaining a
`local: bool` dimension) fixes dot, promotion, and sleep in a single place; `decide_awake`'s
selftest battery makes the change safely verifiable off-device.

## 2 · Landscape layout debt: portrait pages on a landscape panel (P0)

The layout system scales fonts from the short edge (`make_layout:131-141`) but the *compositions*
are single-column portrait. On the actual 480×320 panel: NOW is empty below the fold (~55% black),
HAZARDS one line in a void, SPACE/SKY similar — while elsewhere content is being cut mid-sentence
for lack of room (finding 3). `_col_x` (:793-795) exists for two-column landscape but almost
nothing uses it. Renders: `calm/00_now.png`, `calm/01_hazards.png`, `calm/08_space.png`.

**Recommend:** spend the width. NOW's right half takes today's context (next ISS pass, moon %,
tomorrow H/L — data already fetched); HAZARDS' empty space takes the *body* of the top alert
(NWS headline text is in hand and currently unshown); SKY/SPACE merge is worth considering (both
are 2-3 lines; a combined page would shorten the 78s cycle). The sparse-page problem and the
truncation problem are the same problem — space is in the wrong places.

## 3 · "NEARBY SIGNALS" isn't nearby, repeats itself, and trails off (P1)

Live render (`shotslive/calm/05_nearby_signals.png`) shows the page's three slots spent on
El Paso (520mi), **Auckland NZ**, and Lubbock — and the Auckland line reads
"**near Auckland, NZ** · 5 aircraft vs median 22 · **near Auckland, NZ** · 26m": the place prints
twice because the headline falls back to `place` when there's no callsign (:830) and the detail
line *also* appends `place` when `distMi ≥ 1500` (:843-846). Meanwhile every fixture narrative
line ends mid-sentence with no ellipsis — "…a Southwest 737 inbound to", "…7500 held two polls" —
from `_wrap(...)[0]` (:855) and the `[:70]` clip (:850). And with 5 open signals, landscape shows
3 with **no "+2 more" indicator** (`sigs[:n]`, :817-818).

**Recommend:** (a) sort by distance, local-first, and give far signals a one-line collapsed form
("+ 2 distant · Auckland · Dubai") — the page name promises *nearby*; (b) fix the place-duplication
fallback (skip the detail-line place when the headline already used it); (c) a shared
`_ellipsize()` for every clip — an unfinished line must *look* unfinished; (d) "+N more" when
signals overflow the page.

## 4 · The appliance never shows the time (P1)

`_footer:788-789`: `label = battery% if not None else clock` — battery **displaces** the clock,
and the X1200 UPS always reports battery, so the deployed appliance shows "82%" forever and the
time never appears on any page (confirmed across all renders: only "82%"/"12%" bottom-right). A
living-room glance panel without a clock forfeits the cheapest, most-glanced datum it could offer.

**Recommend:** show both ("07:14 · 82%"), or clock in the footer + battery only when not AC
(the header takeover already owns battery urgency). One line of code; verify at 240px width.

## 5 · A Tornado Warning is one 15px line (P1)

`tornado/01_hazards.png`: the most life-safety-critical state the panel can display renders as a
single red text line on a mostly-empty page, visually identical in weight to "DEN: ground stop."
The promotion machinery (front-of-rotation, red bar, 1.5× dwell, red-wake at 3am — all working) gets
attention to the page, and then the page whispers.

**Recommend:** an escalated HAZARDS treatment when any alert is Extreme/red: event name in the
`huge` font, until-time in `lg`, red header band (the battery-takeover pattern, inverted). The
fixture harness makes this verifiable before it ever matters.

## 6 · Smaller findings (P2)

- **Fixture isolation leaks.** `_mock_fixtures` docstring promises determinism (:2060-2061) but
  `calm` embeds a **live** radar + crime fetch (:2076-2077) — today's real storm put a RADAR page
  and echoes into "calm" renders — and the base summary `fixture_v2.json` carries a DEN ground-stop
  + Baltic severe, so *every* fixture promotes NOW+HAZARDS. "Calm cannot be summoned during a
  storm" is the same defect #119 exists to prevent, inverted. Recommend: synthetic
  `radar.near=False` in calm (the `radar` fixture already forces `True` — make it symmetric) and a
  genuinely quiet `fixture_calm.json` summary.
- **Cross-surface drift (one instrument, two truths).** Pi CRIME says "last 7d · **932** reported"
  (25mi radius, `fetch_crime:382-424`); the browser CITY says **758** (±8mi box). Same city, same
  week, different numbers, no radius label on either. Also: the browser crime card just gained
  occurred-vs-reported and neighborhood (#132) — the Pi ticker still shows reported-only + street.
  Recommend: label the radius ("last 7d · 25 mi · 932") and port `occurred` to the ticker line.
- **Promotion bar is 4px ≈ 0.7mm** (:605-606) — present (pixel-verified) but invisible at review
  scale, let alone couch distance. Consider 8-10px or tinting the header band of promoted pages.
- **Body labels repeat the header.** HAZARDS/SKY/SPACE/SYSTEM/CRIME spend their first content row
  re-printing the page name already centered in the header — a full text row on a 320px panel.
- **OVERHEAD wastes its flanks**: scope radius clamps to `L.w//4` (:959) leaving dead margins at
  480px; the ticker's single line could become a right-hand column of the top 3 aircraft.
- **Hygiene:** `README.md` describes the retired 5-page set and old shot filenames; `_page_sky`'s
  docstring ("unconditional now") contradicts `compute_rotation:549`'s 15:00–07:00 gate — decide
  which is intended; `requirements.txt:6-8` sgp4 comment reads as still-missing but the dep is
  present; `RED_ALERT_RE` lazy-init (:200-211) is a benign race between touch thread and main loop;
  ⚠ glyph renders as a box under the Mac Menlo fallback (confirm DejaVu on-device).

## 7 · Enhancements worth considering (not defects)

- **Port the browser pass's vocabulary** where it fits 480×320: named crime groups in the legend
  ("violent 103" already matches), `occurred Xh before reported` on the crime ticker, and the
  browser's "unavailable" wording for dead upstreams so both surfaces degrade in the same voice.
- **A "+N more" grammar everywhere a list is silently capped** (signals :818, crime ticker cap of
  12 at :1365) — silent truncation reads as "that's all there is."
- **Previously declined, unchanged** (recorded so this review doesn't re-litigate): Kp meter
  (#111 declined), voice briefing (#79 deferred), traffic-on-Pi (#101/#126 passed — "static
  infrastructure has no glance value in a carousel").

## 8 · Priority order

| # | Item | Size | Wins |
|---|---|---|---|
| 1 | Local/instrument red split — dot, promotion, **red-wake** stop keying on distant chronic verdicts | S–M | restores the red grammar; the panel sleeps again |
| 2 | Clock in the footer (battery no longer displaces it) | S | the cheapest glance value on the device |
| 3 | Signals page: distance-first + dedup + ellipsis + "+N more" | M | the page finally means "nearby" |
| 4 | Landscape compositions for NOW/HAZARDS (+ tornado escalation) | M | the panel earns its 480px; warnings shout |
| 5 | Fixture isolation (synthetic radar in calm, quiet base summary) + hygiene list | S | the harness's promise ("any state on demand") becomes true again |

Items 1–2 are behavior fixes measurable off-device via the existing selftest/fixture harness before
any owner-gated `orrery-display` restart; 3–5 are layout/content passes verifiable the same way.
Nothing here requires server, worker, or browser changes except the optional radius label parity.

## 9 · Implemented this pass (items 1 & 2 — DECISIONS #134)

Both top items are done in `edge/pager/orrery_pager.py`, selftest-covered, verified off-device.
**No deploy** — an `orrery-display` restart is owner-gated mid-soak (#114/#120).

- **Local/instrument red split** (`overall_status`): a `severe` integrity verdict now reads **amber,
  never red**. One change fixes all three surfaces at once — header dot, NOW red-promotion, and the
  sleep policy (`_apply_sleep` derives from `overall_status`). Verified on re-render: the `calm`
  fixture went from `[promoted: NOW, HAZARDS]` → `[promoted: HAZARDS]`, the NOW dot from red →
  amber (pixel-sampled `255,179,0`), and genuine local reds still fire (offline → NOW promoted;
  critical → SYSTEM promoted; tornado → HAZARDS). 8 new selftest cases (7 `overall_status`, 1
  rotation), **ALL PASS**.
- **Footer clock** (`_footer`): shows `07:14 · 82%` — clock no longer displaced by the ever-present
  UPS battery. Verified at 480 and 240 (fits, tight at 240 — the shelved Zero geometry).

## 10 · What belongs on the Pi — every layer reviewed, and the 5 screens

The owner asked which of the app's ~31 data layers deserve a Pi screen. The organizing principle,
already latent in the codebase (#95 locally-anchored, #101 jamming-removed, #122/#126 "static
infrastructure has no glance value in a carousel", #125 exception-based), is one sentence:

> **The globe is for the world; the Pi is for *here, now, and act-on-able*.** A living-room glance
> panel earns its place only with data that is (a) local to home, (b) currently changing, and
> (c) something a person in this room would look up or do something about.

Against that test, most layers self-select out — not because they're unimportant, but because their
home is the globe. The three verdicts below: **SCREEN** (earns a standing page), **INSERT**
(exception-based promotion only, like RADAR today — appears when it's near/urgent, else invisible),
**GLOBE-ONLY** (no Pi value; the world map is the right home).

### Globe layers (21)

| Layer | Local & now? | Pi verdict |
|---|---|---|
| CIVIL AIR / MILITARY AIR | yes — overhead home | **SCREEN** (OVERHEAD) |
| RAIN & STORMS | yes when near | **INSERT** (drives RADAR page today) + feeds NOW |
| AIRPORT DELAYS (DEN) | yes | **INSERT** → NOW/HAZARDS line |
| SUN & MOON | yes (local sky) | **SCREEN** (SKY) |
| LAUNCHES | only if visible from home | **INSERT** → SKY when imminent/visible |
| AURORA | rare at 40°N | **INSERT** → SKY when Kp says visible (not a standing SPACE page) |
| EARTHQUAKES | only if local | **INSERT** → HAZARDS when within ~150 mi & felt |
| CYCLONES | only if threatening home | **INSERT** → HAZARDS when track nears; else globe |
| WILDFIRES / AEROSOL·SMOKE | only via local AQI | **GLOBE-ONLY** (AQI already on NOW carries the local effect) |
| GPS JAMMING | geopolitical, distant | **GLOBE-ONLY** (#101; and #134 just stopped it dominating red) |
| WORLD EVENTS | global | **GLOBE-ONLY** |
| BORDERS, CLOUDS (global deck), WIND, OCEAN CURRENTS, SHIPPING LANES, VESSELS, SATELLITES, STARLINK SHELL | ambient/global | **GLOBE-ONLY** — these are what makes the *globe* worth watching; none is a living-room glance |

### City layers (10)

| Layer | Local & now? | Pi verdict |
|---|---|---|
| CRIME | yes — near home, changes | **SCREEN** (CRIME) |
| RADAR (precip) | yes when near | **INSERT** (already the conditional RADAR page — the model to copy) |
| ALERTS (NWS) / EMERGENCY (IPAWS) / OEM | exception-based, local | **INSERT** → HAZARDS (fold the three into one "what's active near you" page) |
| LOITER (aircraft dwelling) | yes | feeds **OVERHEAD** (the "why is that circling?" answer, #125) |
| TRAFFIC (CDOT) | static-ish | **GLOBE-ONLY** (owner already passed, #101/#126) — at most an INSERT for a closure on a saved commute |
| TRANSIT (RTD vehicles) | live but not glance | **GLOBE-ONLY** — a map toy, not a living-room datum |
| CAMERAS (ALPR) | static infrastructure | **GLOBE-ONLY** (#122/#126: "static infrastructure has no glance value in a carousel") |
| 311 (service requests) | low urgency | **GLOBE-ONLY** |

Plus the pipeline's own output (not a layer): the **analyst BRIEFING** and **D0–D3 signals** — the
instrument's reason to exist (FOUNDATION). Briefing is a screen; the signals surface via promotion
+ the briefing digest, not a standing distant-noise page (finding §3).

### The 5 screens

Collapsing the current 9 content pages against the test yields **five standing screens, plus
SYSTEM riding last as panel-only infrastructure, plus exception-based inserts** — a sharpening of
today's IA, not a teardown:

1. **NOW** — big-type weather + AQI, **with the single most urgent local hazard folded in**
   (tornado / air-quality / DEN ground-stop). The page you always land on carries the one thing you
   must know. *Absorbs HAZARDS* (which is a near-empty standing page today, §2).
2. **BRIEFING** — the analyst's daily read. Unique to this instrument; keep verbatim.
3. **OVERHEAD** — civil + mil aircraft over the house, home-centered, LOITER-aware. The signature
   flight-instrument glance ("what's that helicopter?").
4. **CRIME** — recent reported crime near home, with the browser's occurred-vs-reported +
   neighborhood enrichment ported (finding §6). Owner-built, local, act-on-able.
5. **SKY** — tonight's ISS pass + moon, **absorbing SPACE**: aurora and a visible launch appear
   here *only when actually visible* (exception-based), rather than a standing Kp page (Kp meter was
   declined, #111). "Go outside at 17:20."

**Riding alongside (not part of the 5):**
- **SYSTEM** — panel-only last page; the sole UPS/wifi/uptime readout (#115), infrastructure not
  content. Unchanged.
- **Exception inserts** — RADAR (precip near, exists today), a promoted HAZARDS escalation (tornado,
  §5), a local quake/cyclone/launch/aurora. These follow the proven RADAR pattern: present only when
  the world makes them relevant, invisible otherwise. This is how the other ~20 layers reach the Pi
  *when they matter to here* without ever cluttering the steady-state cycle.

**Net effect:** the steady-state carousel shrinks from 9 pages (~78 s) to **5 + SYSTEM (~55 s)**,
every standing page is dense and local, and the long tail of global layers reaches the panel only
by promotion. It's the same thesis the browser overhaul followed — *show the relevant thing
clearly, let the rest be reached deliberately* — applied to the surface that has the least room and
the most glance-cost.

**What I would NOT do:** add any global/ambient layer as a standing Pi page. The globe already does
the world beautifully; duplicating cyclones/quakes/events/jamming/vessels onto a 480×320 panel a
person walks past would dilute exactly the local-glance value that makes the appliance worth having.
