"use client";

import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { cancelRampTransfer } from "../../payments-workspace.data";

/**
 * Cancels the on-ramp transfer currently holding the funding wallet lock,
 * then asks the caller to re-poll requirements so the released wallet steps
 * the onboarding gate forward.
 *
 * @param input - The reserved transfer id, or null when no transfer is reserved, and the post-cancel callback.
 * @returns The cancel action with its pending and error state.
 */
export function useCancelReservedTransfer(input: {
  transferId: string | null;
  onCancelled: () => void;
}): { pending: boolean; error: string | null; cancel: () => void } {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = () => {
    const transferId = input.transferId;
    if (transferId === null || pending) {
      return;
    }
    void (async () => {
      setPending(true);
      setError(null);
      try {
        await cancelRampTransfer({ transferId }, t);
        setPending(false);
        input.onCancelled();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setPending(false);
      }
    })();
  };

  return { pending, error, cancel };
}
