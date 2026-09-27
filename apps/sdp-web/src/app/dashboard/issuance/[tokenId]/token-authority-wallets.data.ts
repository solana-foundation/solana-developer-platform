"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { z } from "zod";
import { paymentsWalletsResponseSchema } from "@/app/dashboard/payments/payments-page.data";
import { PROJECT_CONTEXT_HEADER_NAME } from "@/lib/project-cookie";

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

async function fetchParsed<Output>(
  path: string,
  schema: z.ZodType<Output>,
  projectContextId?: string | null
): Promise<Output> {
  const response = await fetch(path, {
    cache: "no-store",
    headers: projectContextId
      ? // Bind the read to the project the mounted surface was rendered with
        // (SOLA9-564) instead of the shared selection cookie a sibling tab can
        // flip.
        { [PROJECT_CONTEXT_HEADER_NAME]: projectContextId }
      : undefined,
  });
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
 * @param options.projectContextId - Rendered project context, bound into both
 * reads so authorities and signer wallets answer the same project.
 * @returns Live authorities plus the signer wallet inventory.
 */
export async function fetchTokenAuthorityWallets(
  tokenId: string,
  options: { projectContextId?: string | null } = {}
): Promise<TokenAuthorityWalletsData> {
  const [authorities, wallets] = await Promise.all([
    fetchParsed(
      `/api/dashboard/issuance/tokens/${encodeURIComponent(tokenId)}?${TOKEN_AUTHORITIES_QUERY}`,
      tokenAuthoritiesResponseSchema,
      options.projectContextId
    ),
    // Same project context on both legs: the authorities and the signer wallet
    // inventory must come from one project, or a sibling tab flipping the
    // shared cookie makes valid signers look unavailable (SOLA9-564).
    fetchParsed(AUTHORITY_WALLETS_PATH, paymentsWalletsResponseSchema, options.projectContextId),
  ]);
  return { ...authorities.data, authorityWallets: wallets.data.wallets };
}
