import { useEffect, useState } from "react";
import { PhoneFrame } from "@/components/phone-frame";
import { type EarnPhase, EarnScreen } from "@/components/wallet-app";
import { useInView } from "@/hooks/use-in-view";
import { EARN_DAYS } from "@/lib/yield";

const PRESS_DELAY_MS = 700;
const PRESS_MS = 900;
const CONFIRM_MS = 1_800;
const ACCRUE_MS = 7_000;

function easeInOutCubic(progress: number): number {
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
}

/**
 * Step 3 centerpiece: when the phone scrolls into view the "Earn 8.43%" button
 * presses itself, a confirmation appears, and then 30 days of yield fast-
 * forward with a rising balance chart. Replayable on demand.
 */
export function EarnDemo() {
  const { ref, inView } = useInView<HTMLDivElement>(0.45);
  const [phase, setPhase] = useState<EarnPhase>("idle");
  const [day, setDay] = useState(0);

  // Kick the sequence off once the phone is comfortably in view.
  useEffect(() => {
    if (!inView || phase !== "idle") return;
    const timer = window.setTimeout(() => setPhase("pressing"), PRESS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [inView, phase]);

  // Walk pressing -> confirming -> accruing on fixed delays.
  useEffect(() => {
    if (phase !== "pressing" && phase !== "confirming") return;
    const delay = phase === "pressing" ? PRESS_MS : CONFIRM_MS;
    const timer = window.setTimeout(
      () => setPhase(phase === "pressing" ? "confirming" : "accruing"),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Fast-forward the accrual with a rAF sweep across the 30-day horizon.
  useEffect(() => {
    if (phase !== "accruing") return;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / ACCRUE_MS, 1);
      setDay(easeInOutCubic(progress) * EARN_DAYS);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        setPhase("done");
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  function replay() {
    setDay(0);
    setPhase("idle");
  }

  return (
    <div ref={ref} className="flex flex-col items-center gap-4">
      <PhoneFrame>
        <EarnScreen
          phase={phase}
          day={day}
          onPress={() => {
            if (phase === "idle") setPhase("pressing");
          }}
        />
      </PhoneFrame>
      <button
        type="button"
        onClick={replay}
        className="rounded-full border border-foreground/15 bg-background px-4 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted"
      >
        Replay the flow
      </button>
    </div>
  );
}
