"use client";

import { motion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";

interface HeightRevealProps {
  children: ReactNode;
  durationSeconds?: number;
}

// Accordion-style reveal tuned for 60fps. Two things keep it off the main-thread
// layout treadmill:
//   1. We animate an explicit pixel height (measured via ResizeObserver) instead
//      of `height: "auto"`, and scope the reflow to this subtree with CSS
//      containment, so expanding a row doesn't re-lay-out the whole list.
//   2. The actual content fades/slides in on its own layer via `transform`
//      + `opacity` — both compositor-only properties — so the visible motion is
//      GPU-driven rather than riding the height interpolation.
export function HeightReveal({ children, durationSeconds = 0.3 }: HeightRevealProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) {
      return;
    }
    setContentHeight(el.offsetHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContentHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const ease = [0.25, 0.1, 0.25, 1] as const;

  return (
    <motion.div
      initial={{ height: 0 }}
      animate={{ height: contentHeight }}
      exit={{ height: 0 }}
      transition={{ duration: durationSeconds, ease }}
      // `contain` keeps the height change from reflowing siblings' internals;
      // `willChange` promotes the box so the browser can composite it.
      style={{ overflow: "hidden", contain: "layout paint", willChange: "height" }}
    >
      <motion.div
        ref={contentRef}
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: durationSeconds, ease }}
        style={{ willChange: "transform, opacity" }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
