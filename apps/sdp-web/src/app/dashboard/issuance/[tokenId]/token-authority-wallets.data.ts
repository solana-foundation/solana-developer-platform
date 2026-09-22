"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { z } from "zod";
import { paymentsWalletsResponseSchema } from "@/app/dashboard/payments/payments-page.data";

const tokenAuthoritiesResponseSchema = z.object({
  data: z.object({
    allowlistAuthority: z.string().min(1).nullable(),
    freezeAuthority: z.string().min(1).nullable(),
    metadataAuthority: z.string().min(1).nullable(),
    pauseAuthority: z.string().min(1).nullable(),
  }),
});

const TOKEN_AUTHORITIES_QUERY =
  "includeAllowlistAuthority=true&includeFreezeAuthority=true&includeMetadataAuthority=true&includePauseAuthority=true";

const AUTHORITY_WALLETS_PATH = "/api/dashboard/wallets?view=summary";

export type TokenAuthorityWalletsData = z.infer<typeof tokenAuthoritiesResponseSchema>["data"] & {
  authorityWallets: PaymentsDashboardWallet[];
};

async function fetchParsed<Output>(path: string, schema: z.ZodType<Output>): Promise<Output> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return schema.parse(await response.json());
}

/**
 * Loads the token's live operation authorities and the custody wallets that can sign for them.
 * Both reads go through their canonical dashboard proxies and are fanned out here on the client.
 *
 * @param tokenId - Issuance token id.
 * @returns Live authorities plus the signer wallet inventory.
 */
export async function fetchTokenAuthorityWallets(
  tokenId: string
): Promise<TokenAuthorityWalletsData> {
  const [authorities, wallets] = await Promise.all([
    fetchParsed(
      `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}?${TOKEN_AUTHORITIES_QUERY}`,
      tokenAuthoritiesResponseSchema
    ),
    fetchParsed(AUTHORITY_WALLETS_PATH, paymentsWalletsResponseSchema),
  ]);
  return { ...authorities.data, authorityWallets: wallets.data.wallets };
}
