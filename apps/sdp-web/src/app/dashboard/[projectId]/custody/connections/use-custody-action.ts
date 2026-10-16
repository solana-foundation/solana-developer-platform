"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import type { CustodyActionResult } from "./connection-actions";

interface ActionMessages {
  /** Toast title on a confirmed success. */
  successTitle: string;
  /** Optional detail line under the success title. */
  successDescription?: string;
  /** Toast title on a conclusive refusal. */
  failedTitle: string;
  /** Toast title when the outcome could not be confirmed. */
  unknownTitle: string;
}

/**
 * Runs one lifecycle action, reports it, and refreshes the server-rendered
 * page underneath.
 *
 * Three outcomes, three tones. An unconfirmed result gets `toast.warning` and
 * language about re-reading state — never `toast.error`, which would assert a
 * failure nobody has established. A 403 that only shows up at click time is
 * reported as a permission problem rather than a generic error, because the
 * viewer's next move is to ask for a role, not to try again.
 *
 * `pending` serialises the dialog: the primary is disabled while a request is
 * in flight, so a double-click cannot send a second command. For the actions
 * that carry an idempotency key, the key is minted once per intent by the
 * caller and survives a retry, so even a duplicate would replay rather than
 * duplicate.
 */
export function useCustodyAction() {
  const t = useTranslations();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (
      action: () => Promise<CustodyActionResult>,
      messages: ActionMessages,
      onSettled?: (result: CustodyActionResult) => void
    ): Promise<CustodyActionResult> => {
      setPending(true);
      let result: CustodyActionResult;
      try {
        result = await action();
      } catch {
        // A rejected action call is the same uncertainty as a transport error
        // inside it: the request may have reached the server.
        result = { status: "unknown", message: messages.unknownTitle };
      } finally {
        setPending(false);
      }

      if (result.status === "success") {
        toast.success(messages.successTitle, { description: messages.successDescription });
      } else if (result.status === "unknown") {
        toast.warning(messages.unknownTitle, { description: result.message });
      } else if (result.kind === "conflict") {
        toast.warning(t("DashboardCustody.outcomeConflictTitle"), { description: result.message });
      } else {
        toast.error(messages.failedTitle, { description: result.message });
      }

      // Re-read in every case. A failure may still have moved state (a rotation
      // candidate survives a rejected cut-over), and an unknown outcome is the
      // case where re-reading matters most.
      router.refresh();
      onSettled?.(result);
      return result;
    },
    [router, t]
  );

  return { pending, run };
}
