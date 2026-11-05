"use client";

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { z } from "zod";
import { paymentsWalletsResponseSchema } from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";

const tokenAuthoritiesResponseSchema = z.object({
  data: z.object({
    allowlistAuthority: z.string().min(1).nullable(),
    freezeAuthority: z.string().min(1).nullable(),
    metadataAuthority: z.string().min(1).nullable(),
    pauseAuthority: z.string().min(1).nullable(),
  }),
});

export type TokenAuthorityWalletsData = z.infer<typeof tokenAuthoritiesResponseSchema>["data"] & {
  authorityWallets: PaymentsDashboardWallet[];
};

/**
 * The token's live operation authorities (the key's request) and the custody wallets that can
 * sign for them, read together under the one key.
 */
export async function readTokenAuthorityWallets(
  key: DashboardRequestKey
): Promise<TokenAuthorityWalletsData> {
  const scope = { projectId: key[0], mode: key[1] };
  const [authorities, wallets] = await Promise.all([
    readDashboardRequest(key, tokenAuthoritiesResponseSchema),
    readDashboardRequest(
      sharedReadQueryKeys.walletSummaries(scope, { includeBalances: false }),
      paymentsWalletsResponseSchema
    ),
  ]);
  return { ...authorities.data, authorityWallets: wallets.data.wallets };
}
