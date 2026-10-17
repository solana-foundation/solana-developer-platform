"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatNumber } from "@/lib/number-format";
import { cn } from "@/lib/utils";
import { useRiseArrived } from "../rise";
import { type BenchController, createBenchController } from "./bench-controller";
import type { FigFonts } from "./figures/make-fig";
import { FIGURE_WORDS, type FigureCopy } from "./figures/scene-input";
import { PAYMENT_KINDS } from "./kinds";
import styles from "./payment-bench.module.css";
import { usePaymentKind } from "./payment-kind-context";

/** The bench draws only once it is this near the screen. */
const NEAR_MARGIN = "900px 0px";
/** The first kind takes the stage this long after the bench's block arrives. */
const ARRIVE_DELAY = 300;

/** The page's own faces, resolved: the app loads them under hashed family names. */
function resolveFigureFonts(el: Element): FigFonts {
  const style = getComputedStyle(el);
  const sans = style.fontFamily || "sans-serif";
  const mono = style.getPropertyValue("--mono").trim() || "ui-monospace, monospace";
  return { sans, mono };
}

/**
 * The payment kinds as one bench: an index of tabs beside a stage that draws and plays the
 * chosen kind's figure, walking through them by itself while it is on screen.
 */
export function PaymentBench() {
  const t = useTranslations();
  const locale = useLocale();
  const { kind: current, show } = usePaymentKind();
  const reducedMotion = useReducedMotion() ?? false;
  const arrived = useRiseArrived() ?? true;
  const [playing, setPlaying] = useState(true);
  const stageId = useId();
  const tabId = (index: number) => `${stageId}-tab-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const barRefs = useRef<(HTMLElement | null)[]>([]);
  const controllerRef = useRef<BenchController | null>(null);

  const copy = useMemo<FigureCopy>(() => {
    const monthStart = new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    return {
      words: Object.fromEntries(
        FIGURE_WORDS.map((word) => [word, t(`Homepage.payments.figure.${word}`)])
      ) as FigureCopy["words"],
      paidTo: (address) => t("Homepage.payments.figure.paidTo", { address }),
      paidCount: (paid, total) => t("Homepage.payments.figure.paidCount", { paid, total }),
      number: (value, fractionDigits) => formatNumber(locale, value, fractionDigits),
      monthStart: (month) => monthStart.format(Date.UTC(2000, month, 1)),
    };
  }, [t, locale]);
  const labels = useMemo(
    () => PAYMENT_KINDS.map((id) => t(`Homepage.payments.kinds.${id}.figure`)),
    [t]
  );

  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const deck = deckRef.current;
    const list = listRef.current;
    if (!root || !stage || !deck || !list) return;
    const controller = createBenchController({
      kinds: PAYMENT_KINDS,
      stage,
      deck,
      list,
      tabs: () => tabRefs.current,
      bars: () => barRefs.current,
      classes: { fig: styles.fig, on: styles.figOn, out: styles.figOut },
      reducedMotion,
      locale,
      onShow: show,
      onPlayingChange: setPlaying,
    });
    controllerRef.current = controller;

    /* draw when the bench comes near, not at load: the kit measures glyphs, so the faces have
       to be in first */
    let cancelled = false;
    const draw = async () => {
      const fonts = resolveFigureFonts(root);
      await Promise.all(
        [`500 12px ${fonts.mono}`, `500 12px ${fonts.sans}`, `400 12px ${fonts.sans}`].map((font) =>
          document.fonts.load(font).catch(() => [])
        )
      );
      const { buildFigure } = await import("./figures/build-figures");
      if (cancelled) return;
      controller.load(
        PAYMENT_KINDS.map((kind, n) => buildFigure(kind, { fonts, label: labels[n], copy }))
      );
    };
    const near = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        near.disconnect();
        void draw();
      },
      { rootMargin: NEAR_MARGIN }
    );
    near.observe(root);

    return () => {
      cancelled = true;
      near.disconnect();
      controller.destroy();
      controllerRef.current = null;
    };
    /* the bench is built once; copy and labels are the catalog's, fixed for the page */
  }, [reducedMotion, locale, show, copy, labels]);

  useEffect(() => {
    if (!arrived) return;
    const timer = setTimeout(() => controllerRef.current?.arrive(), ARRIVE_DELAY);
    return () => clearTimeout(timer);
  }, [arrived]);

  return (
    <div ref={rootRef} className={styles.inner}>
      <div className={styles.side}>
        <div
          ref={listRef}
          className={styles.index}
          role="tablist"
          aria-label={t("Homepage.payments.kindsLabel")}
        >
          {PAYMENT_KINDS.map((id, index) => {
            const selected = index === current;
            return (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={tabId(index)}
                aria-labelledby={`${tabId(index)}-name`}
                aria-describedby={`${tabId(index)}-body`}
                aria-selected={selected}
                aria-controls={stageId}
                tabIndex={selected ? 0 : -1}
                className={cn(styles.tab, selected && styles.tabOn)}
                onClick={() => controllerRef.current?.select(index)}
                onKeyDown={(e) => controllerRef.current?.keyDown(e.nativeEvent)}
              >
                <span className={styles.bar} aria-hidden="true">
                  <i
                    ref={(el) => {
                      barRefs.current[index] = el;
                    }}
                  />
                </span>
                <span id={`${tabId(index)}-name`} className={styles.name}>
                  {t(`Homepage.payments.kinds.${id}.name`)}
                </span>
                <span id={`${tabId(index)}-body`} className={styles.body}>
                  {t(`Homepage.payments.kinds.${id}.body`)}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={styles.play}
          onClick={() => controllerRef.current?.togglePlay()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {playing ? (
              <path d="M9 7v10M15 7v10" />
            ) : (
              <path className={styles.playIcon} d="M9 6.5v11l9-5.5z" />
            )}
          </svg>
          <span>{playing ? t("Homepage.payments.pause") : t("Homepage.payments.play")}</span>
        </button>
      </div>
      <div
        ref={stageRef}
        id={stageId}
        className={styles.stage}
        role="tabpanel"
        aria-labelledby={tabId(current)}
      >
        <div ref={deckRef} className={styles.deck} />
      </div>
    </div>
  );
}
