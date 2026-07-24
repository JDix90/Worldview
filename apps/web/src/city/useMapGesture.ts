/**
 * CITY map gesture engine (#127) — drag-to-pan, pinch/wheel/double-tap zoom.
 *
 * ONE pointer pipeline. Every input arrives as a PointerEvent and lands in the
 * same `pointers` map, so mouse and touch cannot drift apart: one finger and a
 * held mouse button are the same code, and pinch is just the two-pointer case
 * of the same centroid/spread math. There is no hover-dependent affordance
 * anywhere in here — the map is fully drivable by touch alone.
 *
 * The performance contract (measured before this was built, #127): a React
 * re-render that re-projects the worst-case layer set (~2700 points) costs
 * 35-43ms, but a CSS transform of the wrapper costs 0.1ms. So a gesture MUST
 * NOT re-render React. Instead:
 *
 *   committed view  — React state; what the layers were last projected with
 *   live view       — a ref, moved by every pointer event
 *   pane transform  — written straight to .style, and is *exactly* the
 *                     geometric difference between the two
 *
 * Because the transform IS the difference, committing (live → React state)
 * collapses it to identity in the same frame: no flash, no seam, no snap. The
 * gesture stays at 0.1ms/frame no matter how many points are on screen, and
 * the ~20-40ms re-projection happens only when the user stops moving (or on
 * the guards below, so tiles never run dry mid-drag).
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { TILE, type MercatorView } from './registry';

/** The part of a view a gesture can change. */
export interface ViewCore {
  z: number;
  originX: number;
  originY: number;
}

/** Drag past this much of the tile pad and we re-project mid-gesture. */
const COMMIT_PAN_PX = 192;
/** Half a zoom level of CSS-scaled tiles is as blurry as we let it get. */
const COMMIT_ZOOM_LEVELS = 0.5;
/** Pointer travel still counted as a tap, not a drag. Fingers wobble; mice don't. */
const TAP_SLOP_MOUSE = 6; // matches GlobeView's CLICK_SLOP_PX
const TAP_SLOP_TOUCH = 10;
const TAP_MAX_MS = 350;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 30;
/** Inertia: velocity decays by 1/e every TAU ms. Time-based, not per-frame, so
 *  the glide is identical on a 60Hz and a 120Hz screen. */
const FRICTION_TAU_MS = 120;
const MIN_FLING_PX_PER_MS = 0.05;
const STOP_PX_PER_MS = 0.015;
/** Trackpad pinch (ctrl+wheel) reports much smaller deltas than a mouse notch. */
const WHEEL_ZOOM_PER_PX = 0.0022;
const PINCH_WHEEL_ZOOM_PER_PX = 0.01;
const WHEEL_SETTLE_MS = 140;

