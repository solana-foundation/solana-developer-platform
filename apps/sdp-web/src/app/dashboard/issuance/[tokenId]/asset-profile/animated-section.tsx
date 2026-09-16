"use client";

import { ChevronDown } from "lucide-react";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { type ReactNode, useId, useState } from "react";

export function AnimatedSection({
  id,
  title,
  children,
  open: controlledOpen,
  onOpenChange,
  className = "scroll-mt-6 py-5",
}: {
  id?: string;
  title: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const contentId = useId();
  const triggerId = useId();
  const reducedMotion = useReducedMotion();
  const transition = { duration: reducedMotion ? 0 : 0.22, ease: [0.22, 1, 0.36, 1] as const };

  return (
    <LazyMotion features={domAnimation}>
      <section id={id} className={className}>
        <button
          id={triggerId}
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          className="flex w-full items-center justify-between rounded text-left text-sm font-medium text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-strong"
          onClick={() => (onOpenChange ?? setLocalOpen)(!open)}
        >
          {title}
          <m.span initial={false} animate={{ rotate: open ? 180 : 0 }} transition={transition}>
            <ChevronDown className="size-4" aria-hidden />
          </m.span>
        </button>
        {/* This short, user-triggered accordion transition must reclaim document
            space. A transform would leave a gap or scale the form controls.
            Reduced motion disables it; collapsed content stays inert. */}
        <m.div
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          aria-hidden={!open}
          inert={!open}
          initial={false}
          animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
          transition={transition}
          className="overflow-hidden"
        >
          {children}
        </m.div>
      </section>
    </LazyMotion>
  );
}
