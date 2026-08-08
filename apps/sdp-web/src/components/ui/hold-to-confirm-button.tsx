"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// Reduced-motion progress advances in discrete steps so the ring stays honest
// (an instantly-full ring would claim completion at t=0).
const REDUCED_MOTION_STEPS = 8;

// Press-and-hold confirmation for serious/irreversible actions. The circular ring fills
// over `holdMs`; onConfirm fires only on a full hold and cancels on early release.
// Holdable by pointer AND keyboard (hold Space/Enter). Composed on the design-system
// Button so height, focus ring and spacing match adjacent buttons.
export function HoldToConfirmButton({
  onConfirm,
  label,
  holdingLabel = "Hold to confirm…",
  holdMs = 5000,
  disabled,
  className,
}: {
  onConfirm: () => void | Promise<void>;
  label: string;
  holdingLabel?: string;
  holdMs?: number;
  disabled?: boolean;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const rafRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startRef = useRef(0);
  // Live mirror of `disabled` so an in-flight hold bails when the button disables
  // mid-hold (the rAF loop would otherwise still fire onConfirm).
  const disabledRef = useRef(Boolean(disabled));
  disabledRef.current = Boolean(disabled);

  const reset = useCallback(() => {
    setHolding(false);
    setProgress(0);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => reset, [reset]);

  const start = () => {
    if (disabled || holding) {
      return;
    }
    setHolding(true);
    const fire = () => {
      const blocked = disabledRef.current;
      reset();
      if (!blocked) {
        void onConfirm();
      }
    };
    if (reduced) {
      let step = 0;
      const stepMs = holdMs / REDUCED_MOTION_STEPS;
      intervalRef.current = setInterval(() => {
        if (disabledRef.current) {
          reset();
          return;
        }
        step += 1;
        setProgress(step / REDUCED_MOTION_STEPS);
        if (step >= REDUCED_MOTION_STEPS) {
          fire();
        }
      }, stepMs);
      return;
    }
    startRef.current = performance.now();
    const tick = () => {
      if (disabledRef.current) {
        reset();
        return;
      }
      const p = Math.min((performance.now() - startRef.current) / holdMs, 1);
      setProgress(p);
      if (p >= 1) {
        fire();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const radius = 9;
  const circumference = 2 * Math.PI * radius;

  return (
    <Button asChild variant="destructive" size="sm">
      <button
        type="button"
        disabled={disabled}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          start();
        }}
        onPointerUp={reset}
        onPointerLeave={reset}
        onPointerCancel={reset}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            event.preventDefault();
            start();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            reset();
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
        className={cn("select-none touch-none", className)}
        aria-label={holding ? holdingLabel : label}
      >
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label={holdingLabel}
          className="relative inline-flex h-5 w-5 items-center justify-center"
        >
          <svg
            viewBox="0 0 22 22"
            className="h-5 w-5 -rotate-90"
            aria-hidden="true"
            role="presentation"
          >
            <circle
              cx="11"
              cy="11"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={2}
            />
            <circle
              cx="11"
              cy="11"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
            />
          </svg>
        </span>
        {holding ? holdingLabel : label}
        <span aria-live="polite" className="sr-only">
          {holding ? holdingLabel : ""}
        </span>
      </button>
    </Button>
  );
}
