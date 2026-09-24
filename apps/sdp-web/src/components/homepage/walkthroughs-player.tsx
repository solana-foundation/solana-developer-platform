"use client";

import { useRef, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import styles from "./walkthroughs-section.module.css";

/** The films recorded from the console; each carries its caption track. */
const CHAPTERS = [
  {
    key: "dvp",
    src: "/homepage/video/dvp-demo.mp4",
    poster: "/homepage/video/dvp.jpg",
    captions: "/homepage/video/dvp-demo.vtt",
  },
  {
    key: "v1",
    src: "/homepage/video/v1-changes.mp4",
    poster: "/homepage/video/v1.jpg",
    captions: "/homepage/video/v1-changes.vtt",
  },
] as const;

type ChapterKey = (typeof CHAPTERS)[number]["key"];

/**
 * One video and the chapters beside it. Choosing a chapter loads its film and
 * plays it; choosing the current one again plays it if paused. Nothing plays
 * until someone asks.
 */
export function WalkthroughsPlayer() {
  const t = useTranslations();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState<ChapterKey>("dvp");
  // Once a chapter has been chosen, the film it loads starts by itself.
  const [autoPlay, setAutoPlay] = useState(false);
  const chapter = CHAPTERS.find((item) => item.key === current) ?? CHAPTERS[0];

  const choose = (key: ChapterKey) => {
    if (key === current) {
      const video = videoRef.current;
      if (video?.paused) video.play().catch(() => {});
      return;
    }
    setCurrent(key);
    setAutoPlay(true);
  };

  return (
    <div className={styles.player}>
      <div className={styles.screen}>
        {/* The key remounts the element so its source and caption track change together. */}
        <video
          key={chapter.key}
          ref={videoRef}
          controls
          playsInline
          autoPlay={autoPlay}
          preload="none"
          poster={chapter.poster}
          src={chapter.src}
          aria-label={t(`Homepage.walkthroughs.${chapter.key}.video`)}
        >
          <track
            kind="captions"
            srcLang="en"
            label={t("Homepage.walkthroughs.captions")}
            src={chapter.captions}
            default
          />
        </video>
      </div>
      <fieldset className={styles.chapters}>
        <legend className="sr-only">{t("Homepage.walkthroughs.chapters")}</legend>
        {CHAPTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={styles.chapter}
            aria-pressed={item.key === current}
            onClick={() => choose(item.key)}
          >
            <b>{t(`Homepage.walkthroughs.${item.key}.title`)}</b>
            <small>{t(`Homepage.walkthroughs.${item.key}.detail`)}</small>
            <i>{t("Homepage.walkthroughs.duration")}</i>
          </button>
        ))}
      </fieldset>
    </div>
  );
}
