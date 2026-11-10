import { vi } from "vitest";
import * as events from "@/runtime/money-path-events";

/** Silences `logEvent`; the returned reader lists the calls naming one of `eventNames`, in order. */
export function recordLoggedEvents(
  eventNames: readonly string[]
): () => Parameters<typeof events.logEvent>[] {
  const logEvent = vi.spyOn(events, "logEvent").mockImplementation(() => {});
  return () => logEvent.mock.calls.filter(([, payload]) => eventNames.includes(payload.event));
}
