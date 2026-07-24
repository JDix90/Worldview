# ORRERY — product design review
**2026-07-24 · review only, no code changed · prompted by: thin detail cards (crime especially) + globe/city control inconsistency**

Method: every UI surface read in code (`apps/web/src/ui/*`, `city/*`), both views exercised live in the
local preview (desktop + forced-390px mobile), the Denver crime upstream re-probed for unfetched fields,
and the existing design history honored (DECISIONS #109, #114, #123 — this app has already learned, twice,
that burying or mislabeling a surface loses it; several findings below are that same lesson in new places).

The aesthetic itself — dark mono instrument, cyan accent, exception-based visibility, honesty labels —
is coherent, distinctive, and worth protecting. Nothing here proposes softening it. The findings are
about *consistency, discoverability, and depth*, not style.

---

## 1 · The two views are two different applications (P0)

The owner's report — "toggles and controls completely change location and styling between views" — is
accurate, and it goes deeper than location:

| Concern | GLOBE view | CITY view |
|---|---|---|
| Where controls live | bottom-right vertical chip cluster | top-left horizontal bar |
| Layer toggles | `LAYERS 13/21 ›` chip → bottom-right panel | inline chips in top bar + `⊞` → top-**left** drawer |
| Toggle idiom | ◉/○ rows in a panel | ◉/○ rows in a drawer *and* bordered chips that toggle on click |
| Chip anatomy | fixed 132px, label left / state right / `›` chevron | variable width, label+count inline, no chevron |
| Entering the other view | `CITY ›` chip, bottom-right | `‹ GLOBE`, top-left |
| Escape | closes nothing (except search) | clears selection, then exits |
| Font/padding | 11px / 4px 10px | 10px / 3px 8px (12px/7px 11px on mobile) |
| Detail surface | card, bottom-left | card, bottom-left ✓ (the one aligned pattern) |
| A third idiom | FEED panel uses underline *tabs* (signals/journal/briefing) | — |

Any one difference is defensible. The sum means a user's spatial memory transfers **nothing** between
views: you leave via bottom-right and come back via top-left; "layers" is a chip-with-chevron in one
world and a `⊞` glyph in the other; the same ◉/○ rows live in opposite corners.

**Recommendation — one navigation grammar, two contents:**

