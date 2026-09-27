"use client";

import type { TokenTransaction } from "@sdp/types";
import { PROJECT_CONTEXT_HEADER_NAME } from "@/lib/project-cookie";

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
    projectContextId?: string | null;
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
    {
      method: "GET",
      cache: "no-store",
      signal: options.signal,
      // Bind the read to the project the mounted surface was rendered with
      // (SOLA9-564) instead of the shared selection cookie a sibling tab can
      // flip.
      headers: options.projectContextId
        ? { [PROJECT_CONTEXT_HEADER_NAME]: options.projectContextId }
        : undefined,
    }
  );
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as TokenTransactionsPageEnvelope;
    throw new Error(errorBody.error || `Transactions request failed (${response.status})`);
  }
  const body = (await response.json().catch(() => ({}))) as TokenTransactionsPageEnvelope;
  if (body.error) {
    throw new Error(body.error);
  }
  return {
    transactions: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : 0,
    hasMore: body.hasMore === true,
  };
}
