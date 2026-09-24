"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { cn } from "@/lib/utils";
import styles from "./origami-scene.module.css";
import type { OrigamiKind } from "./scenes/origami/builds";
import { loadOrigami } from "./scenes/origami/load-origami";
import type { OrigamiHandle } from "./scenes/origami/mount-origami";

type OrigamiSceneProps = {
  kind: OrigamiKind;
  /** Camera distance, as the design tunes it per scene. */
  zoom: number;
  /** The scene's own motion runs only while this is true. */
  playing: boolean;
  className?: string;
};

/**
 * A small looping three.js scene, drawn as illustration: hidden from assistive
 * technology, loaded only once it is near the viewport, and simply absent
 * without WebGL.
 */
export function OrigamiScene({ kind, zoom, playing, className }: OrigamiSceneProps) {
  const { theme, hydrated } = useTheme();
  const reducedMotion = useReducedMotion() ?? false;
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OrigamiHandle | null>(null);
  const playingRef = useRef(playing);
  const nearViewport = useInView(hostRef, { once: true, margin: "200px" });
  const [failed, setFailed] = useState(false);
  const ground = theme === "dark" ? "dark" : "paper";

  useEffect(() => {
    const host = hostRef.current;
    if (!nearViewport || !hydrated || !host) return;
    let cancelled = false;

    loadOrigami().then(({ mountOrigami }) => {
      if (cancelled) return;
      const handle = mountOrigami(host, { kind, zoom, ground, reducedMotion });
      handleRef.current = handle;
      handle?.setPlaying(playingRef.current);
      setFailed(handle === null);
    });

    return () => {
      cancelled = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, [nearViewport, hydrated, kind, zoom, ground, reducedMotion]);

  useEffect(() => {
    playingRef.current = playing;
    handleRef.current?.setPlaying(playing);
  }, [playing]);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-failed={failed}
      className={cn(styles.scene, className)}
    />
  );
}
