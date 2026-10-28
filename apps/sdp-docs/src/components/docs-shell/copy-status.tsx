"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

const RESET_AFTER_MS = 2000;

/** The state of a copy button: `run` performs a copy and shows its outcome for two seconds. */
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

  return { status, run };
}

function announcementFor(status: CopyStatus, copied: string, failed: string): string {
  switch (status) {
    case "idle":
      return "";
    case "copied":
      return copied;
    case "failed":
      return failed;
    default: {
      const unreachable: never = status;
      throw new Error(`Unhandled copy status ${String(unreachable)}`);
    }
  }
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
      {announcementFor(status, copied, failed)}
    </span>
  );
}
