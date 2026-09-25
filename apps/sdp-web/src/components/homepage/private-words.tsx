"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { PauseButton } from "./pause-button";
import styles from "./private-words.module.css";

const WORDS = ["payments", "issuance", "markets", "payroll", "balances"] as const;
const EVERY_MS = 2600;

/**
 * The things that can stay private, taking turns above the "Private" switch.
 * Screen readers get the whole list at once; the turning copy is for the eye.
 * It turns only while on screen and not paused, and not at all under reduced motion.
 */
export function PrivateWords() {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!inView || paused || reducedMotion !== false) return;
    const timer = setInterval(() => setCurrent((index) => (index + 1) % WORDS.length), EVERY_MS);
    return () => clearInterval(timer);
  }, [inView, paused, reducedMotion]);

  const words = WORDS.map((word) => t(`Homepage.privacy.words.${word}`));

  return (
    <div ref={ref} className={styles.box}>
      <p className="sr-only">
        {t("Homepage.privacy.label")}: {words.join(", ")}
      </p>
      <span className={styles.words} aria-hidden="true">
        {words.map((word, index) => (
          <span key={word} className={styles.word} data-current={index === current}>
            {word}
          </span>
        ))}
      </span>
      <span className={styles.rule} aria-hidden="true" />
      <span className={styles.private} aria-hidden="true">
        <span className={styles.switch} />
        {t("Homepage.privacy.private")}
      </span>
      <PauseButton
        paused={paused}
        onToggle={() => setPaused((value) => !value)}
        labels={{ pause: "Homepage.privacy.pause", play: "Homepage.privacy.play" }}
        className={styles.pause}
      />
    </div>
  );
}
