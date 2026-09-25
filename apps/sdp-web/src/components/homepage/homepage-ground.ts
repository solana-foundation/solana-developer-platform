"use client";

import { createContext, useContext } from "react";

export type Ground = "paper" | "night";

/** How far down the screen the section that decides the ground is read, as the design sets it. */
export const DECIDING_LINE = 0.62;

/**
 * The ground of the section under `line` (px from the top of the viewport),
 * or null when no marked section is there, which leaves the ground as it was.
 */
export function groundUnder(
  sections: readonly { ground: string | null; top: number; bottom: number }[],
  line: number
): Ground | null {
  for (const section of sections) {
    if (section.top <= line && section.bottom > line) {
      if (section.ground === "night" || section.ground === "paper") return section.ground;
    }
  }
  return null;
}

export const GroundContext = createContext<Ground>("paper");

/** The page's current ground, for the bar, which takes the ground's colours with it. */
export function useHomepageGround(): Ground {
  return useContext(GroundContext);
}
