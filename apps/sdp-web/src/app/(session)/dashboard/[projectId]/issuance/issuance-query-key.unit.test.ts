import { describe, expect, it } from "vitest";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestUrl,
} from "@/lib/dashboard-request-key";
import { SANDBOX_PROJECT } from "@/test/projects";
import { DEFAULT_ISSUANCE_LIST_QUERY } from "./issuance-list-query";
import { issuanceQueryKeys } from "./issuance-query-key";

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "demo" };
const TOKEN_ID = "tok_test_1";
const PREFIX_SIBLING_TOKEN_ID = "tok_test_10";
const TOKENS_PATH = "/api/dashboard/issuance/tokens";
const TOKEN_PATH = `${TOKENS_PATH}/${TOKEN_ID}` as const;

const listPage = issuanceQueryKeys.tokens(SCOPE, {
  query: { ...DEFAULT_ISSUANCE_LIST_QUERY, search: "gold", status: "active", page: 2 },
});
const latestDeploys = issuanceQueryKeys.latestDeploys(SCOPE, {
  tokenIds: [TOKEN_ID, PREFIX_SIBLING_TOKEN_ID],
});

function readsOf(tokenId: string) {
  return {
    allowlistPage: issuanceQueryKeys.tokenAllowlist(SCOPE, {
      tokenId,
      page: 2,
      pageSize: 25,
      search: "treasury",
      label: "Operations",
    }),
    allowlistLabels: issuanceQueryKeys.tokenAllowlistLabels(SCOPE, { tokenId }),
    transactionsPage: issuanceQueryKeys.tokenTransactions(SCOPE, {
      tokenId,
      page: 1,
      pageSize: 10,
    }),
    frozenAccounts: issuanceQueryKeys.frozenAccounts(SCOPE, { tokenId }),
    authorities: issuanceQueryKeys.authorityWallets(SCOPE, { tokenId }),
  };
}

const tokenReads = readsOf(TOKEN_ID);
const siblingReads = readsOf(PREFIX_SIBLING_TOKEN_ID);
const everyRead = [...Object.values(tokenReads), ...Object.values(siblingReads)];

