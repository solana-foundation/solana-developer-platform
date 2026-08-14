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
    const nonWalletScopedRoutes = new Set(["GET /config", "GET /configs", "GET /switch-options"]);

    expect(allRoutes.filter((route) => !nonWalletScopedRoutes.has(route))).toEqual([
      // Wallet lifecycle mutations enforce bindings (or reject wallet-scoped
      // keys outright): see custody-wallet-scope.test.ts.
      "DELETE /",
      "GET /",
      "GET /:walletId",
      "GET /aggregate",
      "GET /approval-requests",
      "GET /approval-requests/:approvalRequestId",
      "GET /public-key",
      "PATCH /:walletId",
      "POST /",
      "POST /approval-requests/:approvalRequestId/approve",
      "POST /approval-requests/:approvalRequestId/cancel",
      "POST /approval-requests/:approvalRequestId/reject",
      "POST /default-wallet",
      "POST /initialize",
      "POST /signer-check",
      "POST /switch",
    ]);
  });

  it("tracks every wallet-scoped payments route", () => {
    const allRoutes = extractRoutes(paymentsRoutes);
    const nonWalletScopedRoutes = new Set([
      "ALL /recurring-payments",
      "ALL /recurring-payments/*",
      "ALL /subscription-plans",
      "ALL /subscription-plans/*",
      "ALL /subscriptions",
      "ALL /subscriptions/*",
      "GET /ramps/offramp/currency",
      "GET /ramps/onramp/currency",
      "GET /requests",
      "GET /subscription-plans",
      "GET /subscription-plans/:planId",
      "GET /subscriptions",
      "GET /subscriptions/:subscriptionId",
      "GET /subscriptions/:subscriptionId/collection-attempts",
      "GET /transfer-batches",
      "GET /transfer-batches/:batchId",
      "POST /ramps/:provider/events",
      "POST /ramps/offramp/estimate",
      "POST /ramps/onramp/estimate",
      "POST /ramps/sandbox/simulate",
      "POST /ramps/transfers/cancel",
      "POST /subscriptions",
      "POST /subscriptions/:subscriptionId/prepare-authorization",
      "POST /subscriptions/:subscriptionId/prepare-cancel",
      "POST /subscriptions/:subscriptionId/prepare-resume",
    ]);

    expect(allRoutes.filter((route) => !nonWalletScopedRoutes.has(route))).toEqual([
      "GET /recurring-payments",
      "GET /recurring-payments/:id",
      "GET /transfers",
      "GET /transfers/:transferId",
      "GET /wallets/:walletId/balances",
      "GET /wallets/:walletId/policies",
      "GET /wallets/:walletId/policies/evaluations",
      "GET /wallets/:walletId/policies/evaluations/:policyEvaluationId",
      "GET /wallets/:walletId/policies/revisions",
      "PATCH /recurring-payments/:id",
      "PATCH /subscription-plans/:planId",
      "POST /ramps/offramp/quote",
      "POST /ramps/onramp/quote",
      "POST /recurring-payments",
      "POST /recurring-payments/:id/activate",
      "POST /recurring-payments/:id/cancel",
      "POST /recurring-payments/:id/collect",
      "POST /recurring-payments/:id/resume",
      "POST /requests",
      "POST /subscription-plans",
      "POST /subscription-plans/:planId/prepare-create",
      "POST /subscriptions/:subscriptionId/prepare-collection",
      "POST /transfer-batches",
      "POST /transfer-batches/estimate",
      "POST /transfers",
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
      // Read-only filter facets for the token list: no signing wallet resolved.
      "GET /tokens/facets",
      "GET /tokens/:tokenId/allowlist",
      "GET /tokens/:tokenId/allowlist/labels",
      "GET /tokens/:tokenId/audit",
      "GET /tokens/:tokenId/frozen",
      "GET /tokens/:tokenId/metadata.json",
      "GET /tokens/:tokenId/transactions",
      "PATCH /tokens/:tokenId",
      "POST /tokens",
      "POST /tokens/:tokenId/allowlist",
      "POST /tokens/:tokenId/supply/refresh",
      // Asset profiles: holder enrollment and the workflow builder. None of these
      // resolves a signing wallet — they read and write rule/holder rows and flip
      // execution status. The signing wallet for a rule's on-chain effect is resolved
      // by the cron engine at execution time (workflows/actions/onchain.ts), which is
      // also where that effect is bound to the wallet's operation policy, since no
      // request is in scope by then.
      "ALL /tokens/:tokenId/workflows",
      "ALL /tokens/:tokenId/workflows/*",
      "DELETE /tokens/:tokenId/workflows/:workflowId",
      "GET /tokens/:tokenId/holders",
      "GET /tokens/:tokenId/workflows",
      "GET /tokens/:tokenId/workflows/catalog",
      "GET /tokens/:tokenId/workflows/executions",
      "PATCH /tokens/:tokenId/workflows/:workflowId",
      "POST /tokens/:tokenId/holders",
      "POST /tokens/:tokenId/workflows",
      "POST /tokens/:tokenId/workflows/executions/:executionId/approve",
      "POST /tokens/:tokenId/workflows/executions/:executionId/reject",
      "POST /tokens/:tokenId/workflows/executions/:executionId/retry",
    ]);

    expect(allRoutes.filter((route) => !nonWalletScopedRoutes.has(route))).toEqual([
      "GET /transactions",
      "POST /tokens/:tokenId/authority",
      "POST /tokens/:tokenId/authority/prepare",
      "POST /tokens/:tokenId/burn",
      "POST /tokens/:tokenId/burn/prepare",
      "POST /tokens/:tokenId/deploy",
      "POST /tokens/:tokenId/deploy/confirm",
      "POST /tokens/:tokenId/deploy/prepare",
      "POST /tokens/:tokenId/deploy/prepare-metadata",
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
