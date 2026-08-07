import type {
  CustodyWalletSummary,
  ListProjectMembersResponse,
  PrivateChannelDto,
  PrivateChannelEventListEnvelope,
  PrivateChannelInstance,
  PrivateChannelInstanceOverview,
  PrivateChannelUserDto,
  PrivateChannelVerifiedWalletDto,
} from "@sdp/types";
import {
  fetchCustodyWallets,
  fetchPrivateChannelBalance,
  fetchPrivateChannelEventReferences,
  fetchPrivateChannelEvents,
  fetchPrivateChannelInstance,
  fetchPrivateChannelOverview,
  fetchPrivateChannels,
  fetchPrivateChannelUsers,
  fetchVerifiedSignableWallets,
  fetchVerifiedWallets,
} from "@/lib/private-channels";
import { extractSdpApiErrorMessage, type SdpApiClient, SdpApiResponseError } from "@/lib/sdp-api";

/**
 * Result envelope for Private Channels page loads.
 *
 * The transport helpers in `@/lib/private-channels` throw on any non-2xx, so
 * before this every page collapsed failures into an empty array — a 500 and
 * "you have no channels yet" rendered identically. `ok` lets a page tell the
 * user its data failed to load instead of silently claiming there is none.
 * `data` always carries a usable fallback so callers never branch before render.
 */
export type PrivateChannelsResult<T> = {
  ok: boolean;
  data: T;
  error?: string;
  /** HTTP status when the failure came from the API rather than the network. */
  status?: number;
};

async function toResult<T>(load: () => Promise<T>, fallback: T): Promise<PrivateChannelsResult<T>> {
  try {
    return { ok: true, data: await load() };
  } catch (error) {
    return {
      ok: false,
      data: fallback,
      error: extractSdpApiErrorMessage(error),
      ...(error instanceof SdpApiResponseError ? { status: error.status } : {}),
    };
  }
}

/** The project's connected instance, or `null` when none is persisted. */
export function loadInstance(
  client: SdpApiClient
): Promise<PrivateChannelsResult<PrivateChannelInstance | null>> {
  return toResult(async () => (await fetchPrivateChannelInstance(client)).instance ?? null, null);
}

/**
 * The active instance plus its live overview. Resolves `{ok: true, data: null}`
 * for the expected "no active instance" 404, which callers redirect on — that is
 * a routing signal, not a load failure, so it must not read as an error state.
 */
export async function loadOverview(client: SdpApiClient): Promise<
  PrivateChannelsResult<{
    instance: PrivateChannelInstance;
    overview: PrivateChannelInstanceOverview;
  } | null>
> {
  const result = await toResult(() => fetchPrivateChannelOverview(client), null);
  if (!result.ok && result.status === 404) {
    return { ok: true, data: null };
  }
  return result;
}

export function loadChannels(
  client: SdpApiClient
): Promise<PrivateChannelsResult<PrivateChannelDto[]>> {
  return toResult(() => fetchPrivateChannels(client), []);
}

/**
 * Custody wallets SDP can sign from AND that are SPC-verified — the
 * deposit/withdraw picker source. Verification is required either way: an
 * unverified wallet can't burn or receive channel credit, so offering it in the
 * picker would only produce a rejected intent.
 */
export function loadSignableWallets(
  client: SdpApiClient
): Promise<PrivateChannelsResult<CustodyWalletSummary[]>> {
  return toResult(() => fetchVerifiedSignableWallets(client), []);
}

export function loadEvents(
  client: SdpApiClient,
  limit = 50
): Promise<PrivateChannelsResult<PrivateChannelEventListEnvelope>> {
  return toResult(() => fetchPrivateChannelEvents(client, { limit }), {
    events: [],
    hasMore: false,
    nextCursor: null,
  });
}

/**
 * Flat id→name dictionary for event enrichment. Falls back to `{}` so a failed
 * lookup degrades to shortened addresses rather than breaking the page.
 */
export function loadEventReferences(
  client: SdpApiClient
): Promise<PrivateChannelsResult<Record<string, string>>> {
  return toResult(() => fetchPrivateChannelEventReferences(client), {});
}

/** Verified wallets joined with the custody wallets they can be verified from. */
export function loadWalletVerification(client: SdpApiClient): Promise<
  PrivateChannelsResult<{
    verified: PrivateChannelVerifiedWalletDto[];
    custody: CustodyWalletSummary[];
  }>
> {
  return toResult(
    async () => {
      const [verified, custody] = await Promise.all([
        fetchVerifiedWallets(client),
        fetchCustodyWallets(client),
      ]);
      return { verified, custody };
    },
    { verified: [], custody: [] }
  );
}

/** A verified wallet's channel-side balance for a single mint. */
export interface WalletChannelBalance {
  uiAmount: string;
  mint: string;
}

/**
 * Each verified wallet's channel balance, keyed by pubkey, read in parallel.
 *
 * Unlike the loaders above this returns a bare record rather than a
 * `PrivateChannelsResult`: a failed read is per-wallet, not per-page, so it is
 * dropped from the map instead of failing the whole card. A missing key means
 * "balance unavailable" and the row simply renders without one — an `ok` flag
 * here would be permanently true and tell the caller nothing.
 */
export async function loadChannelBalances(
  client: SdpApiClient,
  verified: PrivateChannelVerifiedWalletDto[]
): Promise<Record<string, WalletChannelBalance>> {
  const entries = await Promise.all(
    verified.map(async (wallet): Promise<[string, WalletChannelBalance] | null> => {
      try {
        const balance = await fetchPrivateChannelBalance(client, wallet.pubkey);
        return [wallet.pubkey, { uiAmount: balance.uiAmount, mint: balance.mint }];
      } catch {
        return null;
      }
    })
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

/**
 * Workspace members plus the channels they can be assigned to, and the project
 * users still eligible for invitation. Loaded together because the members table
 * cannot render a useful row without all three.
 */
export function loadMembers(
  client: SdpApiClient,
  projectId: string | undefined
): Promise<
  PrivateChannelsResult<{
    users: PrivateChannelUserDto[];
    channels: PrivateChannelDto[];
    projectMembers: ListProjectMembersResponse["members"];
  }>
> {
  return toResult(
    async () => {
      const [users, channels, projectMembers] = await Promise.all([
        fetchPrivateChannelUsers(client),
        fetchPrivateChannels(client),
        projectId
          ? client
              .fetch<ListProjectMembersResponse>(
                `/v1/projects/${encodeURIComponent(projectId)}/members`
              )
              .then((response) => response.members)
          : Promise.resolve([]),
      ]);
      return { users, channels, projectMembers };
    },
    { users: [], channels: [], projectMembers: [] }
  );
}
