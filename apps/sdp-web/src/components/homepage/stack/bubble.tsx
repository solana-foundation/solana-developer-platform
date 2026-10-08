import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import bubble from "../bubble.module.css";
import styles from "./stack.module.css";

type BubbleProps = {
  ref?: Ref<HTMLDivElement>;
  className: string;
  tone: "grey" | "violet" | "mint";
  /** What the bubble says, as a whole; its cycling words are presentational. */
  ariaLabel: string;
  words: readonly { key: string; content: ReactNode }[];
  activeIndex: number;
};

/** A pill in two rings, showing one of its words at a time. */
export function Bubble({ ref, className, tone, ariaLabel, words, activeIndex }: BubbleProps) {
  return (
    <div
      ref={ref}
      className={cn(bubble.bubble, bubble[tone], styles.bubble, className)}
      role="img"
      aria-label={ariaLabel}
    >
      <div className={bubble.ring}>
        <div className={bubble.inner}>
          <div className={cn(bubble.pill, styles.pill)}>
            {words.map((word, index) => (
              <span
                key={word.key}
                className={styles.word}
                data-on={index === activeIndex ? "" : undefined}
              >
                {word.content}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
