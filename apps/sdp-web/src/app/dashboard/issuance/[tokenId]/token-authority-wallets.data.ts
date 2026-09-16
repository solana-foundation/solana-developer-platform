"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { z } from "zod";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

interface AuthorityWalletsEnvelope {
  data?: {
    authorityWallets?: PaymentsDashboardWallet[];
    authorityWalletsError?: string | null;
  };
  error?: {
    message?: string;
  };
}

export interface TokenAuthorityWalletsData {
  authorityWallets: PaymentsDashboardWallet[];
  authorityWalletsError: string | null;
  // Optional only for pre-existing persisted dashboard cache entries.
  allowlistAuthority?: string | null;
  allowlistAuthorityError?: string | null;
  metadataAuthority?: string | null;
  metadataAuthorityError?: string | null;
}

const liveAuthoritiesSchema = z.object({
  allowlistAuthority: z.string().min(1).nullable(),
  allowlistAuthorityError: z.string().nullable(),
  metadataAuthority: z.string().min(1).nullable(),
  metadataAuthorityError: z.string().nullable(),
});

function getApiError(body: AuthorityWalletsEnvelope, fallback: string): string {
  if (typeof body.error?.message === "string" && body.error.message) {
    return body.error.message;
  }

  return fallback;
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
        body,
        t("DashboardIssuance.management.authorityWalletRequestFailed", {
          status: response.status,
        })
      )
    );
  }

  return {
    ...liveAuthoritiesSchema.parse(body.data),
    authorityWallets: Array.isArray(body.data?.authorityWallets) ? body.data.authorityWallets : [],
    authorityWalletsError:
      typeof body.data?.authorityWalletsError === "string" ? body.data.authorityWalletsError : null,
  };
}
