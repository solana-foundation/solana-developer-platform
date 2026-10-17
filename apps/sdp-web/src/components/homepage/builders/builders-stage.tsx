"use client";

import { useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { useLazyScene } from "@/lib/use-scene-active";
import { cn } from "@/lib/utils";
import { FormHeadline } from "../form-headline";
import shared from "../homepage.module.css";
import styles from "./builders.module.css";
import { FilmLinks } from "./film-links";
import { FILM_NAMES, SERIES_URL } from "./films";

/** waiting: the scene not loaded yet; live: the ring; still: no WebGL or reduced motion. */
export type StageMode = "waiting" | "live" | "still";

/* the ring turns a turn and a quarter over the shot */
const TURNS = 1.25;

function YouTubeMark() {
  return (
    <svg className={styles.ytm} viewBox="0 0 28 20" aria-hidden="true">
      <path
        fill="#FF0000"
        d="M27.4 3.1A3.5 3.5 0 0 0 24.9.6C22.7 0 14 0 14 0S5.3 0 3.1.6A3.5 3.5 0 0 0 .6 3.1C0 5.3 0 10 0 10s0 4.7.6 6.9a3.5 3.5 0 0 0 2.5 2.5C5.3 20 14 20 14 20s8.7 0 10.9-.6a3.5 3.5 0 0 0 2.5-2.5C28 14.7 28 10 28 10s0-4.7-.6-6.9Z"
      />
      <path fill="#fff" d="M11.2 14.3 18.5 10l-7.3-4.3v8.6Z" />
    </svg>
  );
}

/**
 * The pinned stage of "Meet the builders": a ring of the sixteen films that turns as the page
 * scrolls, with two captions. three.js is fetched only when the section nears the screen, and
 * the ring draws only while it is on screen and the tab is visible. Without WebGL, or under
 * reduced motion, the section is a still grid of the films instead.
 */
export function BuildersStage() {
  const t = useTranslations();
  const reducedMotion = useReducedMotion() ?? false;
  const roomRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const outroRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<[boolean, boolean]>([false, false]);
  /* each time a caption comes back its headline forms again, from a fresh mount */
  const [entries, setEntries] = useState<[number, number]>([0, 0]);

  /* fetch nothing until the section is within a screen of being seen */
  const sceneMode = useLazyScene(roomRef, {
    load: () => import("./ring-scene"),
    create: ({ createRingScene }, _settings, onLost) => {
      const room = roomRef.current;
      const stage = stageRef.current;
      const intro = introRef.current;
      const outro = outroRef.current;
      if (!room || !stage || !intro || !outro) return null;
      return createRingScene({
        section: room,
        stage,
        canvasClassName: styles.canvas,
        captions: [intro, outro],
        turns: TURNS,
        onCaption: (index, on) => {
          setShown((current) => {
            const next: [boolean, boolean] = [current[0], current[1]];
            next[index] = on;
            return next;
          });
          if (on) {
            setEntries((current) => {
              const next: [number, number] = [current[0], current[1]];
              next[index] += 1;
              return next;
            });
          }
        },
        onLost,
      });
    },
    settings: null,
    activeThreshold: 0,
    disabled: reducedMotion,
  });
  const mode: StageMode = sceneMode === "fallback" ? "still" : sceneMode;

  const still = mode === "still";
  /* beside the ring the shot times the headlines; otherwise they form on reaching the screen */
  const headlineStart = (index: 0 | 1) => (mode === "live" ? shown[index] : undefined);

  return (
    <div ref={roomRef} className={styles.room} data-mode={mode}>
      <div ref={stageRef} className={styles.stage}>
        <div
          ref={introRef}
          className={cn(styles.caption, styles.top)}
          data-noscript-reveal
          data-in={mode === "live" ? shown[0] : true}
        >
          <FormHeadline
            key={`intro-${mode}-${entries[0]}`}
            as="h2"
            className={styles.title}
            parts={[t("Homepage.builders.intro.title")]}
            start={headlineStart(0)}
            stagger={16}
          />
          <p className={styles.body}>{t("Homepage.builders.intro.body")}</p>
        </div>
        {still ? <FilmLinks withStills /> : null}
        <div
          ref={outroRef}
          className={cn(styles.caption, styles.bottom)}
          data-noscript-reveal
          data-in={mode === "live" ? shown[1] : still}
        >
          <FormHeadline
            key={`outro-${mode}-${entries[1]}`}
            as="h3"
            className={styles.title}
            parts={[t("Homepage.builders.outro.title")]}
            start={headlineStart(1)}
            stagger={16}
          />
          <p className={styles.body}>{FILM_NAMES}</p>
          <div className={styles.cta}>
            <a
              className={cn(shared.btn, shared.btnLine, styles.series)}
              href={SERIES_URL}
              target="_blank"
              rel="noreferrer"
              aria-label={t("Homepage.builders.seriesLabel")}
            >
              <YouTubeMark />
              {t("Homepage.builders.series")}
            </a>
          </div>
        </div>
        {still ? null : <FilmLinks withStills={false} />}
      </div>
    </div>
  );
}