interface Opts {
  /** The committed view — projection source of truth for every layer. */
  view: MercatorView;
  minZ: number;
  maxZ: number;
  /** Re-project: the live view has moved far enough (or settled) to matter. */
  onCommit: (v: ViewCore) => void;
  /** A tap that wasn't a drag. Coords are surface-relative px; `live` is the
   *  view at tap time (may be uncommitted mid-animation, so picking must use
   *  it, not the committed React state). */
  onTap: (x: number, y: number, touch: boolean, live: ViewCore) => void;
  /** True if (x, y) sits on a clickable icon — drives the hover cursor so a
   *  mouse gets pointer feedback the touch model doesn't need. Tested against
   *  the committed view, so it's only consulted while the map is settled. */
  onHoverTest?: (x: number, y: number) => boolean;
  enabled: boolean;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

export function useMapGesture({ view, minZ, maxZ, onCommit, onTap, onHoverTest, enabled }: Opts) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);

  // Committed view, readable from event handlers without re-subscribing.
  const committedRef = useRef<ViewCore>(view);
  const liveRef = useRef<ViewCore>({ ...view });
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onHoverTestRef = useRef(onHoverTest);
  onHoverTestRef.current = onHoverTest;
  const hoveringRef = useRef(false); // last hover-cursor state, to avoid redundant writes
  const boundsRef = useRef({ minZ, maxZ });
  boundsRef.current = { minZ, maxZ };

  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const prevRef = useRef<{ cx: number; cy: number; spread: number } | null>(null);
  const busyRef = useRef(false); // gesture or animation in flight
  const rafRef = useRef(0);
  const travelRef = useRef(0);
  const downRef = useRef<{ t: number; x: number; y: number; touch: boolean } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const samplesRef = useRef<Sample[]>([]);
  const wheelTimerRef = useRef(0);

  // ── the transform: live view expressed relative to the committed one ─────
  const paint = useCallback(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const c = committedRef.current;
    const l = liveRef.current;
    const s = 2 ** (l.z - c.z);
    // toPx_live(X) = s * toPx_committed(X) + t   (transform-origin: 0 0)
    const tx = s * c.originX - l.originX;
    const ty = s * c.originY - l.originY;
    pane.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }, []);

  // A commit is IN FLIGHT from the moment we hand React a new view until that
  // view has actually rendered (the layout effect below acknowledges it).
  const pendingCommitRef = useRef(false);

  // The one thing commit() must NOT do is touch committedRef or the transform:
  // setCore's re-render lands 1-3 frames later (the ~20-40ms re-projection),
  // and collapsing the transform to identity before the new SVG exists shows
  // the OLD projection un-transformed — the map snaps back by the whole
  // gesture delta, then snaps forward when React catches up. That double-jump
  // on every mid-gesture commit was the "jumpy pan/zoom" the owner filmed
  // (frame-diff spikes in pairs, ~3 frames apart). The transform is instead
  // collapsed in the layout effect, synchronously with the new projection.
  const commit = useCallback(() => {
    const l = liveRef.current;
    const c = committedRef.current;
    // Nothing moved since the last commit (e.g. the wheel settle timer firing
    // after a mid-gesture commit already landed): skip. Committing identical
    // values would set pending but never run the layout effect (same deps),
    // wedging pending=true and silencing every future mid-gesture commit.
    if (l.z === c.z && l.originX === c.originX && l.originY === c.originY) {
      pendingCommitRef.current = false;
      return;
    }
    pendingCommitRef.current = true;
    onCommitRef.current({ ...l });
  }, []);

  /** Commit mid-gesture once the pane has strayed far enough to show seams.
   *  Skipped while a previous commit hasn't rendered yet — re-committing
   *  sooner just queues extra 40ms renders and buys nothing. */
  const maybeCommit = useCallback(() => {
    if (pendingCommitRef.current) return;
    const c = committedRef.current;
    const l = liveRef.current;
    const s = 2 ** (l.z - c.z);
    if (Math.abs(Math.log2(s)) > COMMIT_ZOOM_LEVELS) return commit();
    if (Math.abs(s * c.originX - l.originX) > COMMIT_PAN_PX) return commit();
    if (Math.abs(s * c.originY - l.originY) > COMMIT_PAN_PX) return commit();
  }, [commit]);

  // ── live-view mutation ───────────────────────────────────────────────────
  const panBy = useCallback((dx: number, dy: number) => {
    liveRef.current.originX -= dx;
    liveRef.current.originY -= dy;
  }, []);

  /** Zoom by `ratio` while holding the world point under (ax, ay) still. */
  const zoomBy = useCallback((ratio: number, ax: number, ay: number) => {
    const l = liveRef.current;
    const { minZ: lo, maxZ: hi } = boundsRef.current;
    const z = Math.min(hi, Math.max(lo, l.z + Math.log2(ratio)));
    const r = 2 ** (z - l.z); // clamped ratio, so the anchor stays exact
    l.originX = r * (l.originX + ax) - ax;
    l.originY = r * (l.originY + ay) - ay;
    l.z = z;
  }, []);

  const stopAnimation = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  // ── inertia ──────────────────────────────────────────────────────────────
  const fling = useCallback(
    (vx: number, vy: number) => {
      let last = performance.now();
      const step = () => {
        const now = performance.now();
        const dt = Math.min(48, now - last); // a backgrounded tab must not teleport
        last = now;
        panBy(vx * dt, vy * dt);
        const decay = Math.exp(-dt / FRICTION_TAU_MS);
        vx *= decay;
        vy *= decay;
        paint();
        maybeCommit();
        if (Math.hypot(vx, vy) < STOP_PX_PER_MS) {
          rafRef.current = 0;
          busyRef.current = false;
          commit();
          return;
        }
        rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [panBy, paint, maybeCommit, commit],
  );

  /** Ease the live view to a target and commit. Used by recenter and double-tap. */
  const animateTo = useCallback(
    (target: ViewCore, ms = 260) => {
      stopAnimation();
      busyRef.current = true;
      const from = { ...liveRef.current };
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const e = 1 - (1 - k) ** 3; // ease-out cubic
        liveRef.current = {
          z: from.z + (target.z - from.z) * e,
          originX: from.originX + (target.originX - from.originX) * e,
          originY: from.originY + (target.originY - from.originY) * e,
        };
        paint();
        if (k < 1) {
          rafRef.current = requestAnimationFrame(step);
          maybeCommit();
        } else {
          rafRef.current = 0;
          busyRef.current = false;
          commit();
        }
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [stopAnimation, paint, maybeCommit, commit],
  );

  /** Zoom about the viewport centre — for on-screen +/- controls. */
  const zoomAboutCentre = useCallback(
    (dz: number, w: number, h: number) => {
      const before = { ...liveRef.current };
      zoomBy(2 ** dz, w / 2, h / 2);
      const target = { ...liveRef.current };
      liveRef.current = before;
      animateTo(target, 180);
    },
    [zoomBy, animateTo],
  );

  // The other half of commit(): the moment React has re-rendered the layers
  // with a new view, adopt it as the committed baseline and repaint the
  // transform — LAYOUT effect, so both happen before the browser paints and
  // the transform reaches identity in the same painted frame as the new
  // projection (a plain effect runs after paint: one frame of new SVG under
  // the old transform — a flash in the other direction).
  // External view changes (resize, recenter, first open) also land here and
  // re-seed the live view; our own commits must NOT re-seed mid-gesture
  // (busyRef) — the finger has moved on since the commit was cut.
  useLayoutEffect(() => {
    committedRef.current = { z: view.z, originX: view.originX, originY: view.originY };
    pendingCommitRef.current = false;
    if (!busyRef.current) {
      liveRef.current = { z: view.z, originX: view.originX, originY: view.originY };
    }
    paint();
  }, [view.z, view.originX, view.originY, paint]);

  // ── the pointer pipeline ─────────────────────────────────────────────────
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !enabled) return;
    surface.style.cursor = 'grab'; // hook owns the cursor from here (hover → pointer)

    const localOf = (e: { clientX: number; clientY: number }) => {
      const r = surface.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    /** Centroid + mean spread of every active pointer. */
    const centroid = () => {
      const pts = [...pointersRef.current.values()];
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      const spread = pts.length < 2 ? 0 : pts.reduce((a, p) => a + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length;
      return { cx, cy, spread };
    };

    /** Point/grab cursor by whether (x, y) sits on a clickable icon (mouse only
     *  — touch has no cursor). Skipped while animating, since the hit-test uses
     *  the committed view. */
    const updateHoverCursor = (x: number, y: number) => {
      const hit = !busyRef.current && !!onHoverTestRef.current?.(x, y);
      if (hit === hoveringRef.current) return;
      hoveringRef.current = hit;
      surface.style.cursor = hit ? 'pointer' : 'grab';
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== undefined && e.button > 0) return; // right/middle click isn't a pan
      surface.setPointerCapture(e.pointerId);
      const p = localOf(e);
      if (pointersRef.current.size === 0) {
        stopAnimation();
        busyRef.current = true;
        travelRef.current = 0;
        samplesRef.current = [];
        downRef.current = { t: performance.now(), x: p.x, y: p.y, touch: e.pointerType !== 'mouse' };
        if (e.pointerType === 'mouse') surface.style.cursor = 'grabbing';
      }
      pointersRef.current.set(e.pointerId, p);
      // Baseline from the new pointer set's centroid, so the first move produces
      // a real delta (not a lost segment) yet a landing 2nd finger causes no
      // jump (the centroid it baselines from already includes both fingers).
      prevRef.current = centroid();
    };

    const onMove = (e: PointerEvent) => {
      if (!pointersRef.current.has(e.pointerId)) {
        // No button down: a bare hover. Give the mouse pointer-cursor feedback
        // over clickable icons (the touch model has no hover to mirror).
        if (e.pointerType === 'mouse') {
          const p = localOf(e);
          updateHoverCursor(p.x, p.y);
        }
        return;
      }
      e.preventDefault();
      pointersRef.current.set(e.pointerId, localOf(e));
      const now = centroid();
      const prev = prevRef.current;
      prevRef.current = now;
      if (!prev) return; // first move after the pointer set changed — no delta yet

      panBy(now.cx - prev.cx, now.cy - prev.cy);
      if (prev.spread > 0 && now.spread > 0) zoomBy(now.spread / prev.spread, now.cx, now.cy);

      travelRef.current += Math.hypot(now.cx - prev.cx, now.cy - prev.cy);
      const t = performance.now();
      samplesRef.current.push({ t, x: now.cx, y: now.cy });
      if (samplesRef.current.length > 8) samplesRef.current.shift();

      paint();
      maybeCommit();
    };

    const endPointer = (e: PointerEvent) => {
      if (!pointersRef.current.delete(e.pointerId)) return;
      prevRef.current = null; // 2→1 finger: re-baseline instead of jumping
      if (pointersRef.current.size > 0) return;

      // Gesture over: drop the grabbing cursor back to pointer/grab per what's
      // now under the mouse (a fling may still be animating; cursor is right
      // either way since nothing is pressed).
      if (e.pointerType === 'mouse') {
        const p = localOf(e);
        hoveringRef.current = !!onHoverTestRef.current?.(p.x, p.y);
        surface.style.cursor = hoveringRef.current ? 'pointer' : 'grab';
      }

      const down = downRef.current;
      downRef.current = null;
      const slop = down?.touch ? TAP_SLOP_TOUCH : TAP_SLOP_MOUSE;
      const dt = down ? performance.now() - down.t : Infinity;

      if (down && travelRef.current <= slop && dt <= TAP_MAX_MS) {
        busyRef.current = false;
        const prevTap = lastTapRef.current;
        const isDouble =
          !!prevTap &&
          performance.now() - prevTap.t < DOUBLE_TAP_MS &&
          Math.hypot(down.x - prevTap.x, down.y - prevTap.y) < DOUBLE_TAP_SLOP;
        if (isDouble) {
          // Zoom in one level about the tap — the only one-handed way in on a
          // phone, where pinch needs a second finger.
          lastTapRef.current = null;
          const before = { ...liveRef.current };
          zoomBy(2, down.x, down.y);
          const target = { ...liveRef.current };
          liveRef.current = before;
          animateTo(target, 200);
        } else {
          lastTapRef.current = { t: performance.now(), x: down.x, y: down.y };
          onTapRef.current(down.x, down.y, down.touch, { ...liveRef.current });
        }
        return;
      }

      // Fling: velocity over the tail of the drag, not the whole of it. A drag
      // that STOPPED before release (finger held still — no fresh samples)
      // must not fling off its stale motion: that reads as the map escaping
      // your finger, which is its own kind of jump.
      const s = samplesRef.current;
      const last = s[s.length - 1];
      const ref = s.find((p) => last && last.t - p.t <= 90) ?? s[0];
      let vx = 0;
      let vy = 0;
      if (last && ref && last.t > ref.t && performance.now() - last.t <= 90) {
        vx = (last.x - ref.x) / (last.t - ref.t);
        vy = (last.y - ref.y) / (last.t - ref.t);
      }
      samplesRef.current = [];
      if (Math.hypot(vx, vy) >= MIN_FLING_PX_PER_MS) {
        fling(vx, vy);
      } else {
        busyRef.current = false;
        commit();
      }
    };

    // React registers onWheel passively, so preventDefault() from JSX is a
    // no-op and the page would scroll under the map. Native, non-passive.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnimation();
      busyRef.current = true;
      const p = localOf(e);
      const perPx = e.ctrlKey ? PINCH_WHEEL_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX;
      zoomBy(2 ** (-e.deltaY * perPx), p.x, p.y);
      paint();
      maybeCommit();
      clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = window.setTimeout(() => {
        busyRef.current = false;
        commit();
      }, WHEEL_SETTLE_MS);
    };

    surface.addEventListener('pointerdown', onDown);
    surface.addEventListener('pointermove', onMove);
    surface.addEventListener('pointerup', endPointer);
    surface.addEventListener('pointercancel', endPointer);
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      surface.removeEventListener('pointerdown', onDown);
      surface.removeEventListener('pointermove', onMove);
      surface.removeEventListener('pointerup', endPointer);
      surface.removeEventListener('pointercancel', endPointer);
      surface.removeEventListener('wheel', onWheel);
      clearTimeout(wheelTimerRef.current);
      stopAnimation();
      pointersRef.current.clear();
      busyRef.current = false;
    };
  }, [enabled, panBy, zoomBy, paint, maybeCommit, commit, fling, animateTo, stopAnimation]);

  return { surfaceRef, paneRef, animateTo, zoomAboutCentre };
}

/** World px per screen px at a view's zoom — for readouts and scale bars. */
export function metersPerPx(view: MercatorView, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE * 2 ** view.z);
}
