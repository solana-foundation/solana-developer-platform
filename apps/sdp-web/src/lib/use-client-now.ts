"use client";

import { useEffect, useState } from "react";

/**
 * The current time, read only in the browser: null on the server render and the first client
 * render, so the two agree, then refreshed every `intervalMs` so a relative age keeps counting.
 */
export function useClientNow(intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
