"use client";

import * as Sentry from "@sentry/nextjs";
import { MessageSquarePlus } from "lucide-react";
import { useEffect, useRef } from "react";

const SENTRY_FEEDBACK_HOST_ID = "sentry-feedback";
const SENTRY_FEEDBACK_STYLE_ID = "sdp-sentry-feedback-overrides";

function injectSentryFeedbackStyles() {
  const host = document.getElementById(SENTRY_FEEDBACK_HOST_ID);
  const shadowRoot = host?.shadowRoot;
  if (!shadowRoot || shadowRoot.getElementById(SENTRY_FEEDBACK_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = SENTRY_FEEDBACK_STYLE_ID;
  style.textContent = `
    .form__input {
      background: #ffffff;
      border: 1.5px solid rgba(28, 28, 29, 0.16);
      border-radius: 12px;
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }

    .form__input:hover {
      border-color: rgba(28, 28, 29, 0.24);
    }

    .form__input:focus-visible {
      border-color: rgba(15, 15, 16, 0.48);
      box-shadow: 0 0 0 3px rgba(15, 15, 16, 0.08);
      outline: none;
    }

    .form__input::placeholder {
      color: rgba(28, 28, 29, 0.44);
      opacity: 1;
      filter: none;
    }
  `;

  shadowRoot.append(style);
}

export function SentryFeedbackWidget() {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const feedback = Sentry.getFeedback();
    if (!feedback || !ref.current) return;

    const unsubscribe = feedback.attachTo(ref.current);
    injectSentryFeedbackStyles();

    const observer = new MutationObserver(() => {
      injectSentryFeedbackStyles();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      unsubscribe();
    };
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
