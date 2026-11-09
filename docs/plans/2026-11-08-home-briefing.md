# Home briefing: build plan
**2026-11-08 · ratified with owner changes (DECISIONS #144) · H0, H1 and H4 built, nothing deployed (#145, #146)**

The analyst stops writing about world flights and starts writing about home: what changed around the house, compared with the home's own normal. It speaks only when something changed. FOUNDATION §12 holds the rules; this document holds the order of work.

---

## 0. What the backtest settled (DECISIONS #143)

| Question | Answer from 90 days (2026-08-07 → 11-04) |
|---|---|
| Is there enough to say? | Yes, but not daily. The proposed rules fired on **21/90 days** (median 1.5/week). Two weeks were fully quiet, and the longest quiet run was 17 days. |
| What's the crime signal? | **Change against normal**, not single incidents. Category clusters within ½ mi fired 4×. Serious violent offenses within ½ mi happen on 56/90 days, so they are background. |
| Which single incidents stay rare? | Gunfire or homicide within ½ mi: 16 days, 4 of them with a shooting, a homicide or shots into a building. |
| What weather is news? | NWS warnings (2), non-fog advisories (2), ≥100 °F (2), air quality ≥101 (1), season firsts. A mild, dry fall, so rerun in February for winter. |
| Cadence | **A home note** on mornings when a rule fired, plus **a weekly roundup** on Monday. |
| With the owner's rules (#144) | Every gunfire and serious violent offense within 1 mi goes in the note, so it has something on **87/90 days** (about 3 items a day): **daily in practice**. |

---

## 1. Phases

Each phase can be built and checked on its own, and nothing ships to orrery without the owner's deploy decision (#120).

### Flight triage, Denver area only (built, #144–145)
`ANALYST_TRIAGE_RADIUS_MI` (default 100) puts an area gate in `decideTriage`. It applies to S1 too.

### H0: Foundations (worker), built (#145)
- **Home anchor reader**: `settings:home` from Redis, falling back to `OWNER_LAT/LON`, the same thing the server resolves. Weather calls get it rounded to 0.1°.
- **Tables**, added to the boot DDL like the rest:
  - `home_crime`: keyed by the upstream offense identity. Which Denver id is stable across republishes is to be verified.
  - `home_alert`, `home_wx_daily`.
  - `house_status`: power and internet transitions.
  - `home_event`: detector output, with rule, payload and `dedupe_key`.
  - `home_note`: date, kind (`note` or `roundup`), text and usage.
- **Spend**: `analyst_usage.kind` gains `home_note` and `home_roundup`, so the existing spend cap and telemetry cover them.

### H1: Crime vertical, built (#145)
- **Collector**: Denver ArcGIS every 3 h (the city publishes Mon–Fri), 1 mi around home, keyed by `OFFENSE_ID`. The first run backfills 400 days, so baselines are mature on day one.
- **Detectors**, sharing `crimeRules.ts` with the backtest:
  - **Nearby** (owner, #144): every gunfire offense (shots fired with no one hit included) and every serious violent offense within 1 mi. One event per offense, ever.
  - **Cluster**: 7-day count per category within ½ mi, compared with the prior year's median/MAD. It alerts at ≥ max(3, median + max(3, 3σ)) and stays latched until the count is back near normal.
- **Verification**: `verify:home` uses **synthetic** fixtures at a public Denver anchor (no real near-home rows in the repo), plus an optional `--live` fetch. The PGlite integration run is described in #145.
- **Panel retune, moved to H4**: the CRIME exception page shows 90/90 days (#143 e). It should show only when a crime detector fired, read from `/api/pager/summary`. That needs H4's endpoint.

### H2: Weather and air
- **Collect**:
  - NWS active alerts every 10 min.
  - The Open-Meteo daily forecast at 05:00.
  - Air quality hourly.
  - Start banking COtrip closures now, though nothing reads them yet. H5 then begins with weeks of history instead of none.
- **Detectors**:
  - Warnings, and advisories except dense fog.
  - Season firsts: first freeze, first hard freeze (≤ 25 °F), first snow.
  - Extremes: ≥100 °F, a ≥25° drop from yesterday's high, gusts ≥50 mph, ≥1 in of rain, ≥3 in of snow.
  - Air quality ≥101, once per episode.

### H3: The house
- **Internet**: every minute the worker probes three independent hosts. All three failing for ≥3 minutes counts as an outage, and its start and end are recorded. No host changes are needed, because the container shares the house's connection.
- **Power**:
  - Bind-mount `/run/orrery-ups.json` read-only into the worker, poll it each minute and record AC↔battery transitions.
  - On boot, if the last heartbeat is more than 10 min old, record "orrery was down from X to Y, last seen on battery at N%". That covers an outage long enough to drain the UPS.
- There is no history to backtest (the journal starts 2026-11-07), so these start untested and get a fixture case each.

### H4: Writer and delivery, built (#146)
Below is the plan as written. What changed in the build: the note runs on `claude-haiku-5-5` and the roundup on `claude-sonnet-5-5`. A plain version rendered in code goes out whenever the model can't write. The web tab shows the last 7 notes.

- **Home note**: `HOME_NOTE_HOUR_LOCAL` (default 7). It runs only if a detector fired in the past 24 h, so a quiet morning costs nothing. A small model writes a few lines.
- **Weekly roundup**: Monday 07:00. It covers the week against normal, including things that stayed under a threshold ("car break-ins within ½ mi: 5, normal 6"). It uses the §9 voice and the larger model, and its prompt rules mirror §12: change before totals, and never the home point.
- `BRIEFING_HOUR_LOCAL` stays as it is. The flights briefing remains off on orrery, and nothing here turns it back on.
- **Surfaces**:
  - `GET /api/home/note/latest` and `GET /api/home/notes?days=`.
  - A HOME tab in the web FEED.
  - The panel's BRIEFING page renders the note. This needs BRIEFING restored in the appliance's local `PAGES`, an owner edit at deploy time.
  - Ossawatomix: a "what's new around the house?" lookup in the worldview skill. That skill lives in OpenClaw's workspace on orrery, outside this repo, so it is also an owner step.
- **Phone push** (owner, #144): on from day one, through ntfy at default priority 3, so the phone's own sound and silent settings apply. One push per note, never louder than other notifications.
- **Voice check**: like chunk 6, one synthetic quiet week (expect a one-line roundup and no notes) and one synthetic busy week.

### H5: Traffic (after ~4 weeks of banked history)
- **Areas** (owner, #144): Denver city limits, I-25 from Fort Collins to Colorado Springs, and I-70 from Denver to Vail.
- **COtrip feeds** (probed with the appliance's key): `incidents`, `plannedEvents`, `roadConditions` (chain and traction law), `destinations` (corridor travel times, such as I-70 toward Vail) and `signs`.
- **Banking**: start in H2, one statewide fetch filtered by route and milepost (and by the city boundary inside Denver).
- **Rules**: full closures, chain and traction-law changes on I-70, and travel time well above its normal for that weekday and hour. Not every I-25 crash, which happen all day.
- **To check first**: travel times all read 0 at the Sunday-evening probe, so look again at a busy hour before relying on them.
- **To consider**: a Friday-evening or weekend-morning I-70 line in ski season.

**Later, each by owner decision:** 311 near home, indoor air and temperature sensors, a February rerun of the backtest for winter weather.

---

## 2. Cost

With daily notes (#144), that is about 30 notes/month on the small model (well under a cent each) and 4 roundups/month on the larger one (~$0.05 each, going by Aug–Sep briefing spend). **About $0.35/month**, against the ~$1.55/month the flights briefing cost. Flight triage (~$6.50/month) now runs for Denver-area signals only, which should take it close to zero.

---

## 3. Deploy notes (when the owner decides; nothing here deploys)

- Worker and server changes need an image rebuild on orrery. Client changes ship through the webdist rsync (RUNBOOK §E).
- Compose gains the read-only UPS bind-mount for the worker.
- **Keep the appliance's local changes:**
  - `.env` keeps `BRIEFING_HOUR_LOCAL=25` and gains `HOME_LAT`/`HOME_LON` (the owner's precise point, from chat, never committed) and `HOME_NOTE_HOUR_LOCAL=7`. `ANALYST_TRIAGE_RADIUS_MI` defaults to 100 and needs no line.
  - The panel's local `PAGES` gets BRIEFING back only when the owner wants the note on the panel. Merge, don't overwrite `edge/pager/orrery_pager.py`.
- The OpenClaw worldview skill is edited on orrery, not in this repo. "Anything new around the house?" should read `GET /api/home/note/latest` (bearer token, like the skill's other lookups).
- The first deployed note is the first live test of two things: the model call (there is no key on the dev Mac) and ntfy delivery. Check the worker log for `[home] note filed`, and the phone.

---

## 4. Owner answers (2026-11-08, DECISIONS #144)

1. **Shots fired with no one hit, and other serious violent crimes, within 1 mi:** in the morning note.
2. **Precise home point:** chosen by the owner. It goes in the appliance's `.env` (`HOME_LAT`/`HOME_LON`) and never in the repo.
3. **Flight triage:** Denver area only (100 mi), S1 included.
4. **Phone push:** on from day one, at default priority, so it follows the phone's own settings.
5. **Traffic:** Denver city limits, I-25 from Fort Collins to Colorado Springs, and I-70 from Denver to Vail.
