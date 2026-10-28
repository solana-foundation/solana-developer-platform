"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

const RESET_AFTER_MS = 2000;

/**
 * The state of a copy button: `run` performs a copy and shows its outcome for two seconds,
 * `reset` clears it (when the thing to copy changes).
 */
export function useCopyStatus() {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = useCallback((copy: () => Promise<void>) => {
    window.clearTimeout(timer.current);
    copy()
      .then(
        () => setStatus("copied"),
        () => setStatus("failed")
      )
      .finally(() => {
        timer.current = window.setTimeout(() => setStatus("idle"), RESET_AFTER_MS);
      });
  }, []);

  const reset = useCallback(() => {
    window.clearTimeout(timer.current);
    setStatus("idle");
  }, []);

  return { status, run, reset };
}

/** Copy, check and alert icons stacked in one box, so the swap morphs in place. */
export function CopyStatusIcon({ status }: { status: CopyStatus }) {
  return (
    <span className="launch-copy-icon" data-status={status} aria-hidden="true">
      <Copy className="launch-copy-icon-idle" />
      <Check className="launch-copy-icon-copied" />
      <TriangleAlert className="launch-copy-icon-failed" />
    </span>
  );
}

/** Announces the outcome to screen readers; the icon swap is visual only. */
export function CopyStatusAnnouncement({
  status,
  copied,
  failed,
}: {
  status: CopyStatus;
  copied: string;
  failed: string;
}) {
  return (
    <span className="visually-hidden" aria-live="polite">
      {status === "copied" ? copied : status === "failed" ? failed : ""}
    </span>
  );
}
