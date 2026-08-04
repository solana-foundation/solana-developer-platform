import type {
  CreatePrivateChannelRequest,
  CustodyWalletSummary,
  InvitePrivateChannelUserRequest,
  PrivateChannelBalance,
  PrivateChannelDeposit,
  PrivateChannelDto,
  PrivateChannelEventListEnvelope,
  PrivateChannelHealth,
  PrivateChannelInstance,
  PrivateChannelInstanceEnvelope,
  PrivateChannelInstanceOverview,
  PrivateChannelTransfer,
  PrivateChannelTransferRecipientDto,
  PrivateChannelUserDto,
  PrivateChannelVerifiedWalletDto,
  PrivateChannelWithdrawal,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export interface FetchPrivateChannelEventsParams {
  family?: string;
  type?: string;
  limit?: number;
  before?: string;
}

/**
 * Probe a candidate SPC gateway's health via `GET /v1/private-channels/health`.
 * Always resolves with a `PrivateChannelHealth` DTO (ready/degraded/unreachable);
 * only a missing gateway URL surfaces as a rejection.
 */
export function probePrivateChannelHealth(
  client: SdpApiClient,
  gatewayUrl: string
): Promise<PrivateChannelHealth> {
  return client.fetch<PrivateChannelHealth>(
    `/v1/private-channels/health?gatewayUrl=${encodeURIComponent(gatewayUrl)}`
  );
}

/** Fetch this project's connected SPC instance (or `{ instance: null }`). */
export function fetchPrivateChannelInstance(
  client: SdpApiClient
): Promise<PrivateChannelInstanceEnvelope> {
  return client.fetch<PrivateChannelInstanceEnvelope>("/v1/private-channels/instance");
}

/** Fetch the active instance + its post-connect overview. 404 when none active. */
export function fetchPrivateChannelOverview(client: SdpApiClient): Promise<{
  instance: PrivateChannelInstance;
  overview: PrivateChannelInstanceOverview;
}> {
  return client.fetch("/v1/private-channels/instance/overview");
}

/** List channels for the active instance (newest first); ensures the default channel exists. */
export async function fetchPrivateChannels(client: SdpApiClient): Promise<PrivateChannelDto[]> {
  const { channels } = await client.fetch<{ channels: PrivateChannelDto[] }>(
    "/v1/private-channels/channels"
  );
  return channels;
}

/** Create a named channel in the current project. */
export function createPrivateChannel(
  client: SdpApiClient,
  body: CreatePrivateChannelRequest
): Promise<PrivateChannelDto> {
  return client.fetch<PrivateChannelDto>("/v1/private-channels/channels", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Delete (archive) a channel by id. The default channel cannot be deleted. */
export function deletePrivateChannel(client: SdpApiClient, id: string): Promise<unknown> {
  return client.fetch(`/v1/private-channels/channels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * List the project's custody wallets we can SIGN from — the deposit source picker.
 *
 * Deliberately NARROWER than `fetchCustodyWallets` (which adds
 * `includeAllProviders=true` for the wallet-verify picker): a deposit is
 * server-signed via `createOrgSigner`, so this picker must only offer wallets we
 * can actually sign from — surfacing every provider's wallets would let a user
 * pick one that fails at submit time.
 */
export async function fetchSignableCustodyWallets(
  client: SdpApiClient
): Promise<CustodyWalletSummary[]> {
  const { wallets } = await client.fetch<{ wallets: CustodyWalletSummary[] }>("/v1/wallets");
  return wallets;
}

/** List the project's deposits, newest first. */
export async function fetchPrivateChannelDeposits(
  client: SdpApiClient
): Promise<PrivateChannelDeposit[]> {
  const { deposits } = await client.fetch<{ deposits: PrivateChannelDeposit[] }>(
    "/v1/private-channels/deposits"
  );
  return deposits;
}

/** Read one deposit (poll for status transitions). */
export function fetchPrivateChannelDeposit(
  client: SdpApiClient,
  id: string
): Promise<PrivateChannelDeposit> {
  return client.fetch<PrivateChannelDeposit>(
    `/v1/private-channels/deposits/${encodeURIComponent(id)}`
  );
}

/**
 * Create a deposit from a custody wallet into the channel escrow. `mint` must be
 * one the instance allows; omitting it uses the instance's first allowed token.
 */
export function createPrivateChannelDeposit(
  client: SdpApiClient,
  body: { walletId: string; amount: string; mint?: string; recipient?: string }
): Promise<PrivateChannelDeposit> {
  return client.fetch<PrivateChannelDeposit>("/v1/private-channels/deposits", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** List the project's withdrawals, newest first. */
export async function fetchPrivateChannelWithdrawals(
  client: SdpApiClient
): Promise<PrivateChannelWithdrawal[]> {
  const { withdrawals } = await client.fetch<{ withdrawals: PrivateChannelWithdrawal[] }>(
    "/v1/private-channels/withdrawals"
  );
  return withdrawals;
}

/** Read one withdrawal (poll for status transitions). */
export function fetchPrivateChannelWithdrawal(
  client: SdpApiClient,
  id: string
): Promise<PrivateChannelWithdrawal> {
  return client.fetch<PrivateChannelWithdrawal>(
    `/v1/private-channels/withdrawals/${encodeURIComponent(id)}`
  );
}

/**
 * Create a withdrawal: burn a custody wallet's channel balance for later devnet
 * release. `mint` must be one the instance allows; omitting it uses its first.
 */
export function createPrivateChannelWithdrawal(
  client: SdpApiClient,
  body: { walletId: string; amount: string; mint?: string; destination?: string }
): Promise<PrivateChannelWithdrawal> {
  return client.fetch<PrivateChannelWithdrawal>("/v1/private-channels/withdrawals", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** The authenticated user's Private Channels member record and eligible memberships. */
export async function fetchAuthenticatedPrivateChannelUser(
  client: SdpApiClient
): Promise<PrivateChannelUserDto | null> {
  const { user } = await client.fetch<{ user: PrivateChannelUserDto | null }>(
    "/v1/private-channels/users/me"
  );
  return user;
}

/** List grouped verified member wallets eligible to receive in one logical channel. */
export async function fetchPrivateChannelTransferRecipients(
  client: SdpApiClient,
  channelId: string
): Promise<PrivateChannelTransferRecipientDto[]> {
  const { recipients } = await client.fetch<{
    recipients: PrivateChannelTransferRecipientDto[];
  }>(`/v1/private-channels/channels/${encodeURIComponent(channelId)}/transfer-recipients`);
  return recipients;
}

/** Create a custody-signed verified-wallet transfer in one logical channel. */
export function createPrivateChannelTransfer(
  client: SdpApiClient,
  channelId: string,
  body: {
    walletId: string;
    recipientVerifiedWalletId: string;
    amount: string;
    /** Must be one the instance allows; omitting it uses its first allowed token. */
    mint?: string;
  }
): Promise<PrivateChannelTransfer> {
  return client.fetch<PrivateChannelTransfer>(
    `/v1/private-channels/channels/${encodeURIComponent(channelId)}/transfers`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  );
}

/** Project-scoped activity feed (survives instance deletion). */
export function fetchPrivateChannelEvents(
  client: SdpApiClient,
  params: FetchPrivateChannelEventsParams = {}
): Promise<PrivateChannelEventListEnvelope> {
  const query = new URLSearchParams();
  if (params.family) query.set("family", params.family);
  if (params.type) query.set("type", params.type);
  if (params.limit != null) query.set("limit", String(params.limit));
  if (params.before) query.set("before", params.before);
  const qs = query.toString();
  return client.fetch(`/v1/private-channels/events${qs ? `?${qs}` : ""}`);
}

/** List workspace users (invited SDP users), each joined with channel memberships. */
export async function fetchPrivateChannelUsers(
  client: SdpApiClient
): Promise<PrivateChannelUserDto[]> {
  const { users } = await client.fetch<{ users: PrivateChannelUserDto[] }>(
    "/v1/private-channels/users"
  );
  return users;
}

/**
 * Invite an SDP project user to the SPC workspace. Returns the created user
 * DTO plus the invite URL (email is scaffolded — the admin can copy it).
 */
export function invitePrivateChannelUser(
  client: SdpApiClient,
  body: InvitePrivateChannelUserRequest
): Promise<{ user: PrivateChannelUserDto; inviteUrl: string }> {
  return client.fetch<{ user: PrivateChannelUserDto; inviteUrl: string }>(
    "/v1/private-channels/users",
    { method: "POST", body: JSON.stringify(body) }
  );
}

/** Hard-delete a workspace user (revoke). Cascades to channel memberships. */
export function deletePrivateChannelUser(
  client: SdpApiClient,
  privateChannelUserId: string
): Promise<unknown> {
  return client.fetch(`/v1/private-channels/users/${encodeURIComponent(privateChannelUserId)}`, {
    method: "DELETE",
  });
}

/** Add a workspace user to a channel (idempotent). */
export function addChannelMembership(
  client: SdpApiClient,
  channelId: string,
  privateChannelUserId: string
): Promise<unknown> {
  return client.fetch(
    `/v1/private-channels/channels/${encodeURIComponent(channelId)}/memberships`,
    { method: "POST", body: JSON.stringify({ privateChannelUserId }) }
  );
}

/** Remove a workspace user from a channel. */
export function removeChannelMembership(
  client: SdpApiClient,
  channelId: string,
  privateChannelUserId: string
): Promise<unknown> {
  return client.fetch(
    `/v1/private-channels/channels/${encodeURIComponent(channelId)}/memberships/${encodeURIComponent(privateChannelUserId)}`,
    { method: "DELETE" }
  );
}

/**
 * Read an owner's channel token balance for the project's active instance.
 * `mint` defaults to the instance cluster's USDC on the server.
 */
export async function fetchPrivateChannelBalance(
  client: SdpApiClient,
  owner: string,
  mint?: string
): Promise<PrivateChannelBalance> {
  const params = new URLSearchParams({ owner });
  if (mint) params.set("mint", mint);
  return client.fetch<PrivateChannelBalance>(`/v1/private-channels/balance?${params.toString()}`);
}

/**
 * Signable custody wallets with on-chain SPL balances attached. Used by the
 * deposit/withdraw forms to show the wallet's devnet USDC balance without a
 * second round-trip.
 */
export async function fetchSignableWalletsWithBalances(
  client: SdpApiClient
): Promise<CustodyWalletSummary[]> {
  const { wallets } = await client.fetch<{ wallets: CustodyWalletSummary[] }>(
    "/v1/wallets?includeBalances=true"
  );
  return wallets;
}

/**
 * Signable custody wallets that the caller has ALSO verified with SPC. Deposit
 * and withdraw only accept these — an unverified wallet can't burn or receive
 * channel credit.
 */
export async function fetchVerifiedSignableWallets(
  client: SdpApiClient
): Promise<CustodyWalletSummary[]> {
  const [signable, verified] = await Promise.all([
    fetchSignableCustodyWallets(client),
    fetchVerifiedWallets(client),
  ]);
  const verifiedIds = new Set(verified.map((w) => w.walletId));
  return signable.filter((w) => verifiedIds.has(w.walletId));
}

/** The caller's custody wallets that have completed SPC verification, newest first. */
export async function fetchVerifiedWallets(
  client: SdpApiClient
): Promise<PrivateChannelVerifiedWalletDto[]> {
  const { wallets } = await client.fetch<{ wallets: PrivateChannelVerifiedWalletDto[] }>(
    "/v1/private-channels/wallets"
  );
  return wallets;
}

/**
 * Verify a custody wallet with the connected SPC instance (challenge → sign →
 * verify, server-side). Returns the persisted verification.
 */
export async function verifyPrivateChannelWallet(
  client: SdpApiClient,
  walletId: string
): Promise<PrivateChannelVerifiedWalletDto> {
  const { wallet } = await client.fetch<{ wallet: PrivateChannelVerifiedWalletDto }>(
    `/v1/private-channels/wallets/${encodeURIComponent(walletId)}/verify`,
    { method: "POST" }
  );
  return wallet;
}

/** Revoke a wallet verification (SPC + SDP mirror) by pubkey. */
export function deletePrivateChannelVerifiedWallet(
  client: SdpApiClient,
  pubkey: string
): Promise<unknown> {
  return client.fetch(`/v1/private-channels/wallets/${encodeURIComponent(pubkey)}`, {
    method: "DELETE",
  });
}

/** List the org's custody wallets across all providers (the verify picker source). */
export async function fetchCustodyWallets(client: SdpApiClient): Promise<CustodyWalletSummary[]> {
  const query = new URLSearchParams({ includeAllProviders: "true" }).toString();
  const { wallets } = await client.fetch<{ wallets: CustodyWalletSummary[] }>(
    `/v1/wallets?${query}`
  );
  return wallets;
}
