"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import styles from "./homepage-globe.module.css";
import { formatSampleAmount } from "./sample-payments";
import type { CityKey } from "./scenes/globe/geo";
import { loadGlobe } from "./scenes/globe/load-globe";

type LabelledArc = { from: CityKey; to: CityKey; amountIndex: number };

type HomepageGlobeProps = {
  /** Show the two labels that follow each payment. */
  withTags?: boolean;
  className?: string;
};

/**
 * The wireframe globe with payments crossing it. three.js is loaded only once
 * the globe is near the viewport; without WebGL the globe is hidden, since it
 * is illustration and the copy around it carries the message.
 */
export function HomepageGlobe({ withTags = false, className }: HomepageGlobeProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { theme, hydrated } = useTheme();
  const reducedMotion = useReducedMotion() ?? false;
  const hostRef = useRef<HTMLDivElement>(null);
  const fromRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLDivElement>(null);
  const nearViewport = useInView(hostRef, { once: true, margin: "200px" });
  const [failed, setFailed] = useState(false);
  const [arc, setArc] = useState<LabelledArc | null>(null);

  // The palette must match the ground, so wait for the theme before drawing.
  const sceneGround = theme === "dark" ? "dark" : "paper";

  useEffect(() => {
    const host = hostRef.current;
    if (!nearViewport || !hydrated || !host) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;

    loadGlobe().then(({ mountGlobe }) => {
      if (cancelled) return;
      const from = fromRef.current;
      const to = toRef.current;
      dispose = mountGlobe(host, {
        ground: sceneGround,
        reducedMotion,
        tags:
          withTags && from && to
            ? {
                from,
                to,
                onArcChange: (next) =>
                  setArc(
                    next ? { from: next.from, to: next.to, amountIndex: next.amountIndex } : null
                  ),
              }
            : undefined,
      });
      setFailed(dispose === null);
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [nearViewport, hydrated, sceneGround, reducedMotion, withTags]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={t("Homepage.globe.label")}
      data-failed={failed}
      className={cn(styles.globe, className)}
    >
      {withTags ? (
        <>
          <div ref={fromRef} className={styles.tag} aria-hidden="true">
            {arc ? (
              <>
                <b>{formatSampleAmount(arc.amountIndex, locale)}</b>
                <span>
                  {t("Homepage.globe.from", { city: t(`Homepage.globe.cities.${arc.from}`) })}
                </span>
              </>
            ) : null}
          </div>
          <div ref={toRef} className={cn(styles.tag, styles.tagArrived)} aria-hidden="true">
            {arc ? (
              <>
                <b>{t("Homepage.globe.confirmed")}</b>
                <span>
                  {t("Homepage.globe.arrived", { city: t(`Homepage.globe.cities.${arc.to}`) })}
                </span>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
