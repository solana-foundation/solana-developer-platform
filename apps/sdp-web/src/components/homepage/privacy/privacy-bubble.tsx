"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import bubble from "../bubble.module.css";
import { bubbleClockStart, fitPill, runBubbleLoop } from "../bubble-motion";
import { useRiseArrived } from "../rise";
import styles from "./privacy-bubble.module.css";

/**
 * One cycle: a word holds, the pill folds into a switch that is off, the switch turns on, and the
 * pill opens on the next word.
 */
const HOLD = 2300;
const T_FOLD = HOLD;
const T_ON = HOLD + 900;
const T_OPEN = HOLD + 1450;
const PERIOD = HOLD + 1500;
/** Privacy's place in the page's bubble order: after the stack's three, the pillars' three and payments'. */
const SLOT = 7;

type PrivacyBubbleProps = {
  /** What the picture says, for assistive technology. */
  label: string;
  /** The words that take turns in the pill; the first one shows before the cycle starts. */
  words: string[];
};

/**
 * The privacy picture: a green pill in two rings with one word in it. The pill folds into a switch,
 * the switch turns on (its padlock closes), and the pill opens on the next word. It is a picture,
 * not a control: nothing in it is focusable. Under a mouse the timeline holds and moving the
 * pointer up and down drives a wave through the rings instead.
 */
export function PrivacyBubble({ label, words }: PrivacyBubbleProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const wordsRef = useRef<HTMLSpanElement>(null);
  const arrived = useRiseArrived() ?? true;
  const reducedMotion = useReducedMotion();
  const count = words.length;

  useEffect(() => {
    const root = rootRef.current;
    const pill = pillRef.current;
    const wordList = wordsRef.current;
    if (!root || !pill || !wordList || count === 0) return;
    const items = Array.from(wordList.children) as HTMLElement[];

    let current = 0;
    const fitWord = (index: number) => fitPill(pill, items[index]);
    const refit = () => {
      if (!root.hasAttribute("data-tg")) fitWord(current);
    };

    fitWord(0);
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) refit();
    });
    window.addEventListener("resize", refit);

    if (!arrived || reducedMotion) {
      return () => {
        disposed = true;
        window.removeEventListener("resize", refit);
      };
    }

    const show = (index: number) => {
      current = index;
      items.forEach((item, n) => {
        item.toggleAttribute("data-current", n === index);
      });
    };

    const stop = runBubbleLoop(root, ({ beat }) => {
      let clock = bubbleClockStart(SLOT);
      let stage = 0;

      return (dt) => {
        clock += dt;
        if (clock < 0) return;
        if (stage === 0 && clock >= T_FOLD) {
          stage = 1;
          // folded, the pill takes the switch's width and the switch starts off
          pill.style.width = "var(--tw)";
          root.setAttribute("data-tg", "");
          root.setAttribute("data-off", "");
        }
        if (stage === 1 && clock >= T_ON) {
          stage = 2;
          root.setAttribute("data-on", "");
          root.removeAttribute("data-off");
          beat();
        }
        if (stage === 2 && clock >= T_OPEN) {
          stage = 3;
          show((current + 1) % count);
          root.removeAttribute("data-tg");
          fitWord(current);
        }
        if (stage === 3 && clock >= PERIOD) {
          stage = 0;
          clock = 0;
          root.removeAttribute("data-on");
        }
      };
    });

    return () => {
      disposed = true;
      stop();
      window.removeEventListener("resize", refit);
      // back to the first word, unfolded, for a fresh start
      for (const name of ["data-tg", "data-on", "data-off", "data-beat", "data-hand"]) {
        root.removeAttribute(name);
      }
      show(0);
    };
  }, [arrived, reducedMotion, count]);

  return (
    <div
      ref={rootRef}
      className={cn(bubble.bubble, bubble.mint, styles.bubble)}
      data-paused=""
      role="img"
      aria-label={label}
    >
      <div className={cn(bubble.ring, styles.outer)}>
        <div className={bubble.inner}>
          <div ref={pillRef} className={cn(bubble.pill, styles.pill)}>
            <span className={styles.knob} aria-hidden="true">
              <svg className={styles.lock} viewBox="0 0 24 24" aria-hidden="true">
                <rect x="5.5" y="10.5" width="13" height="9.5" rx="2.2" />
                <path className={styles.shackleClosed} d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
                <path className={styles.shackleOpen} d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
              </svg>
            </span>
            <span ref={wordsRef} className={styles.words} aria-hidden="true">
              {words.map((word, index) => (
                <span
                  key={word}
                  className={styles.word}
                  data-current={index === 0 ? "" : undefined}
                >
                  {word}
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
