"use client";

import type { AssetAuditEvent } from "@sdp/types";

export interface AssetAuditHistory {
  events: AssetAuditEvent[];
  total: number;
  hasMore: boolean;
}

interface AssetAuditEnvelope {
  data?: AssetAuditEvent[];
  error?: string | null;
  total?: number;
  hasMore?: boolean;
}

export async function fetchAssetAuditHistory(
  tokenId: string,
  options: { action?: string | null; pageSize?: number; signal?: AbortSignal } = {}
): Promise<AssetAuditHistory> {
  const query = new URLSearchParams();
  if (options.action) {
    query.set("action", options.action);
  }
  if (options.pageSize) {
    query.set("pageSize", String(options.pageSize));
  }

  const suffix = query.toString();
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/audit${suffix ? `?${suffix}` : ""}`,
    { method: "GET", cache: "no-store", signal: options.signal }
  );
  const body = (await response.json().catch(() => ({}))) as AssetAuditEnvelope;

  if (!response.ok || body.error) {
    throw new Error(body.error || `Audit request failed (${response.status})`);
  }

  return {
    events: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : 0,
    hasMore: body.hasMore === true,
  };
}
