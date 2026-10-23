"use client";

import type { TokenAmountQuote } from "@sdp/types/token-movements";
import { useState } from "react";
import type { CreateTransferInput } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import { isTransferKeyKept } from "@/app/dashboard/[projectId]/payments/transfer-idempotency";
import type { TokenAmountEntry } from "@/app/dashboard/[projectId]/payments/use-token-amount-entry";

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

/** What a send wizard has typed, as `pinnedSendEntry` reads it. */
interface TypedSend {
  walletId: string;
  destinationAddress: string | null;
  mint: string | null;
  amount: string;
  displayAmount: string;
  memo: string;
}

/**
 * The amount entry a send wizard shows and sends: the live entry, or, while
 * the typed payment's last attempt is unresolved, that attempt's token amount
 * and quote, never one a later quote priced.
 *
 * @returns The typed entry's identity, its unresolved attempt (null when
 *   none), and the entry to show and send.
 */
export function pinnedSendEntry(
  typed: TypedSend,
  amountEntry: TokenAmountEntry,
  unresolvedFor: (entry: string) => UnresolvedTransfer | null
): { typedEntry: string; unresolved: UnresolvedTransfer | null; shownEntry: TokenAmountEntry } {
  const typedEntry = JSON.stringify([
    typed.walletId,
    typed.destinationAddress,
    typed.mint,
    amountEntry.unit,
    amountEntry.unit === "display" ? typed.displayAmount.trim() : typed.amount.trim(),
    typed.memo.trim(),
  ]);
  const unresolved = unresolvedFor(typedEntry);
  if (unresolved === null) {
    return { typedEntry, unresolved, shownEntry: amountEntry };
  }
  return {
    typedEntry,
    unresolved,
    shownEntry: {
      ...amountEntry,
      tokenAmount: unresolved.submission.amount,
      quote: unresolved.quote,
      quoteError: null,
    },
  };
}
