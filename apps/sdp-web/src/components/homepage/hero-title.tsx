"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { useFormIn } from "@/lib/use-form-in";
import { cn } from "@/lib/utils";
import formStyles from "./form-heading.module.css";
import { FormLetters, letterCount } from "./form-letters";
import styles from "./hero-section.module.css";

const STEP_MS = 30;
/** The letters start forming with the first line, as the design times it. */
const FORM_DELAY_MS = 700;

/**
 * "The interface / to onchain finance": two lines that rise in, letters that
 * form, a marquee over the first phrase and a lit selection on the second.
 * The heading's text for assistive technology is the whole sentence; the
 * drawn copy is hidden from it.
 */
export function HeroTitle() {
  const t = useTranslations();
  const ref = useRef<HTMLHeadingElement>(null);
  const reducedMotion = useReducedMotion();
  const [forming, setForming] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setForming(true), reducedMotion ? 0 : FORM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [reducedMotion]);
  useFormIn(ref, forming, STEP_MS);

  const lead = t("Homepage.hero.titleLead");
  const first = t("Homepage.hero.titleInterface");
  const connector = t("Homepage.hero.titleConnector");
  const second = t("Homepage.hero.titleFinance");

  // Each run's stagger starts where the previous run's letters end.
  const firstStart = letterCount(lead);
  const connectorStart = firstStart + letterCount(first);
  const secondStart = connectorStart + letterCount(connector);

  return (
    <h1 ref={ref} className={cn(styles.title, formStyles.failsafe)} data-form="hidden">
      <span className="sr-only">{t("Homepage.hero.title")}</span>
      <span aria-hidden="true" className={cn(styles.line, styles.lineFirst)}>
        <FormLetters text={lead} stepMs={STEP_MS} />{" "}
        <span className={cn(styles.phrase, styles.hovered)}>
          <FormLetters text={first} start={firstStart} stepMs={STEP_MS} />
        </span>
      </span>
      <span aria-hidden="true" className={cn(styles.line, styles.lineSecond)}>
        <FormLetters text={connector} start={connectorStart} stepMs={STEP_MS} />{" "}
        <span className={cn(styles.phrase, styles.selected)}>
          <FormLetters text={second} start={secondStart} stepMs={STEP_MS} />
          <span className={styles.foil}>{second}</span>
        </span>
      </span>
    </h1>
  );
}
