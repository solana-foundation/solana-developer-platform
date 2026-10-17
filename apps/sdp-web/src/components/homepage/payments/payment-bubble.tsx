"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslations } from "@/i18n/provider";
import { watchActive } from "@/lib/use-scene-active";
import { cn } from "@/lib/utils";
import bubble from "../bubble.module.css";
import { fitPill } from "../bubble-motion";
import { restartAttribute } from "../restart-animation";
import { KIND_ICONS, PAYMENT_KINDS, type PaymentKind } from "./kinds";
import styles from "./payment-bubble.module.css";
import { usePaymentKind } from "./payment-kind-context";

function KindMark({ kind }: { kind: PaymentKind }) {
  return (
    <i className={styles.mark}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {KIND_ICONS[kind].map((shape) =>
          "d" in shape ? (
            <path key={shape.d} pathLength={1} d={shape.d} />
          ) : (
            <circle key="c" pathLength={1} cx={shape.cx} cy={shape.cy} r={shape.r} />
          )
        )}
      </svg>
    </i>
  );
}

/**
 * The bubble above the bench: the kind on the stage, its word and mark in a violet pill. The
 * bench moves it along; each hand-over is a beat.
 */
export function PaymentBubble() {
  const t = useTranslations();
  const { kind, shows } = usePaymentKind();
  const reducedMotion = useReducedMotion() ?? false;
  const cubeRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([]);

  /* fit the pill to the word on stage: now, once the word has eased in, when the fonts land and
     when the bubble is resized (its sizes are in container units) */
  useEffect(() => {
    const cube = cubeRef.current;
    const pill = pillRef.current;
    if (!cube || !pill) return;
    const fitWord = () => fitPill(pill, wordRefs.current[kind]);
    fitWord();
    const timer = setTimeout(fitWord, 450);
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) fitWord();
    });
    const resize = new ResizeObserver(fitWord);
    resize.observe(cube);
    return () => {
      live = false;
      clearTimeout(timer);
      resize.disconnect();
    };
  }, [kind]);

  /* a beat on every hand-over */
  useEffect(() => {
    if (shows > 0) restartAttribute(cubeRef.current, "data-beat");
  }, [shows]);

  /* the ambient loops stop off screen and in a hidden tab */
  useEffect(() => {
    const cube = cubeRef.current;
    if (!cube || reducedMotion) return;
    const stopWatching = watchActive(cube, { rootMargin: "120px" }, (active) => {
      cube.toggleAttribute("data-paused", !active);
    });
    return stopWatching;
  }, [reducedMotion]);

  return (
    <div
      ref={cubeRef}
      className={cn(bubble.bubble, bubble.violet, styles.bubble)}
      role="img"
      aria-label={t("Homepage.payments.bubbleLabel")}
    >
      <div className={bubble.ring}>
        <div className={bubble.inner}>
          <div ref={pillRef} className={cn(bubble.pill, styles.pill)}>
            <span className={styles.words}>
              {PAYMENT_KINDS.map((id, index) => (
                <span
                  key={id}
                  ref={(el) => {
                    wordRefs.current[index] = el;
                  }}
                  className={cn(styles.word, index === kind && styles.wordOn)}
                >
                  <KindMark kind={id} />
                  {t(`Homepage.payments.kinds.${id}.name`)}
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
