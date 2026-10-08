"use client";

import { useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatNumber } from "@/lib/number-format";
import { watchActive } from "@/lib/use-scene-active";
import { cn } from "@/lib/utils";
import { restartClass } from "../restart-animation";
import { useRiseArrived } from "../rise";
import styles from "./network.module.css";
import {
  createRaceState,
  drawStill,
  type Geometry,
  LAUNCH_EVERY,
  laneFraction,
  launch,
  railEnd,
  stepAndDraw,
} from "./speed-canvas";

const LANE_KEYS = ["solana", "cards", "ach", "swift"] as const;

/* Illustrative settlements written into the list as Solana payments land (airport codes, amounts). */
const ROUTES = [
  ["fra", "sin"],
  ["lon", "iad"],
  ["sfo", "tyo"],
  ["ams", "gru"],
  ["dxb", "lon"],
  ["nyc", "lag"],
  ["bom", "hkg"],
  ["syd", "sin"],
] as const;
const AMOUNTS = [
  [12_500, "USDC"],
  [840, "USDC"],
  [1_020_000, "USDC"],
  [96.4, "USDC"],
  [25_000, "USDC"],
  [3_300, "EURC"],
  [410, "USDC"],
  [78_000, "USDC"],
] as const;
const MAX_ROWS = LANE_KEYS.length - 1;

type Settlement = {
  id: number;
  from: string;
  to: string;
  amount: number;
  token: string;
  slot: number;
};

function settlement(n: number): Settlement {
  const [from, to] = ROUTES[n % ROUTES.length];
  const [amount, token] = AMOUNTS[n % AMOUNTS.length];
  return {
    id: n,
    from,
    to,
    amount,
    token,
    slot: 291044000 + Math.floor(Math.random() * 9000),
  };
}

/**
 * The same payment on four rails. The canvas is the picture (role="img" with the catalog's
 * description); the lane names stay real text; the list of settlements is illustrative and hidden
 * from assistive tech so it never chatters. The loop runs only while the box is on screen, the tab
 * is visible and its block has arrived; under reduced motion it is one still frame.
 */
export function SpeedRace() {
  const t = useTranslations();
  const locale = useLocale();
  const reducedMotion = useReducedMotion();
  const arrived = useRiseArrived() ?? true;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const arrivedRef = useRef(arrived);
  const syncRef = useRef<() => void>(() => {});
  const [rows, setRows] = useState<Settlement[]>([]);

  useEffect(() => {
    arrivedRef.current = arrived;
    syncRef.current();
  }, [arrived]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!host || !canvas || !ctx) return;

    const geometry: Geometry = { width: 0, height: 0, right: 0 };
    let dpr = 0;

    /* sizes the backing store to the box and the pixel ratio; true when anything changed. It runs
       when the box is resized, not every frame: reading the box's size forces a layout. */
    function measure(): boolean {
      if (!host || !canvas || !ctx) return false;
      // a box not laid out yet still gets a 1px backing store
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      const ratio = Math.min(3, window.devicePixelRatio);
      if (width === geometry.width && height === geometry.height && ratio === dpr) return false;
      const withFeed = feedRef.current
        ? getComputedStyle(feedRef.current).display !== "none"
        : false;
      geometry.width = width;
      geometry.height = height;
      geometry.right = railEnd(width, withFeed);
      dpr = ratio;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      return true;
    }

    let count = 0;
    function settle() {
      count += 1;
      const next = settlement(count);
      setRows((current) => [next, ...current].slice(0, MAX_ROWS));
      /* the headline's chosen phrase beats with each settlement */
      const phrase = host?.closest("section")?.querySelector(`.${styles.selN}`);
      if (phrase) restartClass(phrase, styles.beat);
    }

    if (reducedMotion) {
      measure();
      drawStill(ctx, geometry);
      setRows([settlement(3), settlement(2), settlement(1)]);
      const redraw = () => {
        if (measure()) drawStill(ctx, geometry);
      };
      const observer = new ResizeObserver(redraw);
      observer.observe(host);
      return () => observer.disconnect();
    }

    const state = createRaceState();
    count = 0;
    setRows([]);
    let inView = false;
    let frame = 0;
    let last = 0;
    let sinceLaunch = 0;
    let launched = false;

    measure();
    const resize = new ResizeObserver(() => {
      measure();
    });
    resize.observe(host);

    function tick(now: number) {
      frame = requestAnimationFrame(tick);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
      last = now;
      if (!launched) {
        launched = true;
        launch(state);
      }
      sinceLaunch += dt;
      if (sinceLaunch > LAUNCH_EVERY) {
        sinceLaunch = 0;
        launch(state);
      }
      if (!ctx) return;
      const settled = stepAndDraw(ctx, state, geometry, dt);
      for (let i = 0; i < settled; i++) settle();
    }

    function sync() {
      const run = inView && !document.hidden && arrivedRef.current;
      if (run && !frame) {
        last = 0;
        frame = requestAnimationFrame(tick);
      } else if (!run && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }
    syncRef.current = sync;

    const stopWatching = watchActive(host, { threshold: 0.05 }, (active) => {
      inView = active;
      sync();
    });

    return () => {
      syncRef.current = () => {};
      cancelAnimationFrame(frame);
      stopWatching();
      resize.disconnect();
    };
  }, [reducedMotion]);

  return (
    <div ref={hostRef} className={styles.speed}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={t("Homepage.network.raceLabel")}
      />
      <ul className={styles.lanes}>
        {LANE_KEYS.map((key, index) => (
          <li
            key={key}
            className={cn(styles.lane, index === 0 && styles.laneFast)}
            style={{ top: `${(laneFraction(index) * 100).toFixed(2)}%` } as CSSProperties}
          >
            <span>{t(`Homepage.network.lanes.${key}.name`)}</span>
            <b>{t(`Homepage.network.lanes.${key}.time`)}</b>
          </li>
        ))}
      </ul>
      <div ref={feedRef} className={styles.feed} aria-hidden="true">
        <div className={styles.feedHead}>{t("Homepage.network.feedHeading")}</div>
        <div className={styles.feedRows}>
          {rows.map((row) => (
            <div key={row.id} className={styles.feedRow}>
              <span>{`${row.from} → ${row.to}`}</span>
              <span>
                {t("Homepage.network.feedAmount", {
                  amount: formatNumber(locale, row.amount, 2),
                  token: row.token,
                })}
              </span>
              <span>
                {t("Homepage.network.feedSlot", { slot: formatNumber(locale, row.slot) })}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
