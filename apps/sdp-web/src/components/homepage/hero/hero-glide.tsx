"use client";

import { useReducedMotion } from "motion/react";
import { useEffect } from "react";
import { NARROW_QUERY, NAV_HEIGHT } from "../layout";

const LOCK_MS = 1100;
/* a scroll this soon after a wheel event is the wheel's */
const WHEEL_WINDOW_MS = 250;

/** Where a scroll should glide to, or null to leave it alone. */
export function glideTarget({
  y,
  down,
  landing,
}: {
  y: number;
  down: boolean;
  /** The scroll position that lands the next section under the nav. */
  landing: number;
}): number | null {
  if (down && y > 24 && y < landing * 0.5) return landing;
  if (!down && y < landing && y > landing * 0.5) return 0;
  return null;
}

/**
 * Leaving the hero glides on to land the next section square on the screen, and
 * coming back glides to the top: one glide, then the page is the reader's again. Only where the
 * hero is one screen tall and the pointer is fine (on a phone the hero runs to two screens and a
 * glide would carry the reader past the globe and the logos), never under reduced motion, and
 * only for a scroll the wheel (or trackpad) is driving: a scroll by key (PageDown, Space, arrows,
 * Home, End), a jump to an anchor or a drag of the scrollbar is left exactly where the reader
 * sent it.
 */
export function HeroGlide({ heroId, nextId }: { heroId: string; nextId: string }) {
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return;
    const hero = document.getElementById(heroId);
    const next = document.getElementById(nextId);
    if (!hero || !next) return;
    const small = window.matchMedia(`${NARROW_QUERY}, (pointer: coarse)`);
    let lastY = window.scrollY;
    let lockUntil = 0;
    let wheelAt = -Infinity;

    const onWheel = () => {
      wheelAt = performance.now();
    };
    const onScroll = () => {
      const y = window.scrollY;
      const down = y > lastY;
      lastY = y;
      const now = performance.now();
      if (now < lockUntil || now - wheelAt > WHEEL_WINDOW_MS) return;
      if (small.matches || hero.offsetHeight > window.innerHeight - NAV_HEIGHT + 8) return;
      const landing = next.getBoundingClientRect().top + y - NAV_HEIGHT;
      const target = glideTarget({ y, down, landing });
      if (target === null) return;
      lockUntil = now + LOCK_MS;
      window.scrollTo({ top: target, behavior: "smooth" });
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("scroll", onScroll);
    };
  }, [heroId, nextId, reducedMotion]);

  return null;
}
