"use client";

import localFont from "next/font/local";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import styles from "./homepage.module.css";
import { DECIDING_LINE, type Ground, GroundContext, groundUnder } from "./homepage-ground";
import { onScrollFrame } from "./scroll-frame";

/**
 * Season Sans, the homepage's typeface (licensed for this page). It comes in
 * the two weights the design sets, regular and medium; Inter, the product's
 * face, stands in until it loads and for anything it does not cover.
 */
export const seasonSans = localFont({
  src: [
    {
      path: "../../fonts/SeasonSans-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../fonts/SeasonSans-Medium.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--hp-font",
  display: "swap",
  fallback: ["Inter Variable", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
});

/**
 * The homepage's outer element and its ground: one background behind the whole
 * page that turns from paper to night while a night section holds the middle
 * of the screen, and back, so the page darkens as a whole rather than band by
 * band. Paper sections are transparent over it; night sections and the hero
 * keep their own. It also carries the section tokens, the paper colour per
 * theme and the typeface. It is a plain container, not <main>: the bar inside
 * it must stay outside <main> to be the page banner.
 */
export function HomepageRoot({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ground, setGround] = useState<Ground>("paper");

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const sections = Array.from(root.querySelectorAll<HTMLElement>("[data-ground]"));
    return onScrollFrame(() => {
      const next = groundUnder(
        sections.map((section) => {
          const { top, bottom } = section.getBoundingClientRect();
          return { ground: section.dataset.ground ?? null, top, bottom };
        }),
        window.innerHeight * DECIDING_LINE
      );
      if (next) setGround(next);
    });
  }, []);

  return (
    <GroundContext.Provider value={ground}>
      <div
        ref={ref}
        data-page-ground={ground}
        className={cn(
          styles.home,
          seasonSans.variable,
          "[--hp-paper:var(--surface-raised)] dark:[--hp-paper:var(--surface)]",
          "[--hp-silver-end:#3a3842] dark:[--hp-silver-end:#c9c6d1]"
        )}
      >
        {children}
      </div>
    </GroundContext.Provider>
  );
}
