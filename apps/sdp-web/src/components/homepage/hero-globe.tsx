"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import styles from "./hero-section.module.css";
import { HomepageGlobe } from "./homepage-globe";
import { onScrollFrame } from "./scroll-frame";

/** How far down the page the drift runs, in px. */
const DRIFT_RANGE = 900;

/**
 * The hero's globe, with payment tags. As the page moves it sinks a little,
 * shrinks a little and fades, so the next screen takes over; under reduced
 * motion it stays put.
 */
export function HeroGlobe() {
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion) return;
    const stop = onScrollFrame(
      () => {
        const y = Math.min(window.scrollY, DRIFT_RANGE);
        element.style.transform = `translateY(${y * 0.14}px) scale(${1 - (y / DRIFT_RANGE) * 0.05})`;
        element.style.opacity = String(Math.max(0, 1 - y / 720));
      },
      { resize: false }
    );
    return () => {
      stop();
      element.style.transform = "";
      element.style.opacity = "";
    };
  }, [reducedMotion]);

  return (
    <div ref={ref} className={styles.globe}>
      <HomepageGlobe withTags />
    </div>
  );
}
