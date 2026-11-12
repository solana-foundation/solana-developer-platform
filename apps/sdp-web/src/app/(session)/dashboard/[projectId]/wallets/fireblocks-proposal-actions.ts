"use server";

import { fireblocksProposalSummarySchema } from "@sdp/types/fireblocks";
import { z } from "zod";
import { createSdpApiClient } from "@/lib/sdp-api";

export async function listFireblocksProposals(
  walletId: string,
  kind: "signing" | "transfer",
  offset: number
) {
  const client = await createSdpApiClient();
  const query = new URLSearchParams({ walletId, kind, offset: String(offset) });
  return z
    .object({ proposals: z.array(fireblocksProposalSummarySchema), hasMore: z.boolean() })
    .parse(
      await client.fetch<unknown>(`/internal/dashboard/custody/fireblocks/proposals?${query}`)
    );
}

export async function cancelFireblocksProposal(
  kind: "signing" | "transfer",
  proposalId: string,
  idempotencyKey: string
) {
  const client = await createSdpApiClient();
  return z
    .object({ acknowledged: z.boolean(), proposal: fireblocksProposalSummarySchema })
    .parse(
      await client.fetch<unknown>(
        `/internal/dashboard/custody/fireblocks/proposals/${encodeURIComponent(kind)}/${encodeURIComponent(proposalId)}/cancel`,
        { method: "POST", headers: { "Idempotency-Key": idempotencyKey } }
      )
    );
}
