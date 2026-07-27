"use client";

import type { TokenTransaction } from "@sdp/types";

export interface TokenTransactionsPage {
  transactions: TokenTransaction[];
  total: number;
  hasMore: boolean;
}

interface TokenTransactionsPageEnvelope {
  data?: TokenTransaction[];
  error?: string | null;
  total?: number;
  hasMore?: boolean;
}

export async function fetchTokenTransactionsPage(
  tokenId: string,
  options: {
    page?: number;
    pageSize?: number;
    type?: string | null;
    status?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<TokenTransactionsPage> {
  const query = new URLSearchParams();
  if (options.page) {
    query.set("page", String(options.page));
  }
  if (options.pageSize) {
    query.set("pageSize", String(options.pageSize));
  }
  if (options.type) {
    query.set("type", options.type);
  }
  if (options.status) {
    query.set("status", options.status);
  }

  const suffix = query.toString();
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/transactions${suffix ? `?${suffix}` : ""}`,
    { method: "GET", cache: "no-store", signal: options.signal }
  );
  const body = (await response.json().catch(() => ({}))) as TokenTransactionsPageEnvelope;

  if (!response.ok || body.error) {
    throw new Error(body.error || `Transactions request failed (${response.status})`);
  }

  return {
    transactions: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : 0,
    hasMore: body.hasMore === true,
  };
}
