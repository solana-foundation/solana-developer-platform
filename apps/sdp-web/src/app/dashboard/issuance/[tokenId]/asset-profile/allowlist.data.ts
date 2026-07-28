"use client";

import type { TokenAllowlistEntry } from "@sdp/types";

export interface TokenAllowlistPage {
  entries: TokenAllowlistEntry[];
  total: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
}

interface TokenAllowlistPageEnvelope {
  data?: TokenAllowlistEntry[];
  error?: string | null;
  total?: number;
  hasMore?: boolean;
  page?: number;
  pageSize?: number;
}

export async function fetchTokenAllowlistPage(
  tokenId: string,
  options: {
    page?: number;
    pageSize?: number;
    search?: string | null;
    label?: string | null;
    signal?: AbortSignal;
  } = {}
): Promise<TokenAllowlistPage> {
  const query = new URLSearchParams();
  if (options.page) {
    query.set("page", String(options.page));
  }
  if (options.pageSize) {
    query.set("pageSize", String(options.pageSize));
  }
  if (options.search) {
    query.set("search", options.search);
  }
  if (options.label) {
    query.set("label", options.label);
  }

  const suffix = query.toString();
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/allowlist${suffix ? `?${suffix}` : ""}`,
    { method: "GET", cache: "no-store", signal: options.signal }
  );
  const body = (await response.json().catch(() => ({}))) as TokenAllowlistPageEnvelope;

  if (!response.ok || body.error) {
    throw new Error(body.error || `Allowlist request failed (${response.status})`);
  }

  return {
    entries: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : 0,
    hasMore: body.hasMore === true,
    page: typeof body.page === "number" ? body.page : 1,
    pageSize: typeof body.pageSize === "number" ? body.pageSize : 25,
  };
}

export interface TokenAllowlistLabels {
  labels: string[];
  // Total active control-list entries (unfiltered) — drives the summary count,
  // since the paged list's total reflects the active search/label filter.
  total: number;
}

interface TokenAllowlistLabelsEnvelope {
  labels?: string[];
  total?: number;
  error?: string | null;
}

export async function fetchTokenAllowlistLabels(
  tokenId: string,
  options: { signal?: AbortSignal } = {}
): Promise<TokenAllowlistLabels> {
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/allowlist/labels`,
    { method: "GET", cache: "no-store", signal: options.signal }
  );
  const body = (await response.json().catch(() => ({}))) as TokenAllowlistLabelsEnvelope;

  if (!response.ok || body.error) {
    throw new Error(body.error || `Allowlist labels request failed (${response.status})`);
  }

  return {
    labels: Array.isArray(body.labels) ? body.labels : [],
    total: typeof body.total === "number" ? body.total : 0,
  };
}