const requests: [
  name: string,
  key: DashboardRequestKey,
  expected: DashboardRequestKey,
  url: string,
][] = [
  [
    "a filtered list page",
    listPage,
    [
      SANDBOX_PROJECT.id,
      "demo",
      TOKENS_PATH,
      { status: "active", searchEncoded: "Z29sZA", page: 2, pageSize: 24 },
    ],
    `${TOKENS_PATH}?page=2&pageSize=24&searchEncoded=Z29sZA&status=active`,
  ],
  [
    "one token's latest deploy",
    issuanceQueryKeys.latestDeployOf(SCOPE, { tokenId: TOKEN_ID }),
    [
      SANDBOX_PROJECT.id,
      "demo",
      `${TOKEN_PATH}/transactions`,
      { type: "deploy", page: 1, pageSize: 5 },
    ],
    `${TOKEN_PATH}/transactions?page=1&pageSize=5&type=deploy`,
  ],
  [
    "an activity window with an empty status filter",
    issuanceQueryKeys.tokenActivity(SCOPE, {
      tokenId: TOKEN_ID,
      page: 3,
      pageSize: 20,
      action: "mint",
      status: "",
      actorType: "user",
    }),
    [
      SANDBOX_PROJECT.id,
      "demo",
      `${TOKEN_PATH}/audit`,
      { page: 3, pageSize: 20, action: "mint", type: "user" },
    ],
    `${TOKEN_PATH}/audit?action=mint&page=3&pageSize=20&type=user`,
  ],
  [
    "a transactions page",
    tokenReads.transactionsPage,
    [SANDBOX_PROJECT.id, "demo", `${TOKEN_PATH}/transactions`, { page: 1, pageSize: 10 }],
    `${TOKEN_PATH}/transactions?page=1&pageSize=10`,
  ],
  [
    "a filtered access-list page",
    tokenReads.allowlistPage,
    [
      SANDBOX_PROJECT.id,
      "demo",
      `${TOKEN_PATH}/allowlist`,
      { page: 2, pageSize: 25, search: "treasury", label: "Operations" },
    ],
    `${TOKEN_PATH}/allowlist?label=Operations&page=2&pageSize=25&search=treasury`,
  ],
  [
    "an unfiltered access-list page",
    issuanceQueryKeys.tokenAllowlist(SCOPE, {
      tokenId: TOKEN_ID,
      page: 1,
      pageSize: 25,
      search: null,
      label: null,
    }),
    [SANDBOX_PROJECT.id, "demo", `${TOKEN_PATH}/allowlist`, { page: 1, pageSize: 25 }],
    `${TOKEN_PATH}/allowlist?page=1&pageSize=25`,
  ],
  [
    "the access-list labels",
    tokenReads.allowlistLabels,
    [SANDBOX_PROJECT.id, "demo", `${TOKEN_PATH}/allowlist/labels`],
    `${TOKEN_PATH}/allowlist/labels`,
  ],
  [
    "the frozen accounts",
    tokenReads.frozenAccounts,
    [SANDBOX_PROJECT.id, "demo", `${TOKEN_PATH}/frozen`],
    `${TOKEN_PATH}/frozen`,
  ],
  [
    "the live authorities",
    tokenReads.authorities,
    [
      SANDBOX_PROJECT.id,
      "demo",
      TOKEN_PATH,
      {
        includeAllowlistAuthority: "true",
        includeFreezeAuthority: "true",
        includeMetadataAuthority: "true",
        includePauseAuthority: "true",
      },
    ],
    `${TOKEN_PATH}?includeAllowlistAuthority=true&includeFreezeAuthority=true&includeMetadataAuthority=true&includePauseAuthority=true`,
  ],
];

describe("issuance query keys", () => {
  it.each(requests)("keys %s by the request it sends", (_name, key, expected, url) => {
    expect(key).toEqual(expected);
    expect(dashboardRequestUrl(key)).toBe(url);
  });

  it("keys a page's latest deploys under the list path with its token ids", () => {
    expect(latestDeploys).toEqual([
      SANDBOX_PROJECT.id,
      "demo",
      TOKENS_PATH,
      { type: "deploy", page: 1, pageSize: 5, tokenIds: `${TOKEN_ID},${PREFIX_SIBLING_TOKEN_ID}` },
    ]);
  });

  it("matches the list pages, the latest deploys and the shared issued tokens, and no token's reads", () => {
    const issuedTokens = sharedReadQueryKeys.issuedTokens(SCOPE, { pageSize: 100 });
    expect(
      [listPage, latestDeploys, issuedTokens, ...everyRead].filter(issuanceQueryKeys.isTokensKey)
    ).toEqual([listPage, latestDeploys, issuedTokens]);
  });

  it.each([
    [
      "isTokenAllowlistKey",
      issuanceQueryKeys.isTokenAllowlistKey(TOKEN_ID),
      [tokenReads.allowlistPage, tokenReads.allowlistLabels],
    ],
    [
      "isTokenTransactionsKey",
      issuanceQueryKeys.isTokenTransactionsKey(TOKEN_ID),
      [tokenReads.transactionsPage],
    ],
    [
      "isTokenFrozenAccountsKey",
      issuanceQueryKeys.isTokenFrozenAccountsKey(TOKEN_ID),
      [tokenReads.frozenAccounts],
    ],
  ])("%s matches only that token's own reads of its kind", (_name, matches, expected) => {
    expect(everyRead.filter(matches)).toEqual(expected);
  });

  it("matches every token's authorities as a wallet inventory, and no other issuance read", () => {
    expect(
      [listPage, latestDeploys, ...everyRead].filter(issuanceQueryKeys.isWalletInventoryKey)
    ).toEqual([tokenReads.authorities, siblingReads.authorities]);
  });
});
