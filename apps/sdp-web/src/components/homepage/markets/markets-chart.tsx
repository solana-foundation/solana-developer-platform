"use client";

import { useInView } from "motion/react";
import { type PointerEvent, useEffect, useId, useRef } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatPercent } from "@/lib/number-format";
import { cn } from "@/lib/utils";
import styles from "./markets.module.css";

/*
 * The chart, its vectors inlined so the hover can read the lines straight from the page.
 * Every piece is placed in a 1826 × 560 box by the slide's own numbers, see markets.module.css.
 */
const CURVE_D =
  "M0.5 481.5C548.3 481.5 950.02 461.176 1242.18 413.754C1534.34 366.331 1680.42 88.5705 1826.5 0.500075";
const LOW_D =
  "M0.5 116.5C584.82 116.5 950.02 111.273 1242.18 74.6819C1534.34 38.091 1680.42 21.4092 1826.5 0.500064";
const FILL_D =
  "M0 481C547.8 481 949.52 460.676 1241.68 413.254C1533.84 365.831 1679.92 88.0704 1826 0V331.958C1679.92 352.282 1314.72 392.93 1241.68 399.704C1168.64 406.479 584.32 481 0 481Z";
const DEPLOYED_D =
  "M0.5 0L0 0L0.0637184 4.64286L0.563718 4.64286L1.06372 4.64286L1 0L0.5 0ZM0.691155 13.9286L0.191155 13.9286L0.318592 23.2143L0.818592 23.2143L1.31859 23.2143L1.19116 13.9286L0.691155 13.9286ZM0.946029 32.5L0.446029 32.5L0.573466 41.7857L1.07347 41.7857L1.57347 41.7857L1.44603 32.5L0.946029 32.5ZM1.2009 51.0714L0.700903 51.0714L0.82834 60.3571L1.32834 60.3571L1.82834 60.3571L1.7009 51.0714L1.2009 51.0714Z";

/** Where the baseline sits and where each line peaks, as fractions of the chart's height. */
const BASELINE = 0.9125;
const DEFI_PEAK = 0.022;
const TREASURIES_PEAK = 0.674;

type Point = { x: number; y: number };

/** The y of a left-to-right path at a given x, found by halving along its length. */
export function yAtX(pointAt: (length: number) => Point, totalLength: number, x: number): number {
  let low = 0;
  let high = totalLength;
  for (let step = 0; step < 22; step += 1) {
    const middle = (low + high) / 2;
    if (pointAt(middle).x < x) low = middle;
    else high = middle;
  }
  return pointAt(low).y;
}

/** The rate a line shows at a height: 0 on the baseline, `max` at its peak. */
export function rateAt(y: number, baseline: number, peak: number, max: number): number {
  return max * Math.max(0, (baseline - y) / (baseline - peak));
}

/** A line's height in the chart's own pixels at a fraction `fx` of its width. */
function lineY(path: SVGPathElement, chartTop: number, fx: number): number {
  const svg = path.ownerSVGElement;
  if (!svg) return 0;
  const box = svg.viewBox.baseVal;
  const y = yAtX(
    (length) => path.getPointAtLength(length),
    path.getTotalLength(),
    box.x + fx * box.width
  );
  const rect = svg.getBoundingClientRect();
  return rect.top - chartTop + ((y - box.y) / box.height) * rect.height;
}

/**
 * The yield chart. It draws in from the left the first time it is on screen; on a mouse a hairline
 * follows the pointer, a dot rides each line and a bubble reads both rates there. The drawing and
 * the hover are decorative: the figure's caption says what the chart shows.
 */
