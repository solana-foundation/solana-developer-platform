"use client";

import type { AssetAuditEvent } from "@sdp/types";
import { PROJECT_CONTEXT_HEADER_NAME } from "@/lib/project-cookie";

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
  options: {
    action?: string | null;
    status?: string | null;
    actorType?: string | null;
    page?: number;
    pageSize?: number;
    signal?: AbortSignal;
    projectContextId?: string | null;
  } = {}
): Promise<AssetAuditHistory> {
  const query = new URLSearchParams();
  if (options.page) {
    query.set("page", String(options.page));
  }
  if (options.action) {
    query.set("action", options.action);
  }
  if (options.status) {
    query.set("status", options.status);
  }
  if (options.actorType) {
    query.set("type", options.actorType);
  }
  if (options.pageSize) {
    query.set("pageSize", String(options.pageSize));
  }

  const suffix = query.toString();
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/audit${suffix ? `?${suffix}` : ""}`,
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
    const errorBody = (await response.json().catch(() => ({}))) as AssetAuditEnvelope;
    throw new Error(errorBody.error || `Audit request failed (${response.status})`);
  }
  const body = (await response.json().catch(() => ({}))) as AssetAuditEnvelope;
  if (body.error) {
    throw new Error(body.error);
  }

  return {
    events: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : 0,
    hasMore: body.hasMore === true,
  };
}
