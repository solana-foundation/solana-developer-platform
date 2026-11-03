"use client";

import { Callout } from "@sdp/ui/callout";

/**
 * The one destructive note every vault modal raises under its form: an alert callout, so a
 * failed submit or cancelled request is announced rather than only painted.
 */
export function EarnErrorNote({ message }: { message: string }) {
  return (
    <Callout className="mt-3" live variant="danger">
      {message}
    </Callout>
  );
}
