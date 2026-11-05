"use client";

import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types/counterparties";
import { EARN_PROVIDERS } from "@sdp/types/provider-access";
import type { SWRConfiguration } from "swr";
import { z } from "zod";
import { ISSUANCE_MAX_PAGE_SIZE } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-list-query";
import { paymentsWalletsResponseSchema } from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import { type DashboardRequestKey, dashboardRequestKey } from "@/lib/dashboard-request-key";
import {
  type DashboardReadError,
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardRead,
  useDashboardSWR,
} from "@/lib/dashboard-swr";

const walletTokenBalanceSchema = z.object({
  token: z.string(),
  mint: z.string(),
  amount: z.string(),
  uiAmount: z.string(),
  decimals: z.number(),
  usdPrice: z.number().optional(),
  usdValue: z.number().optional(),
});

const walletAggregateResponseSchema = z.object({
  data: z.object({
    aggregate: z.object({
      walletCount: z.number().int().nonnegative(),
      balances: z.array(walletTokenBalanceSchema),
    }),
  }),
});

const counterpartiesResponseSchema = z.object({
  data: z.object({
    counterparties: z.array(
      z.object({
        id: z.string().min(1),
        displayName: z.string(),
        entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
      })
    ),
    total: z.number().int().nonnegative(),
  }),
});

const issuedTokensPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      decimals: z.number().int().nonnegative(),
      mintAddress: z.string().nullable(),
      symbol: z.string(),
      imageUrl: z.string().nullable().optional(),
    })
  ),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

const providerAvailabilityEntrySchema = z.object({
  entitled: z.boolean(),
  configured: z.boolean(),
  enabled: z.boolean(),
});

/** Keys the API adds before this deployment knows them are dropped, never fatal to the read. */
function knownProviderEntries<const Ids extends readonly [string, ...string[]]>(providerIds: Ids) {
  const knownIds = z.enum(providerIds);
  return z.record(z.string(), providerAvailabilityEntrySchema).transform((entries) => {
    const known: Partial<Record<Ids[number], z.infer<typeof providerAvailabilityEntrySchema>>> = {};
    for (const [providerId, entry] of Object.entries(entries)) {
      const parsedId = knownIds.safeParse(providerId);
      if (parsedId.success) {
        known[parsedId.data] = entry;
      }
    }
    return known;
  });
}

const organizationProviderAccessResponseSchema = z.object({
  data: z.object({
    providers: z.object({
      // Narrowed by the release channel where it is used (`filterEnabledRampProviderAccess`).
      ramps: z.record(z.string(), providerAvailabilityEntrySchema),
      earn: knownProviderEntries(EARN_PROVIDERS),
    }),
  }),
});

export interface IssuedTokenSymbol {
  /** Null when the listing omits it. */
  id: string | null;
  name: string;
  decimals: number;
  mintAddress: string;
  symbol: string;
  imageUrl: string | null;
}

export function useWalletSummaries(
  options: { includeBalances: boolean },
  config?: SWRConfiguration<z.infer<typeof paymentsWalletsResponseSchema>, DashboardReadError>
) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    sharedReadQueryKeys.walletSummaries(scope, options),
    paymentsWalletsResponseSchema,
    config
  );
  return { ...response, data: response.data?.data.wallets };
}

export function useWalletAggregate() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    sharedReadQueryKeys.walletAggregate(scope),
    walletAggregateResponseSchema
  );
  return { ...response, data: response.data?.data.aggregate };
}

export function useCounterparties(options: { page: number; pageSize: number }) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    sharedReadQueryKeys.counterparties(scope, options),
    counterpartiesResponseSchema
  );
  return { ...response, data: response.data?.data };
}

/** Every page of the Project's issued tokens, one request per page, under a single cache entry. */
async function readAllIssuedTokens(key: DashboardRequestKey): Promise<IssuedTokenSymbol[]> {
  const tokens: IssuedTokenSymbol[] = [];
  for (let page = 1; ; page += 1) {
    const pageKey = dashboardRequestKey({ projectId: key[0], mode: key[1] }, key[2], {
      ...key[3],
      page,
    });
    const body = await readDashboardRequest(pageKey, issuedTokensPageSchema);
    for (const token of body.data) {
      if (token.mintAddress !== null && token.mintAddress !== "") {
        tokens.push({
          id: token.id === "" ? null : token.id,
          name: token.name,
          decimals: token.decimals,
          mintAddress: token.mintAddress,
          symbol: token.symbol,
          imageUrl: token.imageUrl ?? null,
        });
      }
    }
    if (!body.hasMore || page * ISSUANCE_MAX_PAGE_SIZE >= body.total) {
      return tokens;
    }
  }
}

/**
 * The Project's issued tokens, for labelling balances and payment rows by mint. Pass the Issuance
 * flag as `enabled`: a deployment without Issuance refuses the listing, and nothing is read.
 */
export function useIssuedTokens(enabled: boolean) {
  const scope = useDashboardKeyScope();
  return useDashboardSWR(
    enabled ? sharedReadQueryKeys.issuedTokens(scope, { pageSize: ISSUANCE_MAX_PAGE_SIZE }) : null,
    readAllIssuedTokens
  );
}

/**
 * The organization's ramp and Earn provider access, one read every module shares. A failed read is
 * no access: callers disable the actions it gates.
 */
export function useOrganizationProviderAccess() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    sharedReadQueryKeys.organizationProviderAccess(scope),
    organizationProviderAccessResponseSchema
  );
  return { ...response, data: response.data?.data.providers };
}
