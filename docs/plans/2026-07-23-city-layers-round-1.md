# CITY map — Round 1 layer package: integration plan
**2026-07-23 · plan only, no implementation · owner-curated package: #1, #2, #3, #6, #7, #8, #13, #14**

The CITY map's thesis (owner-ratified): **situational awareness** — *is anything threatening my area, what happened near me lately, what's watching/active here.* Round 1 adds the "right now" pulse the map lacks: today both layers are historical/static. Every source below was probed live today (one gentle request each); findings marked **VERIFIED** / **BLOCKED** / **CAVEAT**.

---

## 0. Probe results (2026-07-23)

| Source | Result |
|---|---|
| **RainViewer** (#2) | VERIFIED earlier (#B3 build): keyless, CORS `*`, 12 past frames + forecast; tile code already in the Pi RADAR page |
| **NWS alerts** (#3) | VERIFIED by daily use: `api.weather.gov/alerts/active?point=` already fetched client-side by the dashboard; polygons ride the same GeoJSON |
| **RTD GTFS-RT** (#6) | VERIFIED keyless: `rtd-denver.com/files/gtfs-rt/VehiclePosition.pb` → 308→307→**200** at `nodejs-prod.rtd-denver.com`. Protobuf; CORS not confirmed → assume **server proxy needed** |
| **Denver live CAD** (#7) | **BLOCKED as imagined**: Denver ODC (1,296 services scanned) publishes **no live police/fire CAD feed**. Nearest neighbor: `IncidentLocations_Public` — an OEM *active emergency incidents* layer (fields: CATEGORY, REPTIME, SEVERITY, GROWTH) that returned **0 rows today**, consistent with "empty when the city is quiet." Plan substitutes this as **OEM ACTIVE INCIDENTS**, exception-based |
| **Denver 311** (#8) | VERIFIED structurally: `ODC_service_requests_311/FeatureServer/66` — Case_Summary/Status, Created_dttm, **Longitude/Latitude**, Agency. **CAVEAT:** OBJECTID-desc sample returned Jan 2026 rows — freshness window must be confirmed with a date-filtered query at build time; if the feed lags weeks, demote to round 2 |
| **FEMA IPAWS** (#13) | VERIFIED keyless: `apps.fema.gov/IPAWSOPEN_EAS_SERVICE/rest/public/recent/<ISO>` → 200, CAP XML with `<polygon>` geometry. Today's sample: weather-only (overlaps #3) — its *distinct* value is AMBER/civil/law-enforcement alerts, which are rare. XML + unknown CORS → **server proxy + CAP parse** |
| **COtrip/CDOT 511** (#14) | **Keyed confirmed**: keyless request → 403 "Not Authorized". Free registration exists; FIRMS precedent (#100) allows keyed-free via server proxy. Registry-of-one |
| **CBI registry** (probe request) | **No dataset exists.** Colorado's Socrata portal: 0 results for the registry; Denver ODC: only `ODC_crimes_incl_sex` (crime *records*, not the registry). CBI's site is search-only. Per our agreed criterion (dataset → build like crime; search-only → scraper → decline): **recommend not building.** Details §6 |

---

## 1. Architecture first: a CityLayer framework (prerequisite, Wave 0)

[CrimeMap.tsx](../../apps/web/src/ui/CrimeMap.tsx) is ~380 lines with **two** inlined layers. Eight more inlined = a 2,000-line file and the exact pattern-drift the fresh-eyes review flagged on the globe. Before any new layer:

**New `apps/web/src/city/` module**, mirroring the globe's proven registry pattern ([layers/registry.ts](../../apps/web/src/layers/registry.ts)):

```ts
interface CityLayerDef<T> {
  id: string; label: string;                    // chip text
  defaultOn: boolean;
  kind: 'points' | 'polygons' | 'tiles';
  // eager: fetch on load (counts for chips/section); open: poll only while modal open
  fetch: { eager?: () => Promise<T>; pollWhileOpenMs?: number };
  project(data: T, view: MercatorView): Projected[];   // shared worldXY math
  renderSvg(p: Projected[], sel: Picked|null): ReactNode;
  detail(item): ReactNode;                      // click-detail strip line
  legend(data: T): ReactNode;
  attribution: string;
  /** exception-based: chip hidden entirely when false (empty = invisible) */
  visible?(data: T): boolean;
}
```

- **`useCityMap` grows a layer-state map** `{[id]: T | 'unavailable' | null}`; per-layer independence is already the law (#122's two-way decoupling generalizes to N).
- **Poll-while-open semantics** (new): live layers (transit, radar, OEM, alerts) poll **only while the modal is open**, with one eager count-fetch at load for the cheap ones. Intervals cleared on close. This keeps the eager-load cost of #123 from multiplying by eight.
- **Chip row curation (the accretion guardrail):** the header cannot hold 10 chips. Design:
  - Chips render only for layers that are **on**, plus exception-based auto-chips (ALERTS/OEM appear only when they have content — the Pi carousel's insertion grammar, ported).
  - One trailing **`⊞ LAYERS`** chip opens a small in-modal drawer listing all city layers with toggles + one-line descriptions — the globe's LayersPanel grammar, familiar.
  - `localStorage('orrery:citymap:layers')` extends per-id (existing key, existing pattern).
- **Unified pick():** iterate enabled layers' projected points; nearest within 10 px wins; `Picked` becomes `{layerId, item}`.
- CrimeMap.tsx → **CityMap.tsx**; CRIME and CAMERAS become the first two `CityLayerDef`s (pure refactor, no behavior change — verified by the existing preview checks before any new layer lands).

**Effort: M** (the refactor is half the round's value — everything after is additive).

---

## 2. The eight layers (owner's package), in build order

### Wave 1 — the "right now" pulse (all furniture-clean)

**L1 · RADAR (#2, RainViewer)** — *"is that storm going to hit me?"*
Latest radar frame as tiles over the mosaic (same `{z}/{x}/{y}` mercator math; tile host verified). Opacity ~0.55, under dots. Poll 10 min while open. Default **on**. Detail: none (it's a field, not points). Legend: "radar · RainViewer · ~10 min". Failure → tiles absent, chip dash. **Effort S** (tile path exists twice already).

**L2 · ALERTS (#3, NWS polygons)** — *"the actual shape of the warning over my block"*
`alerts/active?point=` → GeoJSON polygons (red=warning, amber=watch, fill 0.15, 2px edge). Same fetch the dashboard already makes — lift to shared cache so HAZARDS text and map polygons can't disagree. Poll 3 min while open; eager once for the auto-chip. **Exception-based visibility**: chip exists only when alerts are active. Detail: event, until-time, sender. **Effort S–M**.

**L3 · OEM ACTIVE INCIDENTS (#7-substitute, `IncidentLocations_Public`)** — *"what's the city responding to?"*
Same ArcGIS query pattern as crime (same host, CORS known-good). Fields: INCIDENTNM, CATEGORY, REPTIME, SEVERITY, GROWTH. **Exception-based** (empty today = invisible today). Poll 2 min while open. Detail: name · category · severity · reported-ago. **Effort S**. *Honest caveat: verified structurally but never seen populated — first real incident validates it; note in DECISIONS at build.*

### Wave 2 — the distinctive one

**L4 · LOITER (#1, aircraft loitering near home)** — *"why is that helicopter circling?"*
No new source: the web app's own live feed (`aircraftStore`, civil + mil). Client keeps a ~20-min ring buffer (sample every 20 s) for aircraft within ~15 mi of home; flags **loiter** when path-length/net-displacement ratio and dwell exceed thresholds (tune: >6 min dwell, ratio >4, alt <12k ft — helicopters/survey patterns, not airliners in a hold... which are also interesting; keep them, label differently by altitude band).
- Render: pulsing ring + callsign at the aircraft's position + faint trail from the buffer; click → the existing aircraft card via `handleSelect` (fly-to already wired), detail line shows dwell time + radius.
- **Cold-start honesty:** needs minutes of observation — chip shows `LOITER watching · 4m` until the buffer matures; flags carry "observed 11 min".
- **Four-stage discipline (important):** this is a *display heuristic in furniture*, *not* a detector — no signals, no severities, no analyst. A real loiter detector is a Phase 2 pipeline candidate post-gate; note goes in DECISIONS at build.
- **Effort M.** The only layer whose data is already on the page.

### Wave 3 — live transit

**L5 · TRANSIT (#6, RTD GTFS-RT)** — *"is my bus coming / line disrupted?"*
Verified keyless download; protobuf; CORS unconfirmed → **server proxy**: extend `proxied()` with a **binary→JSON translator** decoding only VehiclePosition + Alert message subsets via a hand-rolled varint decoder (~150 lines, zero new dependencies — consistent with the no-deps taste; `gtfs-realtime-bindings` rejected). Route `/api/proxy/transit`, TTL 30 s.
- Render: vehicle triangles rotated to bearing, colored by route type; viewport-filtered (RTD is metro-wide). Service alerts as a legend badge. Poll 30 s **only while open**. Default **off** (dense; it's a lens you choose).
- Detail: route · direction · next-stop-ish (position feed only; no predictions — honest label "positions, not predictions").
- **Effort M–L** (the decoder). *Server change → deploy = one server container rebuild; soak-safe precedent, but batch it with round-1's single deploy.*

### Wave 4 — civic texture + the fiddly pair

**L6 · 311 (#8, Denver)** — *"what are neighbors reporting?"*
Same ArcGIS pattern; **build-time gate: freshness probe first** (where Case_Created_Date > now-7d). If fresh: last-7d points, category-colored, default **off**, daily cache. Detail: summary · status · agency · ago. **Effort S–M**. If stale → demote to round 2, tell the owner.

**L7 · EMERGENCY (#13, IPAWS)** — *"AMBER / civil alerts here, now"*
Verified keyless CAP XML with polygons. **Scope strictly to non-weather events** (AMBER, Civil Danger/Emergency, LEW, 911 outage, evacuation, shelter, hazmat) — weather stays L2's job, so the two never double-draw. Server proxy (`/api/proxy/ipaws`, TTL 2 min) + minimal CAP parse (identifier/event/polygon/area/expires; server-side, XML→JSON). Exception-based chip (these are rare — expect it invisible for weeks). Detail: event · headline · expires. **Effort M**.

**L8 · TRAFFIC (#14, COtrip)** — *"is my route a mess?"*
**Owner action required: free COtrip account + API key** → `.env` (`COTRIP_API_KEY`), FIRMS precedent (#100): key server-side only, `/api/proxy/traffic`, TTL 2 min, stale-serve. Incidents + closures as points/short segments, severity-colored. Default **on** (it's the classic "what's happening around me"). Detail: type · road · description · started-ago. **Effort M**. *The one layer that can't be built until the key exists.*

---

## 3. Cross-cutting decisions

- **Defaults after round 1:** on = CRIME, CAMERAS, RADAR, TRAFFIC; auto/exception = ALERTS, OEM, EMERGENCY, LOITER (appears when flagged); off = TRANSIT, 311. Worst-case default chip row: ~5 chips + `⊞` — fits.
- **Detail strip + legend** become per-layer renderers (framework); attribution line composes from enabled layers only.
- **Perf:** point layers are all <1k SVG nodes viewport-filtered; radar adds ≤8 imgs; transit decoded server-side. No new client deps anywhere in the round.
- **Server surface added:** three `proxied()` routes (transit, ipaws, traffic) — read-only, cached, stale-serving; one deploy batch at round end (single server rebuild, soak-safe pattern).
- **Pi:** none of round 1 touches the panel (LOITER as a Pi page is tempting but is round-2 discussion at most).

## 4. Sequencing & verification

```
W0 framework refactor  → preview: CRIME+CAMERAS pixel-identical, toggles/pick/detail unchanged
W1 radar+alerts+OEM    → preview vs RainViewer site; synthetic alert fixture; OEM structural
W2 loiter              → fixture: synthetic ring-buffer tracks (circling vs transiting vs holding);
                          live soak-watch for first real flag
W3 transit             → decoder unit-tests against a captured .pb; live positions sanity vs RTD map
W4 311(gated)+ipaws+traffic(gated on key)
                       → freshness probe; CAP fixture (AMBER sample from IPAWS archive); key smoke
DEPLOY                 → one webdist rsync + one server rebuild, owner-called (#120 pattern)
```
Each wave: typecheck, build, preview verification with screenshots, failure-path forced once (the #122 lesson — every layer's 'unavailable' state gets *seen*, not assumed).

**Gate note:** build-only until the Jul 30 gate unless the owner calls an earlier deploy at wave review, same as every round since #120.

## 5. Round 2 parking lot (unchanged by this plan)
Wildfire/evac (#4), earthquakes (#5), wildlife (#9), flood gauges (#10), storm reports (#11), air sensors (#12), DOT cameras (#15) — plus the registry decision below.

## 6. Registry: probe verdict and recommendation

The deciding question was *"does Colorado publish the registry as a dataset?"* **Answer: no.** State Socrata portal: zero registry datasets; Denver ODC: none (only crime records); CBI is a search-only web app. Per the criterion we agreed *before* the probe: dataset → build it like crime; search-only → scraper → **don't build it**. The recommendation is therefore **decline on fragility grounds** — a per-county scraper would be ORRERY's only perpetually-breaking layer, its only ToS-gray source, and its only layer where staleness mislabels a *specific house*. The ethics discussion is settled (private observation tool — owner's framing accepted); this is purely an engineering verdict. If CBI ever ships a dataset, it becomes a routine registry-of-one build and goes straight into a future round.

## 7. Risks
- **OEM layer unproven-when-populated** (structurally verified only) — first real incident is the test.
- **311 freshness unknown** — gated, with an explicit demotion path.
- **RTD CORS/redirect chain** may change — proxy isolates the client; stale-serve covers blips.
- **Chip-row growth** is the design risk this plan exists to prevent — the drawer + exception-visibility rules are load-bearing, not cosmetic.
- **IPAWS ToS/uptime** — public REST verified today, but it's FEMA infrastructure; degrade-to-absence like everything else.
