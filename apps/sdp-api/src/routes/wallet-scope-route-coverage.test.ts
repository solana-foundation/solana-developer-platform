import { describe, expect, it } from "vitest";
import custodyRoutes from "@/routes/custody";
import issuanceRoutes from "@/routes/issuance";
import paymentsRoutes from "@/routes/payments";

function extractRoutes(router: unknown): string[] {
  const routes = ((router as { routes?: Array<{ method: string; path: string }> }).routes ?? [])
    .map((route) => `${route.method.toUpperCase()} ${route.path}`)
    .filter((route) => route !== "ALL /*");

  return Array.from(new Set(routes)).sort();
}

describe("wallet-scoped route coverage inventory", () => {
  it("tracks every wallet-scoped custody route", () => {
    const allRoutes = extractRoutes(custodyRoutes);
    const nonWalletScopedRoutes = new Set([
      "DELETE /",
      "GET /config",
      "GET /configs",
      "GET /switch-options",
      "POST /",
      "POST /default-wallet",
      "POST /initialize",
      "POST /switch",
    ]);

    expect(allRoutes.filter((route) => !nonWalletScopedRoutes.has(route))).toEqual([
      "GET /",
      "GET /:walletId",
      "GET /aggregate",
      "GET /public-key",
      "PATCH /:walletId",
      "POST /signer-check",
    ]);
  });

  it("tracks every wallet-scoped payments route", () => {
    expect(extractRoutes(paymentsRoutes)).toEqual([
      "GET /transfers",
      "GET /transfers/:transferId",
      "GET /wallets/:walletId/balances",
      "GET /wallets/:walletId/policies",
      "POST /ramps/offramp/execute",
      "POST /ramps/onramp/execute",
      "POST /transfers",
      "POST /transfers/prepare",
      "PUT /wallets/:walletId/policies",
    ]);
  });

  it("tracks every issuance route that resolves a signing wallet", () => {
    const allRoutes = extractRoutes(issuanceRoutes);
    const nonWalletScopedRoutes = new Set([
      "DELETE /tokens/:tokenId/allowlist/:entryId",
      "GET /templates",
      "GET /templates/:templateId",
      "GET /tokens",
      "GET /tokens/:tokenId",
      "GET /tokens/:tokenId/allowlist",
      "GET /tokens/:tokenId/frozen",
      "GET /tokens/:tokenId/transactions",
      "PATCH /tokens/:tokenId",
      "POST /tokens",
      "POST /tokens/:tokenId/allowlist",
      "POST /tokens/:tokenId/supply/refresh",
    ]);

    expect(allRoutes.filter((route) => !nonWalletScopedRoutes.has(route))).toEqual([
      "GET /transactions",
      "POST /tokens/:tokenId/authority",
      "POST /tokens/:tokenId/authority/prepare",
      "POST /tokens/:tokenId/burn",
      "POST /tokens/:tokenId/burn/prepare",
      "POST /tokens/:tokenId/deploy",
      "POST /tokens/:tokenId/deploy/prepare",
      "POST /tokens/:tokenId/force-burn",
      "POST /tokens/:tokenId/force-burn/prepare",
      "POST /tokens/:tokenId/freeze",
      "POST /tokens/:tokenId/mint",
      "POST /tokens/:tokenId/mint/prepare",
      "POST /tokens/:tokenId/pause",
      "POST /tokens/:tokenId/seize",
      "POST /tokens/:tokenId/seize/prepare",
      "POST /tokens/:tokenId/unfreeze",
      "POST /tokens/:tokenId/unpause",
    ]);
  });
});
