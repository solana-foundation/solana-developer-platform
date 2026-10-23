"use client";

import type { TokenAmountQuote } from "@sdp/types/token-movements";
import { useState } from "react";
import type { CreateTransferInput } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import { isTransferKeyKept } from "@/app/dashboard/[projectId]/payments/transfer-idempotency";

/** An attempt whose answer left its key kept: what it sent, and the quote that priced it. */
export interface UnresolvedTransfer {
  submission: CreateTransferInput;
  /** The quote its token amount came from; null for an amount typed in token units. */
  quote: TokenAmountQuote | null;
}

/**
 * The transfers whose last attempt is unresolved, by what the user typed for
 * them. A display amount is priced again each time its quote expires, so the
 * token amount it converts to can move while the user waits (ADR 0012). After
 * an attempt whose answer was lost the API may have sent the payment, and the
 * transfer's key is kept for it; a retry re-priced from a later quote would be
 * another request under another key, and could pay twice. So while that key
 * is kept, the same typed entry is sent again exactly as that attempt was.
 */
export function useUnresolvedTransfers() {
  const [attempts, setAttempts] = useState<ReadonlyMap<string, UnresolvedTransfer>>(
    () => new Map()
  );
  return {
    /** What `entry` was last sent as, while that attempt is unresolved; null otherwise. */
    unresolvedFor(entry: string): UnresolvedTransfer | null {
      const attempt = attempts.get(entry);
      return attempt === undefined ? null : attempt;
    },
    /**
     * Records an answered attempt: kept while its key is, dropped once the
     * answer retired the key (a success, or a refusal that sent nothing).
     */
    settle(entry: string, attempt: UnresolvedTransfer): void {
      const kept = isTransferKeyKept(attempt.submission);
      setAttempts((previous) => {
        const next = new Map(previous);
        if (kept) next.set(entry, attempt);
        else next.delete(entry);
        return next;
      });
    },
  };
}
