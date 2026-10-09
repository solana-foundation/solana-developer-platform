import { describe, expect, it } from "vitest";
import { declaredAllowedOperation } from "@/middleware/allowed-operations";
import dvpRoutes from "@/routes/dvp";
import earnRoutes from "@/routes/earn";
import issuanceRoutes from "@/routes/issuance";
import paymentsRoutes from "@/routes/payments";

/**
 * Every value-moving route declares the operation it performs so the calling
 * key's Allowed Operations can refuse it (ADR 0006). This inventory pins the
 * declarations: a new route that moves value must appear here, and a route
 * must not declare two operations.
 */
function declarations(router: unknown): Record<string, string> {
  const routes =
    (router as { routes?: Array<{ method: string; path: string; handler: unknown }> }).routes ?? [];
  const declared: Record<string, string> = {};
  for (const route of routes) {
    const operation = declaredAllowedOperation(route.handler);
    if (!operation) continue;
    const key = `${route.method.toUpperCase()} ${route.path}`;
    expect(declared[key], `${key} declares two operations`).toBeUndefined();
    declared[key] = operation;
  }
  return declared;
}

describe("allowed operation route declarations", () => {
  it("covers every gated payments route", () => {
    expect(declarations(paymentsRoutes)).toEqual({
      "POST /transfers": "payment_transfer_execute",
      "POST /transfer-batches": "payment_transfer_batch_execute",
      "POST /ramps/onramp/quote": "ramp_onramp_quote",
      "POST /ramps/offramp/quote": "ramp_offramp_quote",
      "POST /recurring-payments": "recurring_payment_create",
      "PATCH /recurring-payments/:id": "recurring_payment_update",
      "POST /recurring-payments/:id/collect": "recurring_payment_collection",
    });
  });

  it("covers DvP fund and settle, and leaves the exits ungated", () => {
    expect(declarations(dvpRoutes)).toEqual({
      "POST /trades/:tradeId/fund": "dvp_fund",
      "POST /trades/:tradeId/settle": "dvp_settle",
    });
  });

  it("covers every Earn route that moves value", () => {
    expect(declarations(earnRoutes)).toEqual({
      "POST /vault-deposits": "earn_vault_deposit",
      "POST /vault-withdrawals": "earn_vault_withdrawal",
      "POST /vault-withdrawal-requests": "earn_vault_withdrawal",
      "POST /programs/:programId/withdrawals": "earn_program_withdrawal",
    });
  });

  it("covers every issuance execution route", () => {
    expect(declarations(issuanceRoutes)).toEqual({
      "PATCH /tokens/:tokenId": "issuance_metadata_update_execute",
      "POST /tokens/:tokenId/deploy": "issuance_deploy_execute",
      "POST /tokens/:tokenId/mint": "issuance_mint_execute",
      "POST /tokens/:tokenId/burn": "issuance_burn_execute",
      "POST /tokens/:tokenId/seize": "issuance_seize_execute",
      "POST /tokens/:tokenId/force-burn": "issuance_force_burn_execute",
      "POST /tokens/:tokenId/authority": "issuance_update_authority_execute",
      "POST /tokens/:tokenId/pause": "issuance_pause_execute",
      "POST /tokens/:tokenId/unpause": "issuance_unpause_execute",
      "POST /tokens/:tokenId/freeze": "issuance_freeze_execute",
      "POST /tokens/:tokenId/unfreeze": "issuance_unfreeze_execute",
      "POST /tokens/:tokenId/allowlist": "issuance_allowlist_add_execute",
      "DELETE /tokens/:tokenId/allowlist/:entryId": "issuance_allowlist_remove_execute",
    });
  });
});
