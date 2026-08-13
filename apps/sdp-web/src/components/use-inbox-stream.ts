"use client";

import { useEffect, useRef } from "react";

export interface InboxNudge {
  unread: number;
  ts: string;
}

// Live inbox nudges over SSE. Purely additive to the bell's 60s polling — when the
// stream is down (deploys, proxies, unsupported browsers) polling remains the source
// of truth, so every failure mode here is "do nothing and let polling catch up".
//
// Reconnect model: the API self-closes streams at ~4 minutes, which EventSource
// retries natively (readyState CONNECTING). A CLOSED source means a fatal response
// (401/5xx from the BFF) where EventSource gives up — those recreate manually with
// capped exponential backoff.
export function useInboxStream(onNudge: (nudge: InboxNudge) => void): void {
  const callbackRef = useRef(onNudge);
  callbackRef.current = onNudge;

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      return;
    }
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source = new EventSource("/api/dashboard/notifications/stream");
      source.addEventListener("ready", () => {
        attempts = 0;
      });
      source.addEventListener("notification", (event) => {
        try {
          const nudge = JSON.parse((event as MessageEvent).data) as Partial<InboxNudge>;
          if (typeof nudge.unread === "number") {
            callbackRef.current({ unread: nudge.unread, ts: nudge.ts ?? "" });
          }
        } catch {
          // Malformed frame — polling covers it.
        }
      });
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          attempts += 1;
          retryTimer = setTimeout(connect, Math.min(60_000, 2_000 * 2 ** attempts));
        }
        // CONNECTING → native auto-reconnect is already underway; leave it alone.
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);
}
