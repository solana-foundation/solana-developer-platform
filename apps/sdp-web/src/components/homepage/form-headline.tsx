"use client";

import { useInView, useReducedMotion } from "motion/react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./form-headline.module.css";
import { useRiseArrived } from "./rise";

/** A run of headline text, optionally wrapped in its own span (a highlighted phrase), or a line break. */
export type HeadlinePart = string | { text: string; className?: string } | { lineBreak: true };

/** "paint": the stages run on a CSS clock from first paint (`formAt`), never set by script. */
type FormState = "hidden" | "outline" | "mat" | "solid" | "paint";

type Word = { key: string; letters: { key: string; index: number; letter: string }[] };
type Run = { key: string; className?: string; items: (Word | " ")[] };
type Piece = Run | { key: string; lineBreak: true };

// Custom property names, kept out of the JSX so they read as style, not copy.
const LETTER_INDEX = "--letter-index";
const LETTER_STAGGER = "--letter-stagger";
const FORM_START = "--form-start";
const FORM_SPREAD = "--form-spread";

function partText(part: HeadlinePart): string {
  if (typeof part === "string") return part;
  return "text" in part ? part.text : " ";
}

/**
 * Splits the parts into runs of whole words of letters, numbering the letters across the whole
 * headline so they form one after another. Whitespace stays a plain space so lines can wrap.
 */
export function splitHeadline(parts: readonly HeadlinePart[]): {
  pieces: Piece[];
  letterCount: number;
} {
  let index = 0;
  const pieces = parts.map((part, partIndex): Piece => {
    const key = `p${partIndex}`;
    if (typeof part !== "string" && "lineBreak" in part) return { key, lineBreak: true };
    const items: (Word | " ")[] = [];
    for (const chunk of partText(part).split(/(\s+)/)) {
      if (!chunk) continue;
      if (/^\s+$/.test(chunk)) {
        items.push(" ");
        continue;
      }
      const letters = Array.from(chunk).map((letter) => {
        const letterIndex = index;
        index += 1;
        return { key: `l${letterIndex}`, index: letterIndex, letter };
      });
      items.push({ key: `w${letters[0]?.index}`, letters });
    }
    return { key, className: typeof part === "string" ? undefined : part.className, items };
  });
  return { pieces, letterCount: index };
}

type FormHeadlineProps = {
  as?: "h1" | "h2" | "h3";
  parts: readonly HeadlinePart[];
  className?: string;
  /** Milliseconds between letters. */
  stagger?: number;
  /**
   * Starts the headline from outside (the hero times its own). When omitted, the headline forms
   * 160ms after its `Rise` block arrives, or when it reaches the screen outside any block.
   */
  start?: boolean;
  /**
   * Forms this many milliseconds after first paint, on a CSS clock alone, so the headline never
   * waits on hydration (the hero's). `start` is then ignored.
   */
  formAt?: number;
};

/**
 * A headline whose letters form in (outline → blur → ink). Screen readers get the sentence once,
 * as plain text; the animated letters are hidden from them. Under reduced motion the CSS shows
 * the text at once; without script, the page's noscript style does (`data-form-letter`).
 */
export function FormHeadline({
  as: Tag = "h2",
  parts,
  className,
  stagger = 22,
  start,
  formAt,
}: FormHeadlineProps) {
  const ref = useRef<HTMLHeadingElement>(null);
  const riseArrived = useRiseArrived();
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px", amount: 0.2 });
  const reducedMotion = useReducedMotion();
  const paint = formAt !== undefined;
  const [state, setState] = useState<FormState>(paint ? "paint" : "hidden");

  const shouldStart = start ?? (riseArrived === null ? inView : riseArrived);
  const startDelay = start === undefined && riseArrived !== null ? 160 : 0;
  const { pieces, letterCount } = splitHeadline(parts);
  /* the later stages wait on the whole line a little: half its letters' stagger */
  const spread = letterCount * stagger * 0.5;

  useEffect(() => {
    if (paint || !shouldStart) return;
    if (reducedMotion) {
      setState("solid");
      return;
    }
    const timers = [
      window.setTimeout(() => setState("outline"), startDelay),
      window.setTimeout(() => setState("mat"), startDelay + 380 + spread * 0.4),
      window.setTimeout(() => setState("solid"), startDelay + 980 + spread * 0.6),
    ];
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [paint, shouldStart, reducedMotion, spread, startDelay]);

  const spoken = parts.map(partText).join("").replace(/\s+/g, " ").trim();

  return (
    <Tag
      ref={ref}
      className={cn(styles.headline, className)}
      data-state={state}
      style={
        {
          [LETTER_STAGGER]: stagger,
          [FORM_START]: paint ? `${formAt}ms` : undefined,
          [FORM_SPREAD]: paint ? spread : undefined,
        } as CSSProperties
      }
    >
      <span aria-hidden="true">
        {pieces.map((piece) =>
          "lineBreak" in piece ? (
            <br key={piece.key} />
          ) : (
            <span key={piece.key} className={piece.className}>
              {piece.items.map((item) =>
                item === " " ? (
                  " "
                ) : (
                  <span key={item.key} className={styles.word}>
                    {item.letters.map((letter) => (
                      <span
                        key={letter.key}
                        className={styles.letter}
                        data-form-letter
                        style={{ [LETTER_INDEX]: letter.index } as CSSProperties}
                      >
                        {letter.letter}
                      </span>
                    ))}
                  </span>
                )
              )}
            </span>
          )
        )}
      </span>
      <span className="sr-only">{spoken}</span>
    </Tag>
  );
}
