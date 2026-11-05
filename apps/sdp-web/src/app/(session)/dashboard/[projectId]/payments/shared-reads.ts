"use client";

import { type Action, isAction } from "@sdp/types/actions";
import { API_KEY_WALLET_SCOPES, SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types/counterparties";
import type { PrivateChannelInstance } from "@sdp/types/private-channels";
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

const privateChannelInstanceResponseSchema = z.object({
  data: z.object({
    instance: z
      .object({
        id: z.string(),
        organizationId: z.string(),
        projectId: z.string(),
        isActive: z.boolean(),
        createdBy: z.string().nullable(),
        createdAt: z.string(),
        updatedAt: z.string(),
        gatewayUrl: z.string(),
        chainRpcUrl: z.string(),
        escrowProgramId: z.string(),
        withdrawProgramId: z.string(),
        escrowInstanceAddr: z.string(),
        authUrl: z.string(),
      })
      .nullable() satisfies z.ZodType<PrivateChannelInstance | null>,
  }),
});

const apiKeyGrantSchema = z.string().refine((value): value is Action => isAction(value));

const apiKeyResponseSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    name: z.string(),
    environment: z.enum(SDP_ENVIRONMENTS),
    grants: z.array(apiKeyGrantSchema),
    expiresAt: z.string().nullable(),
    walletScope: z.enum(API_KEY_WALLET_SCOPES),
    walletIds: z.array(z.string()),
    allowedIps: z.array(z.string()).nullable(),
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

/**
 * The Project's Private Channels instance: `undefined` while it loads, `null` when there is none.
 * Pass the Private Channels flag as `enabled`; nothing is read while it is off.
 */
export function usePrivateChannelInstance(enabled: boolean) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? sharedReadQueryKeys.privateChannelInstance(scope) : null,
    privateChannelInstanceResponseSchema
  );
  return { ...response, data: response.data?.data.instance };
}

/** One API key by id; `null` reads nothing. */
export function useApiKey(keyId: string | null, config?: { keepPreviousData: boolean }) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    keyId === null ? null : sharedReadQueryKeys.apiKey(scope, { keyId }),
    apiKeyResponseSchema,
    config
  );
  return { ...response, data: response.data?.data };
}
