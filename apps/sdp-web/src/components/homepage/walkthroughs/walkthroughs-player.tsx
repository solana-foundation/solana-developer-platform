"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslations } from "@/i18n/provider";
import { FILMS, formatDuration } from "./films";
import styles from "./walkthroughs.module.css";

function PlayIcon() {
  return (
    <svg className={styles.playIcon} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 7.2v9.6l7.6-4.8z" fill="currentColor" />
    </svg>
  );
}

/**
 * Starts the video. A play the browser refuses (`NotAllowedError`) shows the native controls so a
 * press can start it; one cut short by a newer `load()` (`AbortError`, a film swapped mid-start)
 * is expected. Anything else is a real failure and is reported.
 */
function play(video: HTMLVideoElement, onRefused: () => void) {
  video.play().catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "NotAllowedError") onRefused();
    else if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
  });
}

/** Captions on by default (a phone often plays the film muted), unless the picture carries them. */
function showCaptions(video: HTMLVideoElement, burnedIn: boolean) {
  for (const track of Array.from(video.textTracks)) track.mode = burnedIn ? "disabled" : "showing";
}

/**
 * The walkthroughs player: one video, its film picked from the list
 * beside it. Nothing downloads until a film is asked for (`preload="none"`), and a film only
 * starts from a press (Watch, a list row, or the native controls).
 */
export function WalkthroughsPlayer() {
  const t = useTranslations();
  const videoRef = useRef<HTMLVideoElement>(null);
  const watchRef = useRef<HTMLButtonElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Before hydration the native controls are the way in; once the Watch pill works they wait
  // until a film plays.
  const [enhanced, setEnhanced] = useState(false);
  const [controlsOn, setControlsOn] = useState(false);
  const [onScreen, setOnScreen] = useState(false);

  const film = FILMS[current];
  const showControls = !enhanced || controlsOn || playing;
  const title = t(`Homepage.walkthroughs.films.${film.key}.title`);

  useEffect(() => setEnhanced(true), []);

  // The pill's breathing loop runs only while the player is on screen.
  useEffect(() => {
    const element = playerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setOnScreen(Boolean(entry?.isIntersecting))
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const showControlsOnRefusal = () => setControlsOn(true);

  function watch() {
    const video = videoRef.current;
    if (!video) return;
    // Hand focus to the video (now with its controls) before the pill fades out from under it.
    flushSync(() => setControlsOn(true));
    video.focus();
    play(video, showControlsOnRefusal);
  }

  function choose(index: number) {
    const video = videoRef.current;
    if (!video) return;
    if (index === current) {
      if (video.paused) play(video, showControlsOnRefusal);
      return;
    }
    flushSync(() => {
      setCurrent(index);
      setPlaying(false);
    });
    video.load();
    showCaptions(video, FILMS[index].burnedIn);
    play(video, showControlsOnRefusal);
  }

  function stop() {
    const video = videoRef.current;
    const hadFocus = video !== null && document.activeElement === video;
    flushSync(() => {
      setPlaying(false);
      setControlsOn(false);
    });
    // The video loses its controls, so focus would fall to the page: give it back to Watch.
    if (hadFocus) watchRef.current?.focus();
  }

  return (
    <div ref={playerRef} className={styles.player} data-on-screen={onScreen} data-playing={playing}>
      <div className={styles.frame}>
        <button
          ref={watchRef}
          type="button"
          className={styles.watch}
          aria-label={t("Homepage.walkthroughs.watchLabel", { title, seconds: film.seconds })}
          onClick={watch}
        >
          <span className={styles.watchKnob} aria-hidden="true">
            <PlayIcon />
          </span>
          <span>{t("Homepage.walkthroughs.watch")}</span>
          <em className={styles.watchTime}>{formatDuration(film.seconds)}</em>
        </button>
        <video
          ref={videoRef}
          className={styles.video}
          src={film.src}
          poster={film.poster}
          preload="none"
          playsInline
          controls={showControls}
          // Reachable whenever it has controls, in every engine: Watch hands focus to it.
          tabIndex={showControls ? 0 : undefined}
          aria-label={t(`Homepage.walkthroughs.films.${film.key}.videoLabel`)}
          onPlay={() => {
            setPlaying(true);
            setControlsOn(true);
          }}
          onEnded={stop}
          onLoadStart={(event) => {
            if (event.currentTarget.paused) setPlaying(false);
          }}
        >
          {/* re-keyed per film: a track whose src changes in place is not reloaded everywhere */}
          <track
            key={film.key}
            kind="captions"
            srcLang="en"
            label={t("Homepage.walkthroughs.captions")}
            src={film.captions}
            default={!film.burnedIn}
          />
        </video>
      </div>

      <ul className={styles.list} aria-label={t("Homepage.walkthroughs.chapters")}>
        {FILMS.map((item, index) => (
          <li key={item.key} className={styles.item}>
            <button
              type="button"
              className={styles.chapter}
              aria-current={index === current}
              onClick={() => choose(index)}
            >
              <span className={styles.knob} aria-hidden="true">
                <PlayIcon />
              </span>
              <b className={styles.chapterTitle}>
                {t(`Homepage.walkthroughs.films.${item.key}.title`)}
              </b>
              <small className={styles.chapterNote}>
                {t(`Homepage.walkthroughs.films.${item.key}.note`)}
              </small>
              <i className={styles.chapterTime}>{formatDuration(item.seconds)}</i>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
