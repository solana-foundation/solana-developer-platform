"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useRef, useState } from "react";

type Vote = "up" | "down";
type Step = "vote" | "comment" | "done";

export function PageFeedback() {
  const [step, setStep] = useState<Step>("vote");
  const [vote, setVote] = useState<Vote | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function handleVote(next: Vote) {
    setVote(next);
    setStep("comment");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function handleSubmit() {
    setSubmitting(true);
    // TODO: wire to analytics/backend. No endpoint exists yet — submissions are intentionally
    // dropped so the UI can ship while the backend is built.
    const payload = { vote, comment, path: window.location.pathname };
    if (process.env.NODE_ENV !== "production") {
      console.warn("[PageFeedback] no backend wired — dropping payload", payload);
    }
    setSubmitting(false);
    setStep("done");
  }

  if (step === "done") {
    return (
      <div className="page-feedback">
        <span className="page-feedback-label page-feedback-thanks">
          Thank you for your feedback!
        </span>
      </div>
    );
  }

  return (
    <div className="page-feedback page-feedback--col">
      <div className="page-feedback-row">
        <span className="page-feedback-label">Is this page helpful?</span>
        <div className="page-feedback-actions">
          <button
            type="button"
            aria-label="Yes, this page is helpful"
            aria-pressed={vote === "up"}
            className={`page-feedback-btn${vote === "up" ? " is-active" : ""}`}
            onClick={() => handleVote("up")}
          >
            <ThumbsUp size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="No, this page is not helpful"
            aria-pressed={vote === "down"}
            className={`page-feedback-btn${vote === "down" ? " is-active" : ""}`}
            onClick={() => handleVote("down")}
          >
            <ThumbsDown size={16} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {step === "comment" && (
        <div className="page-feedback-form">
          <textarea
            ref={textareaRef}
            className="page-feedback-textarea"
            placeholder="Please share your feedback to help improve this content."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
          />
          <button
            type="button"
            className="page-feedback-submit"
            disabled={submitting}
            onClick={handleSubmit}
          >
            {submitting ? "Sending…" : "Submit"}
          </button>
        </div>
      )}
    </div>
  );
}
