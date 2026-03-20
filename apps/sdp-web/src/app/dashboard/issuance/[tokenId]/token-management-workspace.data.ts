"use client";

import type {
  FrozenAccount,
  PaymentsDashboardWallet,
  TokenAllowlistEntry,
  TokenTransaction,
} from "@sdp/types";

interface SupportingDataEnvelope {
  data?: TokenManagementSupportingData;
  error?: {
    message?: string;
  };
}

export interface TokenManagementSupportingData {
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsError: string | null;
  transactions: TokenTransaction[];
  transactionsError: string | null;
  transactionsTotal: number | null;
  transactionsHasMore: boolean;
  allowlistEntries: TokenAllowlistEntry[];
  allowlistError: string | null;
  allowlistTotal: number | null;
  allowlistHasMore: boolean;
  frozenAccounts: FrozenAccount[];
  frozenAccountsError: string | null;
  frozenAccountsTotal: number | null;
  frozenAccountsHasMore: boolean;
}

function getApiError(body: SupportingDataEnvelope, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }

  return fallback;
}

export async function fetchTokenManagementSupportingData(
  tokenId: string,
  options: {
    signal?: AbortSignal;
  } = {}
): Promise<TokenManagementSupportingData> {
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/supporting-data`,
    {
      method: "GET",
      cache: "no-store",
      signal: options.signal,
    }
  );
  const body = (await response.json().catch(() => ({}))) as SupportingDataEnvelope;

  if (!response.ok) {
    throw new Error(
      getApiError(body, `Token supporting data request failed (${response.status}).`)
    );
  }

  if (!body.data) {
    throw new Error("Token supporting data response was empty.");
  }

  return body.data;
}
