"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import styles from "./builders-section.module.css";
import homepage from "./homepage.module.css";
import { FILMS, filmUrl, SERIES_URL } from "./scenes/builders/films";
import { loadBuilders } from "./scenes/builders/load-builders";

type Mode = "shot" | "still" | "plain";

/** A caption's opacity at progress `p`: each holds half the shot; the last one stays. */
export function captionOpacity(p: number, index: number, count: number) {
  const share = 1 / count;
  const start = index * share;
  if (p < start || p > start + share) return 0;
  const u = (p - start) / share;
  if (index === count - 1) return Math.min(1, u / 0.2);
  return u < 0.2 ? u / 0.2 : u > 0.8 ? (1 - u) / 0.2 : 1;
}

/**
 * Meet the builders: two screens of scroll fly one camera round, into and out
 * of a ring of interview stills, with a caption at each end. The ring is
 * illustration; the captions carry the words and the link to the series.
 */
export function BuildersSection() {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const captionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const nearViewport = useInView(sectionRef, { once: true, margin: "400px" });
  // "plain" until the scene is mounted: readable without script, and the switch to the
  // pinned shot happens while the section is still below the viewport.
  const [mode, setMode] = useState<Mode>("plain");

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    if (!nearViewport || reducedMotion === null || !section || !stage) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;

    loadBuilders().then(({ mountBuilders }) => {
      if (cancelled) return;
      dispose = mountBuilders(section, stage, {
        reducedMotion,
        onProgress: (progress) => {
          // Under reduced motion the camera holds still and both captions stay shown.
          if (reducedMotion) return;
          if (progressRef.current) {
            progressRef.current.style.transform = `scaleX(${progress.toFixed(4)})`;
          }
          const captions = captionRefs.current;
          captions.forEach((caption, index) => {
            if (!caption) return;
            // A caption that holds focus shows, whatever the camera is doing.
            const focused = caption.contains(document.activeElement);
            const opacity = focused ? 1 : captionOpacity(progress, index, captions.length);
            caption.style.opacity = String(opacity);
          });
        },
      });
      setMode(dispose === null ? "plain" : reducedMotion ? "still" : "shot");
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [nearViewport, reducedMotion]);

  return (
    <section
      ref={sectionRef}
      id="builders"
      data-ground="night"
      data-mode={mode}
      aria-labelledby="builders-title"
      className={cn(homepage.night, styles.builders)}
    >
      <div ref={stageRef} className={styles.stage}>
        <span ref={progressRef} className={styles.progress} aria-hidden="true" />
        <div
          ref={(element) => {
            captionRefs.current[0] = element;
          }}
          className={cn(styles.caption, styles.opening)}
        >
          <h2 id="builders-title" className={styles.title}>
            {t("Homepage.builders.title")}
          </h2>
          <p className={styles.body}>{t("Homepage.builders.body")}</p>
        </div>
        <div
          ref={(element) => {
            captionRefs.current[1] = element;
          }}
          className={cn(styles.caption, styles.closing)}
        >
          <h3 className={styles.title}>{t("Homepage.builders.closingTitle")}</h3>
          {/* Each name opens its interview: the keyboard's way to the films the ring shows. */}
          <ul className={cn(styles.body, styles.films)}>
            {FILMS.map(([id, name]) => (
              <li key={id}>
                <a href={filmUrl(id)} target="_blank" rel="noreferrer">
                  {name} <span className="sr-only">{t("Homepage.nav.links.opensInNewTab")}</span>
                </a>
              </li>
            ))}
          </ul>
          <a href={SERIES_URL} target="_blank" rel="noreferrer" className={styles.watch}>
            {t("Homepage.builders.watch")}{" "}
            <span className="sr-only">{t("Homepage.nav.links.opensInNewTab")}</span>
          </a>
        </div>
      </div>
    </section>
  );
}
