"use client";

import type { TokenAllowlistEntry } from "@sdp/types";
import { PROJECT_CONTEXT_HEADER_NAME } from "@/lib/project-cookie";

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
    projectContextId?: string | null;
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
    const errorBody = (await response.json().catch(() => ({}))) as TokenAllowlistPageEnvelope;
    throw new Error(errorBody.error || `Allowlist request failed (${response.status})`);
  }
  const body = (await response.json().catch(() => ({}))) as TokenAllowlistPageEnvelope;
  if (body.error) {
    throw new Error(body.error);
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
  options: { signal?: AbortSignal; projectContextId?: string | null } = {}
): Promise<TokenAllowlistLabels> {
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/allowlist/labels`,
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
    const errorBody = (await response.json().catch(() => ({}))) as TokenAllowlistLabelsEnvelope;
    throw new Error(errorBody.error || `Allowlist labels request failed (${response.status})`);
  }
  const body = (await response.json().catch(() => ({}))) as TokenAllowlistLabelsEnvelope;
  if (body.error) {
    throw new Error(body.error);
  }

  return {
    labels: Array.isArray(body.labels) ? body.labels : [],
    total: typeof body.total === "number" ? body.total : 0,
  };
}
