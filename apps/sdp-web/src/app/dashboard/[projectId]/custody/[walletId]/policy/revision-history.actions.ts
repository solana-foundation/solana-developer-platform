"use server";

import type { WalletControlProfileRevisionHistory } from "@sdp/types";
import { createProjectBoundSdpApiClient } from "@/lib/sdp-api";
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
 * @param projectId - Project that owns the wallet.
 * @param walletId - The wallet whose revision history to load.
 * @returns The revision history, or a readable error for inline display.
 */
export async function fetchWalletRevisionHistoryAction(
  projectId: string,
  walletId: string
): Promise<RevisionHistoryResult> {
  try {
    const apiClient = await createProjectBoundSdpApiClient(projectId);
    const [history, userNames] = await Promise.all([
      fetchRevisionHistory(apiClient.request, walletId),
      fetchMemberNames(apiClient.request),
    ]);
    return { ok: true, history, userNames };
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
}