1. **The cluster is the constant.** Keep the bottom-right chip cluster present in *both* views, same
   position, same `Chip` component, same width. In CITY it re-contents rather than disappears:
   - `GLOBE ‹` (an `opens`-style chip, chevron pointing *back*) replaces the `CITY ›` chip — exit lives
     exactly where entry lived, the strongest possible "same place, inverse action" signal.
   - `LAYERS n/m ›` stays, opening the city layer drawer (restyled as the same bottom-right panel as the
     globe's). One word, one place, one panel anatomy for "what's drawn."
   - FEED / HOME / LOCATION can stay functional (they're view-independent surfaces; HOME/FEED panels
     already render fine over any background). SPIN and SCREEN — globe-specific and appliance-specific —
     hide, exactly as chips already hide while a panel is open (existing precedent, #109).
2. **The top bar becomes CITY-specific status, not navigation**: title, active-layer chips (as *status*
   pills with counts — clicking still toggles, fine), scale/zoom. `‹ GLOBE` may stay top-left as a
   *secondary* affordance (map apps train "back at top-left"), but the canonical one lives in the cluster.
3. **Unify chip anatomy**: one font size, one padding, one border grammar (`opens` = chevron + brighter
   border; toggle = state word on the right) across both views. The `btn()` helper in CityMap.tsx and
   `Chip.tsx` should be one component with a `compact` variant, not two hand-rolled cousins.
4. **Unify Escape**: layered dismissal everywhere — Escape closes the topmost thing (card → drawer/panel
   → view). Today it does the layered thing in CITY and nearly nothing on the globe (panels close only
   via ✕). Cheap fix, big coherence gain.

---

## 2 · Detail cards are one-liners in a surface that earned more (P0)

The #129 card gave details a proper stage; the *content* is still the single line written for the old
656px strip. Every layer's `detail()` is one `<span>` with ` · ` separators (crimeLayer.tsx:69-81 and
siblings). Meanwhile the app already owns a better idiom: **AircraftCard's label-column rows**
(AircraftCard.tsx:32-39) — `LABEL      value` pairs, scannable, information-dense.

**Crime specifically** — the current card shows type · block · reported-ago · stack count. The upstream
publishes (re-probed live today, same endpoint):

| Field | Value for the card |
|---|---|
| `FIRST_OCCURRENCE_DATE` | **when it happened** — today's card shows only when it was *reported*, which can lag days; "occurred Sat ~9pm · reported 6d ago" is a materially different fact |
| `LAST_OCCURRENCE_DATE` | occurred-range for spanning offenses ("overnight Fri–Sat") |
| `NEIGHBORHOOD_ID` | "five-points" → Five Points — locates a block-anonymized address far better than the street number alone |
| `OFFENSE_CATEGORY_ID` | the *category* (currently only encoded as dot color — never named in the card) |
| `VICTIM_COUNT` | shown only when > 1; worth having |
| `DISTRICT_ID` / `PRECINCT_ID` | probably skip — jargon without a map overlay |

Fetching three more `outFields` costs nothing (same row count, same request).

**Proposed crime card** (structure, not final copy):

```
● CRIME · PROPERTY                                  ✕
THEFT OF MOTOR VEHICLE
occurred    Sat Jul 19, ~9 PM (overnight)
reported    6d ago
block       2900 N Sheridan Blvd · Five Points
nearby      3 more at this block, 7d ▸
```

- Header names the **group** (violent/property/other) — the color finally gets a word. Type is promoted
  to a title line instead of being the whole card.
- `nearby … ▸` is the existing stacked-count made *actionable*: tap to cycle through the stacked
  incidents (the card already has the full array in scope — `detail(item, d)`).
- Same treatment pattern for the other layers, each with fields already fetched but unshown: ALERTS has
  `headline` (dropped today, it's the most human field NWS sends); TRANSIT can name the route long-name
  (GTFS static route names are a candidate, but even "route 15 · bus · position 4s old · heading NE"
  uses fields in hand); 311 has `Case_Summary` + status + agency (already shown — needs only re-layout);
  LOITER's `⤓ fly` button is exactly the right kind of card action and should survive the redesign.
- **Card API**: extend `CityLayerDef` with an optional `detailRows?: (item, data) => Array<{label, value}>`
  alongside `detail` — layers migrate one at a time, the card renders rows when present and falls back
  to the line. No breaking change, and the framework (not each layer) owns the card look.

---

## 3 · Findings by surface (P1 unless noted)

**Find-a-flight is invisible.** `/` is the only way in (FlightSearch.tsx:2-8) — no button, no hint
anywhere in the UI, and **no touch path at all**. An expert feature gated behind an undocumented
keystroke repeats the #114 discoverability failure. Recommend: a small `⌕` chip in the cluster (opens
the same input; shows the `/` hint in its placeholder), which also gives touch users their first way in.

**Two things are both called LAYERS.** Globe layers (flights, rain, borders…) and city layers (crime,
radar…) are disjoint sets with the same name. Within the unified cluster (finding 1), the label can
stay LAYERS in both views *because* the view scopes it — but the panel header should say which
("GLOBE LAYERS" / "CITY LAYERS") so the drawer itself is self-describing.

**The city bottom bar is doing four jobs in 9–10px type**: hint, legend, footprint honesty, scale +
zoom + attribution. On mobile it stacks five rows deep (verified at 390px) and collides with the +/−
controls' thumb zone. Recommend: attribution + scale stay; the *legend* moves into the layer chips
themselves (each chip already carries color + count — the separate legend row mostly duplicates it);
per-layer freshness ("radar · 4m old") moves into the ⊞ drawer rows; the footprint note appears once,
then collapses to `±8 mi ⓘ`.

**Empty-state hint never retires.** "click an icon for details" shows forever for a returning user.
Show it until the first successful pick (persist a flag), then drop it.

**Cold-load feedback is a bare `…`.** Crime took >10s on a cold load during this review with only the
chip's `…` changing. The dashboard already has the right sentence pattern; the map should say
"crime: loading (Denver Open Data)…" in the card slot for the slowest still-pending layer, or at
minimum pulse the loading chips.

**No hover state on any control** (grep: zero hover styles outside the map cursor work). The map dots
just earned cursor feedback; chips, drawer rows, ✕ buttons, and tabs still give none. One shared
`:hover` treatment (border brightens — the grammar the `opens` variant already uses statically) would
make every clickable read as clickable. Related: `title` tooltips carry real information (chip
descriptions, gate review) that touch users can never see — the ⊞ drawer's visible descriptions are
the right pattern; nothing essential should live only in `title`.

**Globe cards vs city cards.** AircraftCard/ObjectCard sit bottom-left with cyan borders; the city
card sits bottom-left with *layer-accent* borders. Good — same place, same anatomy. When crime rows
land (finding 2), use the same `row()` layout as AircraftCard so all four card types read as one family.

---

## 4 · Cross-cutting (P2 — schedule, don't sprint)

- **Accessibility is at zero.** One `aria-label` in the codebase (dashViz.tsx:313); every control is a
  click-only `<span>`/`<div>` — no `role="button"`, no `tabIndex`, no focus rings, no keyboard path to
  chips/panels/toggles; dim text at opacity 0.4–0.55 on near-black is far below WCAG AA. For a
  single-user personal instrument this is a deliberate trade, but the floor worth reaching anyway:
  real `<button>` semantics on the ~10 shared controls (Chip, ✕, tabs, drawer rows), visible focus,
  and bumping the dimmest *informational* text (opacity ≥ 0.65). Screen-reader depth can wait.
- **Touch targets in the globe cluster** are ~23px tall (11px font + 4px padding); CITY's mobile
  chrome already got the 40px+ treatment — port those paddings back into `Chip` for narrow viewports
  when the cluster becomes shared (finding 1 makes this automatic).
- **Type scale is 9/10/11px fixed.** Fine as an instrument idiom on desktop; on mobile, 12px should be
  the floor (CITY's `narrow` styles already do this — again, unify rather than invent).
- **Color semantics are consistent but undocumented.** Red = violent/closure/extreme, amber =
  property/warning/MIL, cyan = interactive, green = go/rail-ok. Worth a 20-line `tokens.ts` (colors +
  the two font sizes + panel/border styles) so the next surface can't drift — the `PANEL`/`EDGE`/`btn()`
  constants in CityMap.tsx are that file waiting to exist.
- **Gesture discoverability**: double-tap-to-zoom is undiscoverable (fine — it's a bonus path), but
  pinch on *desktop trackpads* (ctrl+wheel) deserves a one-line mention in the ⊞ drawer or a first-open
  toast, since nothing on screen implies the map zooms continuously.

## 5 · Priority order

| # | Item | Size | Wins |
|---|---|---|---|
| 1 | Shared bottom-right cluster in CITY (`GLOBE ‹`, LAYERS, FEED/HOME/LOCATION); Escape unification | M | kills the P0 disorientation |
| 2 | Card rows API + crime card (3 new outFields, occurred-vs-reported, neighborhood, group name, stacked-cycle) | M | the P0 content gap, template for all layers |
| 3 | One Chip component both views; hover states everywhere; `⌕` search chip | S–M | coherence + discoverability + first touch path to search |
| 4 | Bottom-bar diet (legend→chips, freshness→drawer, footprint→ⓘ); retire-able hint; named loading states | S | mobile clarity |
| 5 | tokens.ts; button semantics + focus on shared controls; mobile paddings in Chip | S | stops future drift, a11y floor |

Items 1–3 are the owner's two asks plus their direct dependency. 4–5 are the follow-through that keeps
the next eight layers from re-fragmenting the system.
