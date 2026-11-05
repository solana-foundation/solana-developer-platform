import type { Arguments } from "swr";
import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestKey,
  isDashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";
import { type IssuanceListQuery, toIssuanceListRequestParams } from "./issuance-list-query";

const TOKENS_PATH = "/api/dashboard/issuance/tokens";

function tokenPath(tokenId: string): `/api/${string}` {
  return `${TOKENS_PATH}/${encodeURIComponent(tokenId)}`;
}

const AUTHORITY_INCLUDE_PARAMS = {
  includeAllowlistAuthority: "true",
  includeFreezeAuthority: "true",
  includeMetadataAuthority: "true",
  includePauseAuthority: "true",
} as const;

const LATEST_DEPLOY_PARAMS = { type: "deploy", page: 1, pageSize: 5 } as const;

export const issuanceQueryKeys = {
  tokens: (scope: DashboardKeyScope, { query }: { query: IssuanceListQuery }) =>
    dashboardRequestKey(scope, TOKENS_PATH, {
      ...Object.fromEntries(toIssuanceListRequestParams(query)),
      page: query.page,
      pageSize: query.pageSize,
    }),
  isTokensKey: (key: DashboardRequestKey) => key[2] === TOKENS_PATH,
  /** Its fetcher fans out to per-token transaction reads and never sends this key's URL. */
  latestDeploys: (scope: DashboardKeyScope, { tokenIds }: { tokenIds: readonly string[] }) =>
    dashboardRequestKey(scope, TOKENS_PATH, {
      ...LATEST_DEPLOY_PARAMS,
      tokenIds: tokenIds.join(","),
    }),
  latestDeployOf: (scope: DashboardKeyScope, { tokenId }: { tokenId: string }) =>
    dashboardRequestKey(scope, `${tokenPath(tokenId)}/transactions`, LATEST_DEPLOY_PARAMS),
  tokenActivity: (
    scope: DashboardKeyScope,
    {
      tokenId,
      page,
      pageSize,
      action,
      status,
      actorType,
    }: {
      tokenId: string;
      page: number;
      pageSize: number;
      action?: string | undefined;
      status?: string | undefined;
      actorType?: string | undefined;
    }
  ) =>
    dashboardRequestKey(scope, `${tokenPath(tokenId)}/audit`, {
      page,
      pageSize,
      action: action === "" ? undefined : action,
      status: status === "" ? undefined : status,
      type: actorType === "" ? undefined : actorType,
    }),
  tokenTransactions: (
    scope: DashboardKeyScope,
    { tokenId, page, pageSize }: { tokenId: string; page: number; pageSize: number }
  ) => dashboardRequestKey(scope, `${tokenPath(tokenId)}/transactions`, { page, pageSize }),
  tokenAllowlist: (
    scope: DashboardKeyScope,
    {
      tokenId,
      page,
      pageSize,
      search,
      label,
    }: {
      tokenId: string;
      page: number;
      pageSize: number;
      search: string | null;
      label: string | null;
    }
  ) =>
    dashboardRequestKey(scope, `${tokenPath(tokenId)}/allowlist`, {
      page,
      pageSize,
      search: search ?? undefined,
      label: label ?? undefined,
    }),
  tokenAllowlistLabels: (scope: DashboardKeyScope, { tokenId }: { tokenId: string }) =>
    dashboardRequestKey(scope, `${tokenPath(tokenId)}/allowlist/labels`),
  frozenAccounts: (scope: DashboardKeyScope, { tokenId }: { tokenId: string }) =>
    dashboardRequestKey(scope, `${tokenPath(tokenId)}/frozen`),
  /** The token's live authorities; its read also loads the custody wallets that can sign for them. */
  authorityWallets: (scope: DashboardKeyScope, { tokenId }: { tokenId: string }) =>
    dashboardRequestKey(scope, tokenPath(tokenId), AUTHORITY_INCLUDE_PARAMS),
  /** Every list page and the labels of a token's access list, whatever the filters. */
  isTokenAllowlistKey: (tokenId: string) => readsUnderPath(`${tokenPath(tokenId)}/allowlist`),
  isTokenTransactionsKey: (tokenId: string) => (key: DashboardRequestKey) =>
    key[2] === `${tokenPath(tokenId)}/transactions`,
  isTokenFrozenAccountsKey: (tokenId: string) => (key: DashboardRequestKey) =>
    key[2] === `${tokenPath(tokenId)}/frozen`,
  isWalletInventoryKey: (key: Arguments) =>
    isDashboardRequestKey(key) &&
    key[2].startsWith(`${TOKENS_PATH}/`) &&
    key[3]?.includeAllowlistAuthority === AUTHORITY_INCLUDE_PARAMS.includeAllowlistAuthority,
};
