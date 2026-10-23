"use client";

import { useReducedMotion } from "motion/react";
import { useRef } from "react";
import { useLazyScene } from "@/lib/use-scene-active";
import styles from "./start.module.css";
import { StartMark } from "./start-mark";

/**
 * The close's Solana mark: drawn as light (close-light.ts) once it can be, the glass mark until
 * then and wherever WebGL is missing or lost. The light keeps its headline (`data-light-clearing`
 * in the same section) on clean ground.
 */
export function StartLight() {
  const reducedMotion = useReducedMotion() ?? false;
  const hostRef = useRef<HTMLDivElement>(null);

  const mode = useLazyScene(hostRef, {
    load: () => import("./close-light"),
    create: ({ createCloseLight }, reduced, onLost) => {
      const host = hostRef.current;
      const copy = host?.closest("section")?.querySelector<HTMLElement>("[data-light-clearing]");
      if (!host || !copy) return null;
      return createCloseLight({
        host,
        copy,
        canvasClassName: styles.lightCanvas,
        reducedMotion: reduced,
        onLost,
      });
    },
    settings: reducedMotion,
    activeThreshold: 0,
  });

  return (
    <>
      <div ref={hostRef} className={styles.light} data-mode={mode} aria-hidden="true" />
      {mode === "live" ? null : <StartMark className={styles.mark} />}
    </>
  );
}
