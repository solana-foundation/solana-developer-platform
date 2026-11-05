"use client";

import type { CustodyWalletSummary } from "@sdp/types/custody";
import type {
  PrivateChannelDto,
  PrivateChannelInstance,
  PrivateChannelPrincipalDto,
  PrivateChannelTokenEligibility,
  PrivateChannelVerifiedWalletDto,
} from "@sdp/types/private-channels";
import { z } from "zod";
import { useWalletSummaries } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import {
  readDashboardRequest,
  useDashboardKeyScope,
  useDashboardRead,
  useDashboardSWR,
} from "@/lib/dashboard-swr";
import type { WalletChannelBalance } from "./private-channels-page.data";
import {
  PRIVATE_CHANNELS_EVENTS_PAGE_SIZE,
  privateChannelsQueryKeys,
} from "./private-channels-query-key";

/** The custody wallet fields the Private Channels pickers and tables read. */
export type PrivateChannelsCustodyWallet = Pick<
  CustodyWalletSummary,
  "walletId" | "publicKey" | "label" | "provider"
>;

const privateChannelInstanceSchema = z.object({
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
}) satisfies z.ZodType<PrivateChannelInstance>;

const privateChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<PrivateChannelDto>;

const privateChannelTokenSchema = z.object({
  symbol: z.string(),
  mint: z.string(),
  decimals: z.number().int().nonnegative(),
  tokenProgram: z.string(),
  enabled: z.boolean(),
  exclusionReasons: z.array(
    z.object({
      code: z.enum(["NOT_ALLOWED_BY_INSTANCE", "ALLOWLIST_UNAVAILABLE"]),
      message: z.string(),
    })
  ),
}) satisfies z.ZodType<PrivateChannelTokenEligibility>;

const privateChannelPrincipalSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  status: z.enum(["active", "disabled"]),
  verifiedWalletCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  channels: z.array(z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() })),
}) satisfies z.ZodType<PrivateChannelPrincipalDto>;

const privateChannelVerifiedWalletSchema = z.object({
  id: z.string(),
  walletId: z.string(),
  pubkey: z.string(),
  verifiedAt: z.string(),
}) satisfies z.ZodType<PrivateChannelVerifiedWalletDto>;

/**
 * A feed row. `family`, `type` and `status` stay open strings: a value the API adds before this
 * dashboard knows it renders as its raw label instead of failing the feed.
 */
const privateChannelEventSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  projectId: z.string(),
  instanceId: z.string(),
  channelId: z.string().nullable(),
  sdpUserId: z.string().nullable(),
  family: z.string(),
  type: z.string(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
  createdAt: z.string(),
});

export type PrivateChannelFeedEvent = z.infer<typeof privateChannelEventSchema>;

const instanceResponseSchema = z.object({
  data: z.object({ instance: privateChannelInstanceSchema.nullable() }),
});
const channelsResponseSchema = z.object({
  data: z.object({ channels: z.array(privateChannelSchema) }),
});
const tokensResponseSchema = z.object({
  data: z.object({ tokens: z.array(privateChannelTokenSchema) }),
});
const principalsResponseSchema = z.object({
  data: z.object({ principals: z.array(privateChannelPrincipalSchema) }),
});
const verifiedWalletsResponseSchema = z.object({
  data: z.object({ wallets: z.array(privateChannelVerifiedWalletSchema) }),
});
const balanceResponseSchema = z.object({
  data: z.object({
    mint: z.string(),
    amount: z.string(),
    decimals: z.number().int().nonnegative(),
    uiAmount: z.string(),
  }),
});
const eventsResponseSchema = z.object({
  data: z.object({
    events: z.array(privateChannelEventSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});
const eventReferencesResponseSchema = z.object({
  data: z.object({ references: z.record(z.string(), z.string()) }),
});

/** The Project's connected instance: `undefined` while it loads, `null` when there is none. */
export function usePrivateChannelInstance() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    privateChannelsQueryKeys.instance(scope),
    instanceResponseSchema
  );
  return { ...response, data: response.data?.data.instance };
}

/** Pass `enabled: false` until an active instance is known: the channel reads need one. */
export function usePrivateChannels(enabled: boolean) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? privateChannelsQueryKeys.channels(scope) : null,
    channelsResponseSchema
  );
  return { ...response, data: response.data?.data.channels };
}

export function usePrivateChannelTokens(enabled: boolean) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? privateChannelsQueryKeys.tokens(scope) : null,
    tokensResponseSchema
  );
  return { ...response, data: response.data?.data.tokens };
}

export function usePrivateChannelPrincipals(enabled: boolean) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? privateChannelsQueryKeys.principals(scope) : null,
    principalsResponseSchema
  );
  return { ...response, data: response.data?.data.principals };
}

export function usePrivateChannelVerifiedWallets() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    privateChannelsQueryKeys.verifiedWallets(scope),
    verifiedWalletsResponseSchema
  );
  return { ...response, data: response.data?.data.wallets };
}

/** The Project's custody wallets, the source every verification and movement picks from. */
export function usePrivateChannelsCustodyWallets() {
  const response = useWalletSummaries({ includeBalances: false });
  const wallets: PrivateChannelsCustodyWallet[] | undefined = response.data;
  return { ...response, data: wallets };
}

/**
 * Each owner's channel balance, keyed by pubkey. A failed read drops that owner from the map:
 * its row renders without a balance rather than failing the whole table.
 */
async function readChannelBalances(
  key: DashboardRequestKey
): Promise<Record<string, WalletChannelBalance>> {
  const scope = { projectId: key[0], mode: key[1] };
  const owners = String(key[3]?.owners ?? "")
    .split(",")
    .filter((owner) => owner !== "");
  const entries = await Promise.all(
    owners.map((owner) =>
      readDashboardRequest(
        privateChannelsQueryKeys.balance(scope, owner),
        balanceResponseSchema
      ).then(
        (body): [string, WalletChannelBalance] => [owner, body.data],
        () => null
      )
    )
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

/** Pass `null` while the verified wallets load; an empty list reads nothing. */
export function usePrivateChannelBalances(owners: readonly string[] | null) {
  const scope = useDashboardKeyScope();
  return useDashboardSWR(
    owners !== null && owners.length > 0 ? privateChannelsQueryKeys.balances(scope, owners) : null,
    readChannelBalances
  );
}

/**
 * The feed's newest page. It only seeds the feed: older pages and filtered pages load on demand
 * inside it, so no focus refetch replaces what the user has paged, filtered or opened.
 */
export function usePrivateChannelEvents() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    privateChannelsQueryKeys.events(scope, { limit: PRIVATE_CHANNELS_EVENTS_PAGE_SIZE }),
    eventsResponseSchema,
    { revalidateOnFocus: false }
  );
  return { ...response, data: response.data?.data };
}

/** Id → name labels for the feed; rows fall back to shortened ids while it loads or if it fails. */
export function usePrivateChannelEventReferences() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    privateChannelsQueryKeys.eventReferences(scope),
    eventReferencesResponseSchema
  );
  return { ...response, data: response.data?.data.references };
}
