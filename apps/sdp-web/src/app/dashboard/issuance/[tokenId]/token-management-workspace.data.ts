"use client";

import type {
  FrozenAccount,
  PaymentsDashboardWallet,
  TokenAllowlistEntry,
  TokenTransaction,
} from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

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
  t: Translate,
  options: {
    signal?: AbortSignal;
    // The asset-profile workspace owns the control list and transactions through
    // its own endpoints, so it opts out of those fetches here to avoid redundant
    // work. The legacy workspace keeps them (its static lists need them).
    includeAllowlist?: boolean;
    includeTransactions?: boolean;
  } = {}
): Promise<TokenManagementSupportingData> {
  const query = new URLSearchParams();
  if (options.includeAllowlist === false) {
    query.set("includeAllowlist", "false");
  }
  if (options.includeTransactions === false) {
    query.set("includeTransactions", "false");
  }
  const suffix = query.toString();
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/supporting-data${suffix ? `?${suffix}` : ""}`,
    {
      method: "GET",
      cache: "no-store",
      signal: options.signal,
    }
  );
  const body = (await response.json().catch(() => ({}))) as SupportingDataEnvelope;

  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardIssuance.management.supportingDataRequestFailed", { status: response.status })
      )
    );
  }

  if (!body.data) {
    throw new Error(t("DashboardIssuance.management.supportingDataEmpty"));
  }

  return body.data;
}

export async function fetchTokenAuthorityWallets(
  tokenId: string,
  t: Translate,
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
        t("DashboardIssuance.management.authorityWalletRequestFailed", {
          status: response.status,
        })
      )
    );
  }

  return {
    authorityWallets: Array.isArray(body.data?.authorityWallets) ? body.data.authorityWallets : [],
    authorityWalletsError:
      typeof body.data?.authorityWalletsError === "string" ? body.data.authorityWalletsError : null,
  };
}
