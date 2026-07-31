"use client";

import { type IssuanceListQuery, toIssuanceListRequestParams } from "./issuance-list-query";
import type { IssuanceTokenListItem } from "./issuance-tokens.data";

export interface IssuanceTokensClientPage {
  tokens: IssuanceTokenListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface IssuanceTokensEnvelope {
  data?: IssuanceTokenListItem[];
  total?: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  error?: string | null;
}

/**
 * Fetches one page of the asset list from the dashboard BFF route.
 *
 * Throws on failure so SWR surfaces it as an error state instead of silently
 * rendering an empty list — an empty page and a failed request are not the same
 * thing to the reader.
 */
export async function fetchIssuanceTokensClientPage(
  query: IssuanceListQuery,
  options: { signal?: AbortSignal } = {}
): Promise<IssuanceTokensClientPage> {
  const params = toIssuanceListRequestParams(query);
  // The URL omits defaults for cleanliness, but the request must always be
  // explicit about which page of which size it wants.
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));

  const response = await fetch(`/api/dashboard/issuance/tokens?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
    signal: options.signal,
  });
  const body = (await response.json().catch(() => ({}))) as IssuanceTokensEnvelope;

  if (!response.ok || body.error) {
    throw new Error(body.error || `Asset list request failed (${response.status})`);
  }

  return {
    tokens: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : 0,
    page: typeof body.page === "number" ? body.page : query.page,
    pageSize: typeof body.pageSize === "number" ? body.pageSize : query.pageSize,
    hasMore: body.hasMore === true,
  };
}
