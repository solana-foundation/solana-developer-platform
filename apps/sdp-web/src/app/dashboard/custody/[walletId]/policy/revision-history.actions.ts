"use server";

import type { WalletControlProfileRevisionHistory } from "@sdp/types";
import { createSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";
import { fetchMemberNames, fetchRevisionHistory } from "./policy-audit.data";

export type RevisionHistoryResult =
  | {
      ok: true;
      history: WalletControlProfileRevisionHistory;
      userNames: Record<string, string>;
    }
  | { ok: false; error: string };

/**
 * Loads a wallet's control-profile revision history for client surfaces such
 * as the revision history modal.
 *
 * @param walletId - The wallet whose revision history to load.
 * @returns The revision history, or a readable error for inline display.
 */
export async function fetchWalletRevisionHistoryAction(
  walletId: string
): Promise<RevisionHistoryResult> {
  try {
    const apiClient = await createSdpApiClient();
    const [history, userNames] = await Promise.all([
      fetchRevisionHistory(apiClient.request, walletId),
      fetchMemberNames(apiClient.request),
    ]);
    return { ok: true, history, userNames };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
