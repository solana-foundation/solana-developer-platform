"use client";

import * as Sentry from "@sentry/nextjs";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export function SentryFeedbackWidget({ collapsed = false }: { collapsed?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const feedback = Sentry.getFeedback();
    if (!feedback || !ref.current) return;
    return feedback.attachTo(ref.current);
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      title={collapsed ? "Feedback" : undefined}
      aria-label={collapsed ? "Feedback" : undefined}
      className={cn(
        "flex h-10 w-full items-center gap-3 rounded-[var(--button-radius-lg)] px-3 text-base text-text-medium transition-colors hover:bg-border-light hover:text-text-extra-high",
        collapsed && "justify-center"
      )}
    >
      <MessageSquarePlus className="h-5 w-5 shrink-0" strokeWidth={1.9} />
      {collapsed ? null : <span className="whitespace-nowrap">Feedback</span>}
    </button>
  );
}
