"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { OrigamiScene } from "./origami-scene";
import styles from "./pillars-section.module.css";
import type { OrigamiKind } from "./scenes/origami/builds";

/** How long a scene keeps moving after the pointer or focus has left. */
const REST_DELAY_MS = 1400;

type PillarProps = {
  scene: { kind: OrigamiKind; zoom: number };
  children: ReactNode;
};

/**
 * One pillar. Its scene forms when it comes into view and then rests; it
 * moves while the pointer is over the pillar or focus is inside it, and
 * settles a moment after either leaves.
 */
export function Pillar({ scene, children }: PillarProps) {
  const [playing, setPlaying] = useState(false);
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(restTimer.current), []);

  const wake = () => {
    clearTimeout(restTimer.current);
    setPlaying(true);
  };
  const rest = () => {
    clearTimeout(restTimer.current);
    restTimer.current = setTimeout(() => setPlaying(false), REST_DELAY_MS);
  };

  return (
    <li
      className={styles.pillar}
      onPointerEnter={wake}
      onPointerLeave={rest}
      onFocus={wake}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) rest();
      }}
    >
      <OrigamiScene
        kind={scene.kind}
        zoom={scene.zoom}
        playing={playing}
        className={styles.scene}
      />
      {children}
    </li>
  );
}
