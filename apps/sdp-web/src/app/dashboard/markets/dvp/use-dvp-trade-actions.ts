"use client";

/**
 * Settling, cancelling and funding a trade.
 *
 * Pulled out of the detail page so the page reads as layout. All three go
 * through one request shape, and all three share the same three outcomes that
 * are easy to conflate: done, held for approval, and failed.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

export type DvpTradeActionName = "settle" | "cancel" | "fund";

export interface DvpTradeActions {
  act: (action: DvpTradeActionName) => Promise<void>;
  awaitingApproval: boolean;
  error: string | null;
  pending: DvpTradeActionName | null;
}

export function useDvpTradeActions(tradeId: string): DvpTradeActions {
  const router = useRouter();
  const [pending, setPending] = useState<DvpTradeActionName | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: DvpTradeActionName) {
    setPending(action);
    setError(null);
    setAwaitingApproval(false);
    try {
      const response = await fetch(
        `/api/dashboard/markets/dvp/trades/${encodeURIComponent(tradeId)}/${action}`,
        { method: "POST" }
      );
      // 202 is a normal outcome, not a failure: wallet policy is holding the
      // action for approval. Treating it as an error would tell an operator
      // something broke when the platform did exactly what they configured.
      if (response.status === 202) {
        setAwaitingApproval(true);
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(body.error?.message ?? `Request failed (${response.status}).`);
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setPending(null);
    }
  }

  return { act, awaitingApproval, error, pending };
}
