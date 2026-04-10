"use client";

import * as Sentry from "@sentry/nextjs";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef } from "react";

export function SentryFeedbackWidget() {
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
      className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-[16px] leading-[24px] font-[inherit] text-[rgba(28,28,29,0.76)] transition-colors hover:bg-[rgba(28,28,29,0.06)] hover:text-[#1c1c1d]"
    >
      <MessageSquarePlus className="h-5 w-5" strokeWidth={1.9} />
      <span>Feedback</span>
    </button>
  );
}
