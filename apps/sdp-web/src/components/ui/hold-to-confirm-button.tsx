"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// Press-and-hold confirmation for serious/irreversible actions. The circular ring fills
// over `holdMs`; onConfirm fires only on a full hold and cancels on early release.
// Reduced-motion users still hold for the full duration, but the ring jumps (no tween).
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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef(0);

  const reset = useCallback(() => {
    setHolding(false);
    setProgress(0);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => reset, [reset]);

  const start = () => {
    if (disabled || holding) {
      return;
    }
    setHolding(true);
    const fire = () => {
      reset();
      void onConfirm();
    };
    if (reduced) {
      setProgress(1);
      timerRef.current = setTimeout(fire, holdMs);
      return;
    }
    startRef.current = performance.now();
    const tick = () => {
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
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={reset}
      onPointerLeave={reset}
      onPointerCancel={reset}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border border-error-border bg-error-bg px-3 py-1.5 text-sm font-medium text-error transition-colors select-none disabled:opacity-50",
        holding && "bg-error-bg/80",
        className
      )}
      aria-label={holding ? holdingLabel : label}
    >
      <span className="relative inline-flex h-5 w-5 items-center justify-center">
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
            strokeOpacity={0.25}
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
    </button>
  );
}
