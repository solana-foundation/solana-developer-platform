"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslations } from "@/i18n/provider";
import { useLazyScene } from "@/lib/use-scene-active";
import { cn } from "@/lib/utils";
import { NARROW_QUERY } from "../../layout";
import styles from "./hero-globe.module.css";
import type { GlobeLabels } from "./payments";

type GlobeMode = "waiting" | "live" | "static";

/* the globe drifts back and fades as the page leaves it, beside the text; on a phone it sits
   under the text and is only reached by scrolling, so it stays put */
const PARALLAX_RANGE = 900;

function useParallax(ref: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const narrow = window.matchMedia(NARROW_QUERY);
    let raf = 0;
    /* the last scroll written, so nothing is written again once the drift is spent */
    let written: number | null = null;
    const step = () => {
      raf = 0;
      if (narrow.matches) {
        element.style.transform = "";
        element.style.opacity = "";
        written = null;
        return;
      }
      const y = Math.min(window.scrollY, PARALLAX_RANGE);
      if (y === written) return;
      written = y;
      element.style.transform = `translateY(${y * 0.14}px) scale(${1 - (y / PARALLAX_RANGE) * 0.05})`;
      element.style.opacity = String(Math.max(0, 1 - y / 720));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(step);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    narrow.addEventListener("change", onScroll);
    step();
    return () => {
      window.removeEventListener("scroll", onScroll);
      narrow.removeEventListener("change", onScroll);
      if (raf) cancelAnimationFrame(raf);
      element.style.transform = "";
      element.style.opacity = "";
    };
  }, [ref, enabled]);
}

/**
 * The hero's globe. Nothing of it loads with the page: when the box nears the screen it fetches
 * three.js and the coasts, and draws only while the box is on screen and the tab is visible.
 * Without WebGL it draws the same planet once, still, on a 2D canvas.
 */
export function HeroGlobe({ className }: { className?: string }) {
  const t = useTranslations();
  const reducedMotion = useReducedMotion() ?? false;
  const boxRef = useRef<HTMLDivElement>(null);
  const tagFromRef = useRef<HTMLDivElement>(null);
  const tagToRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);

  const labelsRef = useRef<GlobeLabels>({
    from: (city) => t("Homepage.hero.globe.from", { city }),
    confirmed: t("Homepage.hero.globe.confirmed"),
    landed: (city) => t("Homepage.hero.globe.landed", { city }),
  });

  useParallax(boxRef, !reducedMotion);
  /* fetch nothing until the box is within a screen of being seen; the scene is built for the
     reader's motion setting, so a change of it rebuilds the scene */
  const sceneMode = useLazyScene(boxRef, {
    load: () => import("./scene"),
    create: ({ createGlobeScene }, reduced, onLost) => {
      const box = boxRef.current;
      const tagFrom = tagFromRef.current;
      const tagTo = tagToRef.current;
      if (!box || !tagFrom || !tagTo) return null;
      return createGlobeScene({
        host: box,
        tagFrom,
        tagTo,
        labels: labelsRef.current,
        reduced,
        onLost,
      });
    },
    settings: reducedMotion,
    activeThreshold: 0.02,
  });
  const mode: GlobeMode = sceneMode === "fallback" ? "static" : sceneMode;

  /* the still planet, drawn when there is no WebGL to draw the live one */
  useEffect(() => {
    const canvas = staticRef.current;
    if (mode !== "static" || !canvas) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    import("./static-globe")
      .then(({ drawStaticGlobe }) => {
        if (cancelled) return;
        drawStaticGlobe(canvas);
        observer = new ResizeObserver(() => drawStaticGlobe(canvas));
        observer.observe(canvas);
      })
      .catch((error: unknown) => {
        /* the rim drawn in CSS stays: the box is never an empty hole */
        console.error("homepage still globe failed to load", error);
      });
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [mode]);

  return (
    <div
      ref={boxRef}
      className={cn(styles.globe, className)}
      data-mode={mode}
      role="img"
      aria-label={t("Homepage.hero.globe.label")}
    >
      {mode === "static" ? <canvas ref={staticRef} /> : null}
      <div ref={tagFromRef} className={styles.tag} data-on="false" aria-hidden="true">
        <b />
        <span />
      </div>
      <div
        ref={tagToRef}
        className={cn(styles.tag, styles.tagTo)}
        data-on="false"
        aria-hidden="true"
      >
        <b />
        <span />
      </div>
    </div>
  );
}
