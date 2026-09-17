"use client";

interface FrozenAccountsSummaryEnvelope {
  error?: string | null;
  total?: number;
}

export async function fetchFrozenAccountsTotal(tokenId: string): Promise<number> {
  const response = await fetch(
    `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}/frozen`,
    { method: "GET", cache: "no-store" }
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
