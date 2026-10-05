"use client";

import { createContext, type RefObject } from "react";

/** What a run finds in the key field: nothing pending, the pasted key identified, or refused. */
export type PendingApiKeyOutcome =
  | { kind: "none" }
  | { kind: "identified"; apiKeyId: string }
  | { kind: "rejected" };

/**
 * Identifies the key material still pending in the key field. Editing the field detaches the
 * previous key at once, while the new material is identified only on blur or when the popover
 * closes, so a run straight after a paste (⌘↵ with the popover open) calls this first.
 */
export type IdentifyPendingApiKey = () => Promise<PendingApiKeyOutcome>;

/**
 * The playground's slot for the key field's {@link IdentifyPendingApiKey}: the shell provides
 * it, the key field fills it.
 */
export const PendingApiKeyContext = createContext<RefObject<IdentifyPendingApiKey | null> | null>(
  null
);
