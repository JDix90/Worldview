# ORRERY — soak check-in, 2026-07-31

**Repository-only review.** The instrument is on the LAN (`orrery.local`); this pass had no route to
it, so nothing below is a live reading. Every number that closes the gate lives on the Pi behind
`/api/stats/gate`, `/api/stats/learning`, `/api/shadow-log` and `/api/analyst/usage`. What follows is
what the repository can establish on its own, plus what it says is owed. The last live snapshot on
record is the 2026-07-24 comprehensive review (`~02:30Z 07-25`).

---

## 1 · Four clocks, not one

The check-in question — *"the 7-day soak to determine what is standard should have ended on the
27th"* — collapses two separate clocks that expire on different dates and answer different
questions. Separating them is the main finding of this pass.

| # | Clock | What it establishes | Started | Due | State |
|---|---|---|---|---|---|
| 1 | **7 consecutive unattended briefings** (Chunk 6 DoD) | that the analyst runs itself | 07-21 (day 1, restarted per #93) | **07-27** | unverified — needs `/api/stats/gate` |
| 2 | **Baseline maturity** (`packages/shared/src/baseline.ts`) | **what is standard** | 07-15 | **~08-04** | **partial — cannot have finished** |
| 3 | **14-day Go/No-Go soak** (Chunk 7, FOUNDATION §11) | whether ORRERY continues | 07-16 | **~07-30** | **checkpoint passed, no verdict written** |
| 4 | **≥7-day shadow minimum** before `PUSH_ENABLED` | whether an S1 is worth an interrupt | 07-16 | inside #3 | **n=1** |

**The 7-day clock that ended on the 27th is clock 1, the briefing streak.** It is a liveness check on
the analyst — seven consecutive days filed unattended — not a measurement of normality. It restarted
at 07-21 because 07-17 and 07-19 were paid for and permanently lost (#93, #116), which left it with
**zero slack** against the ~07-30 gate. As of the last live reading (07-24 evening) it stood at
**5 of 7**. Whether 07-25, 07-26 and 07-27 filed clean is the single most load-bearing unknown in
this document.

**"What is standard" is clock 2, and it is not a 7-day quantity.** Baselines are median/MAD per
cell × hour × daytype over a rolling **28-day** window, and `maturityOf()` calls a bin `mature` only
at ≥75% of the days that could appear in it — **15 of 20 weekdays, 6 of 8 weekend days**. Collection
began 07-15. Counting calendar days since:

```
weekdays observed   13 / 20  =  65%   → partial
weekend days        4 / 8    =  50%   → partial
earliest weekend bin can read mature   2026-08-02
earliest weekday bin can read mature   2026-08-04
```

Those two dates are **ceilings, not estimates** — a bin only counts a day if that cell had data in
that hour on that day, so real maturity lands later and unevenly. The 07-24 review measured it
directly: `mature: 0, partial: 19321`. **Zero mature bins after ten days.**

So the honest answer to the check-in question: **no, the soak did not determine what is standard by
the 27th, and it structurally could not have.** The 28-day window makes early August the first date
any bin can speak with authority. This is not a slip — it is the design working as written — but it
does mean any judgment made this week about detector quality rests on provisional medians, and the
system has been saying so in its own briefings every night.

---

## 2 · The repository has been silent since 07-25

Last commit **c941a79, 2026-07-25 03:59Z** (DECISIONS #138). Four PRs, all merged 07-24/25. No open
issues, no branches beyond `main` and two merged edge branches.

**Six days unrecorded — and that gap contains both deadlines**: the streak completion (07-27) and the
gate checkpoint (07-30). Chunk 7's definition of done is explicit: *"the gate has a written yes/no per
question in DECISIONS.md, and push is enabled only if the shadow log earned it."* DECISIONS ends at
#138. **There is no gate entry.** The DoD is open.

---

## 3 · The gate, read against FOUNDATION §11

The instrument's own GATE tool is the intended grader, and the 07-24 review found it candid:

**Q1 — surfaced something genuinely informative?** The tool said *"not yet — no S1 survived triage as
unexplained; the instrument has been correctly quiet."* The review leaned **weak-yes**, carried by the
recurring GPS-interference reads (Baltic 59%, Black Sea 26%, Persian Gulf 43%) cross-referenced to
real reporting — real, but arguably something a geopolitically-aware owner half-expects.

**Q2 — opened voluntarily on quiet days?** **Un-instrumented by choice.** Only the owner can answer.
The review's P2 #10 ("a last-opened counter so Q2 is answerable next window") was not built, so it
will be equally unanswerable next time unless that changes.

**Q3 — was the shadow S1 log worth being interrupted for?** **This is the leg that does not hold.**
The log is still **n=1** — RPA4359, persistent 7500, 2026-07-16, *untriaged, no assessment attached*.
Zero S1 candidates have fired since, because the #52 corroboration bar correctly holds single-network
7500s at S2. You cannot grade "worth being interrupted for" from one row.

The structural point worth stating plainly: **Q3 does not get better by waiting.** It is unanswerable
*because the corroboration bar is working* and the world has been quiet. Running another two weeks
produces another n=1 unless something real happens. So the choice is not "extend or decide" — it is:

- **grade Q1 and Q2 now and defer Q3 explicitly**, with the reason recorded (the bar works; the world
  was quiet; n=1 is not gradeable), or
- **extend with a stated stopping rule** — e.g. "decide at the first S1, or 08-15, whichever comes
  first" — so the window has an end that isn't just drift.

Either closes the DoD. Silence does not. The 07-24 review's own recommendation was to treat ~07-30 as
*"decide whether there's enough to decide"* — that meta-decision is what is now overdue.

---

## 4 · A week-old worker and panel, with the P0 fix on the shelf

The browser is current — #132/#133 (CITY v2, design system) and #137 a–c (roster trimmed to
**7/17**) all deployed and verified live. **The worker and the Pi panel are not.**

| Staged, undeployed | Since | Gate-relevant? |
|---|---|---|
| **(#137 d) D1 `traffic_collapse` held to S3 while its baseline is immature** | 07-25 | **Yes — this is the P0** |
| (#137 e) `ANALYST_TRIAGE_PER_DAY` 10→5 | 07-25 | cost only |
| #134–#136 Pi: local/instrument red split, carousel re-scope, HAZARDS inserts | 07-25 | no (panel UX) |
| #138 Pi: TRAFFIC insert, NEARBY-signals nearest-first, ellipsis pass | 07-25 | no (panel UX) |

The D1 hold matters because of what it was fixing: with baselines at 0% mature, D1 was firing
ocean-cell "collapses" (`S40E175` 5-vs-24, `N20E115` 16-vs-37) that the analyst triaged to *"noise
(75%)"* and the briefing explained away nightly. **The S2 feed is the tier a viewer is trained to
look at, and it has been mostly diurnal artifact for the entire back half of the soak.** The review
asked for this to land *before* the window closed so the gate reviewer would skim signal rather than
artifact. It did not land. Whatever Q1 judgment gets made now is being made against the noisy feed.

Everything is verified and ready — typecheck 4/4, `verify:detectors` 23/23, pager `--selftest` 61
ALL PASS across 12 fixtures rendered off-device. Both deploys are owner-gated restarts by policy
(#114/#120), not blocked work. The `orrery-display` unit is separate from the worker and Postgres, so
the panel deploy carries no data-continuity risk at all.

One trap in the cost change: `env.ts` now defaults `ANALYST_WEB_SEARCHES_PER_DAY=4`, but its own
comment records that **the appliance `.env` overrides it to 10**. Deploying the worker without
editing the Pi's `.env` lands the triage cut and misses the search cut.

---

## 5 · Owed before `PUSH_ENABLED` can flip

These are not gate questions — they are the conditions the repository says must hold *before* the
flag moves, whichever way the gate goes.

1. **An end-to-end ntfy delivery test (#117).** Every ops alert had been dying silently on an em dash
   in the HTTP title — including the collector-silent alarm that fired during the 07-22 OpenSky
   outage and reached nobody. Fixed centrally in `notify.ts` and unit-verified, **but the delivery
   path has still never been observed to succeed against the real topic.** The S1 push title carries
   the same dash: shadow mode would have failed the moment the flag flipped. #117's own lesson —
   *"a safety mechanism that has never been observed to fire is not a safety mechanism"* — is
   unretired until someone watches a real notification arrive on a real phone.
2. **A FOUNDATION §4 amendment for overnight deferral.** The owner's ruling was recorded in #137 —
   *"2am? No, save it for the morning"* — a persistent-7500-class S1 is not worth a night interrupt.
   Recorded, not built. The constitution requires the amendment be made **before** the flag flips.
3. **ntfy topic rotation** (plan §4 C2). The topic grants read *and* post to anyone who learns it,
   and post-gate it carries S1 anomaly content rather than only power events. Cheap now.

## 6 · Other open items, unchanged since 07-24

- **H4 UPS drill** — still ⏳, deferred until the cells charge past 50% (they arrived at 0%).
- **PLD GPIO pin** — `pinctrl get 6` has still not been confirmed to follow AC. A false shutdown ends
  the soak; the code still says it is unverified.
- **Review P1 #3, the outage-vs-quiet sentinel** — a silent NWS/IPAWS/OEM fetch failure still renders
  identically to "nothing near you" on the safety layers. Open.
- **Review P1 #4/#6** — the Pi's quiet-day void and HOME burying its best signals below a ~78vh
  scroll. Open.

---

## 7 · What to pull first

In order, because each answer changes the next question:

1. **FEED → GATE, or `GET /api/stats/gate`.** Did 07-25, 07-26 and 07-27 file clean? Is
   `streak.current ≥ 7`? Any new entries in `gaps`? **This settles clock 1 and it is the only thing
   that can.**
2. **`GET /api/stats/learning`.** Confirm `mature` is still 0 and watch `partial` climb — this is
   clock 2, and it says early August in the arithmetic above.
3. **`GET /api/shadow-log`.** Still n=1, or did the quiet break?
4. **`GET /api/analyst/usage`** — MTD against the $10 breaker (was $4.42 at ~$0.28/day on 07-24).
5. **`GET /api/health/upstreams`** — one derived verdict; confirms the collector never went silent
   the way it did on 07-22.

## 8 · Recommendation

**Deploy the staged worker fix, then grade Q1/Q2 and defer Q3 with its reason written down.**

The D1 hold has been ready for six days and its absence is actively degrading the evidence the gate
is read from; that is the one change worth a restart before anything is graded. Then write the
DECISIONS entry — a yes, a yes, and an explicit *"deferred, n=1, because the corroboration bar is
working and the world was quiet"* is a complete and honest answer to Chunk 7's DoD. What is not
acceptable under the project's own rules is the current state: a checkpoint passed in silence, with
the constitution's one gate unanswered.

And separately, in the record: **the baselines were never going to be mature by the 27th.** If
"determine what is standard" was the intent of the soak rather than the briefing-liveness check, then
the real date is **~08-04**, and the gate as designed does not actually depend on it.
