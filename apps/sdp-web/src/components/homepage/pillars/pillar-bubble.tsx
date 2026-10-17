"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import bubble from "../bubble.module.css";
import { bubbleClockStart, runBubbleLoop } from "../bubble-motion";
import { useRiseArrived } from "../rise";
import styles from "./pillar-bubble.module.css";

export type PillarBubbleKind = "coin" | "send" | "swap";

/** One gesture per cycle: on at 700ms, back at 1900ms, again at 2800ms. */
const T_ON = 700;
const T_OPEN = 1900;
const PERIOD = 2800;
/** The first pillar's place in the page's bubble order: after the stack's three. */
const FIRST_SLOT = 3;

type PillarBubbleProps = {
  kind: PillarBubbleKind;
  label: string;
  /** Position among the three pillars (0..2), for the stagger. */
  order: number;
};

/**
 * The pillar's picture: a violet pill in two rings that repeats one gesture (issuance mints a
 * coin, payments sends a dot across, markets swaps two legs). Decorative motion only: the label
 * carries the meaning.
 */
export function PillarBubble({ kind, label, order }: PillarBubbleProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<HTMLSpanElement>(null);
  const arrived = useRiseArrived() ?? true;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !arrived || reducedMotion) return;

    return runBubbleLoop(root, ({ later, beat }) => {
      let clock = bubbleClockStart(FIRST_SLOT + order);
      let stage = 0;
      let rotation = 0;

      // the gesture's two moves: on (a beat, the swap's half turn) and back
      const turnOn = () => {
        root.removeAttribute("data-rs");
        root.setAttribute("data-on", "");
        if (kind === "swap" && orbRef.current) {
          rotation += 180;
          orbRef.current.style.transform = `rotate(${rotation}deg)`;
        }
        if (kind === "coin") later(beat, 560);
        else beat();
      };
      const turnBack = () => {
        if (kind === "send") {
          root.setAttribute("data-rs", "");
          later(() => root.removeAttribute("data-on"), 260);
        } else {
          root.removeAttribute("data-on");
        }
      };

      return (dt) => {
        clock += dt;
        if (clock < 0) return;
        if (stage === 0 && clock >= T_ON) {
          stage = 1;
          turnOn();
        }
        if (stage === 1 && clock >= T_OPEN) {
          stage = 2;
          turnBack();
        }
        if (stage === 2 && clock >= PERIOD) {
          stage = 0;
          clock = 0;
          root.removeAttribute("data-rs");
        }
      };
    });
  }, [arrived, reducedMotion, kind, order]);

  return (
    <div
      ref={rootRef}
      className={cn(bubble.bubble, bubble.violet, styles.bubble)}
      data-kind={kind}
      data-paused=""
      role="img"
      aria-label={label}
    >
      <div className={bubble.ring}>
        <div className={bubble.inner}>
          <div className={cn(bubble.pill, styles.pill)}>
            {kind === "swap" ? (
              <span ref={orbRef} className={styles.orb} aria-hidden="true">
                <span className={styles.leg} />
                <span className={cn(styles.leg, styles.cash)} />
              </span>
            ) : (
              <span className={styles.knob} aria-hidden="true" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
