import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

const PRIVATE_CHANNELS_READ_PATH = "/api/dashboard/private-channels";

export const PRIVATE_CHANNELS_EVENTS_PAGE_SIZE = 50;

export const privateChannelsQueryKeys = {
  channels: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/channels`),
  tokens: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/tokens`),
  principals: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/principals`),
  verifiedWallets: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/wallets`),
  /** One entry for every owner's balance: the fetcher sends one `owner` request per pubkey. */
  balances: (scope: DashboardKeyScope, owners: readonly string[]) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/balance`, {
      owners: [...owners].sort().join(","),
    }),
  balance: (scope: DashboardKeyScope, owner: string) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/balance`, { owner }),
  events: (scope: DashboardKeyScope, params: { limit: number }) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/events`, params),
  eventReferences: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, `${PRIVATE_CHANNELS_READ_PATH}/events/references`),
  deposit: (scope: DashboardKeyScope, depositId: string) =>
    dashboardRequestKey(
      scope,
      `${PRIVATE_CHANNELS_READ_PATH}/deposits/${encodeURIComponent(depositId)}`
    ),
  withdrawal: (scope: DashboardKeyScope, withdrawalId: string) =>
    dashboardRequestKey(
      scope,
      `${PRIVATE_CHANNELS_READ_PATH}/withdrawals/${encodeURIComponent(withdrawalId)}`
    ),
};

/** Every Private Channels read: a write to the instance, a channel, a member or a wallet can change any of them. */
export const privateChannelsReads = readsUnderPath(PRIVATE_CHANNELS_READ_PATH);

const custodyWalletReads = readsUnderPath("/api/dashboard/wallets");

/** A deposit or withdrawal also moves the custody wallet's on-chain balance. */
export const privateChannelsMovementReads = (key: DashboardRequestKey) =>
  privateChannelsReads(key) || custodyWalletReads(key);
