"use client";

import { type RefObject, useEffect, useState } from "react";
import { ANCHOR_OFFSET } from "../layout";
import { NAV_GROUP_IDS, type NavGround, type NavGroupId } from "./nav-types";

/** The section under this share of the viewport's height decides the bar's ground. */
const GROUND_LINE = 0.62;

/**
 * The ground of the section under `line` (px from the viewport's top). Sections mark themselves
 * with `data-ground="paper" | "night"`; a section without the mark counts as paper.
 */
export function pickGround(navRoot: Element | null, line: number): NavGround {
  for (const el of document.querySelectorAll<HTMLElement>("[data-ground]")) {
    if (navRoot?.contains(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top <= line && rect.bottom > line) {
      return el.dataset.ground === "night" ? "night" : "paper";
    }
  }
  return "paper";
}

/**
 * The bar's scroll-driven state: its ground (paper or night, from the section under the 62%
 * line) and whether the page has moved (the border). While mounted it also gives in-page anchors
 * room under the sticky bar (ANCHOR_OFFSET).
 */
export function useNavScroll(navRoot: RefObject<HTMLElement | null>) {
  const [ground, setGround] = useState<NavGround>("paper");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    const previousPadding = html.style.scrollPaddingTop;
    html.style.scrollPaddingTop = `${ANCHOR_OFFSET}px`;

    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(window.scrollY > 8);
      setGround(pickGround(navRoot.current, window.innerHeight * GROUND_LINE));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      html.style.scrollPaddingTop = previousPadding;
    };
  }, [navRoot]);

  return { ground, scrolled };
}

const { platform, builders, docs } = NAV_GROUP_IDS;

/** Which group's part of the page each section belongs to (`null`: none, the hero). */
const SECTION_GROUP: Record<string, NavGroupId | null> = {
  top: null,
  stack: platform,
  pillars: platform,
  network: platform,
  issuance: platform,
  payments: platform,
  markets: platform,
  privacy: platform,
  interfaces: docs,
  builders,
  blog: builders,
  start: docs,
};

/** The id of the group whose part of the page is in the middle of the screen. */
export function useScrollSpy(): NavGroupId | null {
  const [here, setHere] = useState<NavGroupId | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setHere(SECTION_GROUP[entry.target.id] ?? null);
        }
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 }
    );
    for (const id of Object.keys(SECTION_GROUP)) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return here;
}
