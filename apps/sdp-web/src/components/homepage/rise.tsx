"use client";

import { cn } from "@sdp/ui/cn";
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./rise.module.css";

/** Each block arrives this long after the one before it in its section. */
const RISE_STEP_MS = 110;

const RiseContext = createContext<{ arrived: boolean; index: number } | null>(null);

/**
 * Whether the enclosing `Rise` block has arrived on screen, or `null` outside any block. A
 * headline inside a block forms only once its block has landed.
 */
export function useRiseArrived(): boolean | null {
  return useContext(RiseContext)?.arrived ?? null;
}

/** How long after arriving the enclosing `Rise` block starts to come in, or 0 outside any block. */
export function useRiseDelay(): number {
  const rise = useContext(RiseContext);
  return rise ? rise.index * RISE_STEP_MS : 0;
}

type RiseProps = ComponentPropsWithoutRef<"div"> & {
  /** Position among the section's blocks; each one arrives 110ms after the one before (max 4). */
  index?: number;
  /** Fades in where it stands, without the rise and the wipe. */
  fade?: boolean;
};

/**
 * A block that wipes open and rises the first time it reaches the screen. A block already above
 * the screen (the page reopened halfway down) opens too, since it would never intersect. Under
 * reduced motion the CSS shows it at once; without script, the page's noscript style does
 * (`data-rise`).
 */
export function Rise({ index = 0, fade, className, style, children, ...rest }: RiseProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [arrived, setArrived] = useState(false);
  const step = Math.min(index, 4);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setArrived(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const viewportBottom = entry.rootBounds?.bottom ?? window.innerHeight;
        const passed = entry.boundingClientRect.top < viewportBottom;
        if (!entry.isIntersecting && !passed) return;
        setArrived(true);
        observer.disconnect();
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <RiseContext.Provider value={{ arrived, index: step }}>
      <div
        ref={ref}
        data-rise
        data-arrived={arrived}
        className={cn(styles.rise, fade && styles.fade, className)}
        // SAFETY: CSSProperties has no entry for custom properties; --rise-index is read by the
        // module CSS.
        style={{ ...style, "--rise-index": step } as CSSProperties}
        {...rest}
      >
        {children}
      </div>
    </RiseContext.Provider>
  );
}
