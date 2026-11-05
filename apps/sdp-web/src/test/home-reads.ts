import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import type { Mock } from "vitest";
import { ISSUANCE_MAX_PAGE_SIZE } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-list-query";
import { dashboardErrorResponse, stubDashboardFetch } from "./dashboard-fetch";

/** The Overview's account reads, by the URL each one sends. */
export const HOME_READ_URLS = {
  aggregate: "/api/dashboard/wallets/aggregate",
  wallets: "/api/dashboard/wallets?view=summary",
  issuedTokens: `/api/dashboard/issuance/tokens?page=1&pageSize=${ISSUANCE_MAX_PAGE_SIZE}`,
} as const;

/** How the stub answers each account read; looked up per request, so a test may swap one. */
export type HomeReadAnswers = Record<keyof typeof HOME_READ_URLS, () => Response>;

/** One issued token as the listing returns it. */
export interface IssuedTokenListing {
  id: string;
  name: string;
  mintAddress: string;
  symbol: string;
  decimals: number;
}

export function walletAggregateResponse(
  walletCount: number,
  balances: CustodyWalletTokenBalance[]
): Response {
  return Response.json({ data: { aggregate: { walletCount, balances } } });
}

export function walletSummariesResponse(walletIds: readonly string[]): Response {
  return Response.json({
    data: {
      wallets: walletIds.map((id) => ({
        id,
        walletId: `${id}_provider`,
        publicKey: `${id}_address`,
        isRuntimeExecutionAllowed: true,
        custodyConfigId: "cfg_test",
      })),
    },
  });
}

export function issuedTokensResponse(tokens: readonly IssuedTokenListing[]): Response {
  return Response.json({
    data: tokens.map((token) => ({ ...token, imageUrl: null })),
    total: tokens.length,
    hasMore: false,
  });
}

export function failedHomeRead(): Response {
  return dashboardErrorResponse(503, "Service unavailable");
}

/** Stubs `fetch` to answer the Overview's account reads from `answers`; any other read throws. */
export function stubHomeReads(answers: HomeReadAnswers): Mock<typeof fetch> {
  return stubDashboardFetch(({ path }) => {
    switch (path) {
      case HOME_READ_URLS.aggregate:
        return answers.aggregate();
      case HOME_READ_URLS.wallets:
        return answers.wallets();
      case HOME_READ_URLS.issuedTokens:
        return answers.issuedTokens();
      default:
        throw new Error(`Unexpected read ${path}`);
    }
  });
}
