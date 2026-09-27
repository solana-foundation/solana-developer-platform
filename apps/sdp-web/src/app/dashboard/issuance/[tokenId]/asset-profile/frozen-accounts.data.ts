"use client";

import { PROJECT_CONTEXT_HEADER_NAME } from "@/lib/project-cookie";

interface FrozenAccountsSummaryEnvelope {
  error?: string | null;
  total?: number;
}

export async function fetchFrozenAccountsTotal(
  tokenId: string,
  options: { signal?: AbortSignal; projectContextId?: string | null } = {}
): Promise<number> {
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/frozen`,
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
    throw new Error(`Frozen accounts request failed (${response.status})`);
  }
  const body = (await response.json().catch(() => ({}))) as FrozenAccountsSummaryEnvelope;
  if (body.error) {
    throw new Error(body.error);
  }
  return typeof body.total === "number" ? body.total : 0;
}
