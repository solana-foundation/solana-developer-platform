"use client";

import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import styles from "./rise.module.css";

const RiseContext = createContext<boolean | null>(null);

/**
 * Whether the enclosing `Rise` block has arrived on screen, or `null` outside any block. A
 * headline inside a block forms only once its block has landed.
 */
export function useRiseArrived(): boolean | null {
  return useContext(RiseContext);
}

type RiseProps = ComponentPropsWithoutRef<"div"> & {
  /** Position among the section's blocks; each one arrives 110ms after the one before (max 4). */
  index?: number;
};

/**
 * A block that wipes open and rises the first time it reaches the screen. A block already above
 * the screen (the page reopened halfway down) opens too, since it would never intersect. Under
 * reduced motion the CSS shows it at once; without script, the page's noscript style does
 * (`data-rise`).
 */
export function Rise({ index = 0, className, style, children, ...rest }: RiseProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [arrived, setArrived] = useState(false);

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
    <RiseContext.Provider value={arrived}>
      <div
        ref={ref}
        data-rise
        data-arrived={arrived}
        className={cn(styles.rise, className)}
        style={{ ...style, "--rise-index": Math.min(index, 4) } as CSSProperties}
        {...rest}
      >
        {children}
      </div>
    </RiseContext.Provider>
  );
}
