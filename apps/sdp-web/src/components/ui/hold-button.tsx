"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface HoldButtonProps {
  onHoldComplete: () => void;
  children: ReactNode;
  iconLeft?: ReactNode;
  holdMs?: number;
  disabled?: boolean;
  className?: string;
}

export function HoldButton({
  onHoldComplete,
  children,
  iconLeft,
  holdMs = 1100,
  disabled,
  className,
}: HoldButtonProps) {
  const [holding, setHolding] = useState(false);

  function start() {
    if (!disabled) setHolding(true);
  }

  function cancel() {
    setHolding(false);
  }

  const content = (
    <>
      {iconLeft}
      {children}
    </>
  );

  return (
    <Button asChild variant="secondary">
      <button
        type="button"
        disabled={disabled}
        className={cn("relative select-none overflow-hidden", className)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          start();
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onKeyDown={(event) => {
          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            event.preventDefault();
            start();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <span className="inline-flex items-center gap-[var(--button-gap-lg)]">{content}</span>
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 inline-flex items-center justify-center gap-[var(--button-gap-lg)] bg-[#e5484d] text-white"
          initial={{ clipPath: "inset(0 100% 0 0)" }}
          animate={{ clipPath: holding ? "inset(0 0% 0 0)" : "inset(0 100% 0 0)" }}
          transition={{ duration: holding ? holdMs / 1000 : 0.2, ease: "linear" }}
          onAnimationComplete={() => {
            if (holding) {
              setHolding(false);
              onHoldComplete();
            }
          }}
        >
          {content}
        </motion.span>
      </button>
    </Button>
  );
}
