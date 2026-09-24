"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { formatSampleAmount, SAMPLE_ROUTES, sampleSlot } from "./sample-payments";
import { laneTop, mountSpeed, type SpeedMode } from "./scenes/speed/draw-speed";
import styles from "./speed-lanes.module.css";

const RACE_LANES = ["solana", "cards", "ach", "swift"] as const;
const FEED_LENGTH = 4;

type Settlement = { id: number; route: string; amount: string; slot: string };

type SpeedLanesProps = {
  mode: SpeedMode;
  /** What the picture shows, for assistive technology. */
  label: MessageKey;
  className?: string;
};

/**
 * The speed of settlement, drawn: four rails racing ("race"), or a single
 * payment from one party to another ("one"). The drawing and its moving text
 * are one labelled image to assistive technology.
 */
export function SpeedLanes({ mode, label, className }: SpeedLanesProps) {
  const t = useTranslations();
  const locale = useLocale();
  const reducedMotion = useReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Outlives the drawing effect, so a re-run never reuses the id of a row still listed.
  const settledRef = useRef(0);
  const [feed, setFeed] = useState<Settlement[]>([]);
  const [stamp, setStamp] = useState<{ id: number; slot: string } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || reducedMotion === null) return;
    const onSettle = () => {
      settledRef.current += 1;
      const id = settledRef.current;
      if (mode === "one") {
        setStamp({ id, slot: sampleSlot(locale) });
        return;
      }
      const [from, to] = SAMPLE_ROUTES[id % SAMPLE_ROUTES.length];
      const entry = {
        id,
        route: `${from} → ${to}`,
        amount: formatSampleAmount(id, locale),
        slot: sampleSlot(locale),
      };
      setFeed((current) => [entry, ...current].slice(0, FEED_LENGTH));
    };
    return mountSpeed(host, canvas, { mode, reducedMotion, onSettle });
  }, [mode, locale, reducedMotion]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={t(label)}
      className={cn(styles.speed, mode === "one" && styles.one, className)}
    >
      <canvas ref={canvasRef} className={styles.canvas} />
      {mode === "race" ? (
        <>
          {RACE_LANES.map((lane, index) => (
            <div
              key={lane}
              className={cn(styles.lane, lane === "solana" && styles.fast)}
              style={{ top: `${laneTop("race", index, RACE_LANES.length) * 100}%` }}
            >
              <span>{t(`Homepage.network.lanes.${lane}.name`)}</span>
              <b>{t(`Homepage.network.lanes.${lane}.time`)}</b>
            </div>
          ))}
          <div className={styles.feed}>
            <div className={styles.feedHead}>{t("Homepage.network.feedTitle")}</div>
            {feed.map((entry) => (
              <div key={entry.id} className={styles.row}>
                <span>{entry.route}</span>
                <span>{entry.amount}</span>
                <span>{t("Homepage.network.slot", { slot: entry.slot })}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className={cn(styles.lane, styles.fast, styles.oneLane)} style={{ top: "50%" }}>
            <span>{t("Homepage.payments.from")}</span>
            <b>{t("Homepage.payments.to")}</b>
          </div>
          {stamp ? (
            <div key={stamp.id} className={styles.stamp}>
              {t("Homepage.payments.confirmed", { slot: stamp.slot })}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