export function MarketsChart() {
  const t = useTranslations();
  const locale = useLocale();
  // gradient ids: unique per chart, and only characters a url(#…) reference takes as they are
  const id = `mk${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const ref = useRef<HTMLElement>(null);
  const curveRef = useRef<SVGPathElement>(null);
  const lowRef = useRef<SVGPathElement>(null);
  const scrubRef = useRef<HTMLElement>(null);
  const defiDotRef = useRef<HTMLElement>(null);
  const treasuriesDotRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLElement>(null);
  const defiRateRef = useRef<HTMLSpanElement>(null);
  const treasuriesRateRef = useRef<HTMLSpanElement>(null);
  const drawn = useInView(ref, { once: true, amount: 0.35 });
  // the ripple on the end dot only runs while the chart is on screen
  const onScreen = useInView(ref);

  // the hover follows the pointer once a frame, however often the pointer reports
  const pointerX = useRef(0);
  const hoverFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    pointerX.current = event.clientX;
    if (!hoverFrame.current) hoverFrame.current = requestAnimationFrame(follow);
  }

  function follow() {
    hoverFrame.current = 0;
    const chart = ref.current;
    const curve = curveRef.current;
    const low = lowRef.current;
    const scrub = scrubRef.current;
    if (!chart || !curve || !low || !scrub) return;
    const rect = chart.getBoundingClientRect();
    const fx = Math.max(0.01, Math.min(0.999, (pointerX.current - rect.left) / rect.width));
    const baseline = rect.height * BASELINE;
    const defiY = lineY(curve, rect.top, fx);
    const treasuriesY = lineY(low, rect.top, fx);
    const defi = rateAt(defiY, baseline, rect.height * DEFI_PEAK, 8);
    const treasuries = rateAt(treasuriesY, baseline, rect.height * TREASURIES_PEAK, 4.5);

    scrub.style.setProperty("--x", `${(fx * 100).toFixed(2)}%`);
    if (defiDotRef.current) defiDotRef.current.style.top = `${defiY}px`;
    if (treasuriesDotRef.current) treasuriesDotRef.current.style.top = `${treasuriesY}px`;
    if (tipRef.current) tipRef.current.style.top = `${Math.max(0, defiY - 58)}px`;
    if (defiRateRef.current) defiRateRef.current.textContent = formatPercent(locale, defi, 1);
    if (treasuriesRateRef.current) {
      treasuriesRateRef.current.textContent = formatPercent(locale, treasuries, 1);
    }
    scrub.dataset.on = "true";
  }

  function onPointerLeave() {
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    if (scrubRef.current) scrubRef.current.dataset.on = "false";
  }

  return (
    <figure
      ref={ref}
      className={styles.chart}
      data-drawn={drawn}
      data-on-screen={onScreen}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <figcaption className="sr-only">{t("Homepage.markets.chart.description")}</figcaption>
      <svg
        className={styles.fill}
        viewBox="0 0 1826 481"
        preserveAspectRatio="none"
        overflow="visible"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={`${id}-fill`}
            x1="0"
            y1="0"
            x2="0"
            y2="322.362"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#9945FF" stopOpacity="0.14" />
            <stop offset="1" stopColor="#9945FF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path opacity="0.411837" d={FILL_D} fill={`url(#${id}-fill)`} />
      </svg>
      <svg
        className={styles.low}
        viewBox="0 0 1827 117"
        preserveAspectRatio="none"
        overflow="visible"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={`${id}-low`}
            x1="0.5"
            y1="1.5"
            x2="1826.5"
            y2="1.5"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#C9C6D1" />
            <stop offset="0.55" stopColor="#8C8895" />
            <stop offset="1" stopColor="#3A3842" />
          </linearGradient>
        </defs>
        <path ref={lowRef} d={LOW_D} stroke={`url(#${id}-low)`} strokeLinecap="round" />
      </svg>
      <svg
        className={styles.curve}
        viewBox="0 0 1827 482"
        preserveAspectRatio="none"
        overflow="visible"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={`${id}-curve`}
            x1="0.5"
            y1="0.5"
            x2="1826.5"
            y2="0.5"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#C9C6D1" />
            <stop offset="1" stopColor="#9945FF" />
          </linearGradient>
        </defs>
        <path ref={curveRef} d={CURVE_D} stroke={`url(#${id}-curve)`} strokeLinecap="round" />
      </svg>
      <i className={styles.base} aria-hidden="true" />
      <svg
        className={styles.deployed}
        viewBox="0 0 1.82834 65"
        preserveAspectRatio="none"
        overflow="visible"
        aria-hidden="true"
      >
        <path d={DEPLOYED_D} fill="#919091" />
      </svg>
      <i className={cn(styles.dot, styles.dotDefi)} aria-hidden="true" />
      <i className={cn(styles.dot, styles.dotTreasuries)} aria-hidden="true" />
      <div className={styles.axis} aria-hidden="true">
        <span>{t("Homepage.markets.chart.axisIdle")}</span>
        <span className={styles.axisDeployed}>{t("Homepage.markets.chart.axisDeployed")}</span>
        <span className={styles.axisToday}>{t("Homepage.markets.chart.axisToday")}</span>
      </div>
      <div className={styles.legend}>
        <span>
          <i className={cn(styles.key, styles.keyDefi)} aria-hidden="true" />
          {t("Homepage.markets.chart.legendDefi")}
        </span>
        <span>
          <i className={cn(styles.key, styles.keyTreasuries)} aria-hidden="true" />
          {t("Homepage.markets.chart.legendTreasuries")}
        </span>
      </div>
      <div className={styles.stats}>
        <div>
          <b>{t("Homepage.markets.chart.rateValue")}</b>
          <span>{t("Homepage.markets.chart.rateLabel")}</span>
        </div>
        <div>
          <b>{t("Homepage.markets.chart.withdrawValue")}</b>
          <span>{t("Homepage.markets.chart.withdrawLabel")}</span>
        </div>
      </div>
      <i ref={scrubRef} className={styles.scrub} data-on="false" aria-hidden="true">
        <i ref={defiDotRef} className={styles.scrubDefi} />
        <i ref={treasuriesDotRef} className={styles.scrubTreasuries} />
        <b ref={tipRef} className={styles.tip}>
          <span>
            <i className={cn(styles.key, styles.keyDefi)} />
            <span ref={defiRateRef} />
          </span>
          <span>
            <i className={cn(styles.key, styles.keyTreasuries)} />
            <span ref={treasuriesRateRef} />
          </span>
        </b>
      </i>
    </figure>
  );
}
