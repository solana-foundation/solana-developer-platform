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

interface AuthorityWalletsEnvelope {
  data?: {
    authorityWallets?: PaymentsDashboardWallet[];
    authorityWalletsError?: string | null;
  };
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

export interface TokenAuthorityWalletsData {
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsError: string | null;
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

export async function fetchTokenAuthorityWallets(
  tokenId: string,
  options: {
    signal?: AbortSignal;
  } = {}
): Promise<TokenAuthorityWalletsData> {
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/authority-wallets`,
    {
      method: "GET",
      cache: "no-store",
      signal: options.signal,
    }
  );
  const body = (await response.json().catch(() => ({}))) as AuthorityWalletsEnvelope;

  if (!response.ok) {
    throw new Error(
      getApiError(
        body as SupportingDataEnvelope,
        `Authority wallet request failed (${response.status}).`
      )
    );
  }

  return {
    authorityWallets: Array.isArray(body.data?.authorityWallets) ? body.data.authorityWallets : [],
    authorityWalletsError:
      typeof body.data?.authorityWalletsError === "string" ? body.data.authorityWalletsError : null,
  };
}
