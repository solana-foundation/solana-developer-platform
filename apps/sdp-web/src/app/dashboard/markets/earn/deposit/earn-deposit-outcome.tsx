"use client";

import type { ReactNode } from "react";

/**
 * Shared frame for the flow's post-confirm screens (API integration, then the
 * live program). These are outcomes rather than wizard steps: the program
 * already exists, so they drop the step rail and keep only a stable footer.
 *
 * The scroll region carries `data-earn-outcome-scroll` because the wizard's
 * pre-paint scroll/focus reset targets whichever region is mounted — an Earn
 * module rule: every screen lands already at the top.
 */
export function OutcomeFrame({
  children,
  description,
  eyebrow,
  footer,
  title,
}: {
  children: ReactNode;
  description: ReactNode;
  eyebrow: string;
  footer: ReactNode;
  title: string;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-surface-raised">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 md:px-6" data-earn-outcome-scroll>
        <div className="mx-auto w-full max-w-4xl py-8">
          <div className="mb-7 min-w-0">
            <p className="text-xs font-semibold tracking-[0.08em] text-tertiary uppercase">
              {eyebrow}
            </p>
            <h2 className="mt-2 text-2xl font-medium tracking-tight text-primary">{title}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-secondary">{description}</p>
          </div>
          {children}
        </div>
      </div>
      <footer className="shrink-0 border-t border-border-default bg-surface-raised/95 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6">
        <div className="mx-auto w-full max-w-4xl">{footer}</div>
      </footer>
    </div>
  );
}
