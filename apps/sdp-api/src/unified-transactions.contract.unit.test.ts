import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types";
import { unifiedTransactionSchema } from "./routes/transactions/schemas";

// A row shaped like the ones the unified-transactions repository parses out of
// Postgres on every read.
function rowFor(module: UnifiedTransactionModule) {
  const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS[module];
  return {
    id: `${module}:row`,
    module,
    kind: contract.kinds[0],
    moduleId: `${module}:module-row`,
    moduleStatus: contract.moduleStatuses[0],
    status: Object.values(contract.status)[0],
    organizationId: "org_test",
    projectId: "project_test",
    custodyWalletId: null,
    custodyWalletLabel: null,
    token: null,
    amount: null,
    counterpartyId: null,
    signature: null,
    createdAt: "2026-09-15T00:00:00.000Z",
  };
}

describe("unified transaction contract", () => {
  it("parses one row per module, preserving every field", () => {
    for (const module of UNIFIED_TRANSACTION_MODULES) {
      const input = rowFor(module);
      expect(unifiedTransactionSchema.parse(input)).toEqual(input);
    }
  });

  it("rejects a moduleStatus that belongs to a different module", () => {
    // Cross-module leakage is the failure the per-module vocabularies exist to
    // prevent: "partially_funded" is DvP-only, "draft" is rings-only and
    // "awaiting_payment" is payments-only. A schema that accepted any status
    // for any module would mislabel stored rows instead of failing the read.
    const paymentsRow = rowFor("payments");
    expect(() =>
      unifiedTransactionSchema.parse({ ...paymentsRow, moduleStatus: "partially_funded" })
    ).toThrow(/moduleStatus/);
    expect(() => unifiedTransactionSchema.parse({ ...paymentsRow, moduleStatus: "draft" })).toThrow(
      /moduleStatus/
    );

    const earnRow = rowFor("earn");
    expect(() =>
      unifiedTransactionSchema.parse({ ...earnRow, moduleStatus: "awaiting_payment" })
    ).toThrow(/moduleStatus/);
  });

  it("rejects a kind that belongs to a different module", () => {
    const paymentsRow = rowFor("payments");
    expect(() => unifiedTransactionSchema.parse({ ...paymentsRow, kind: "withdraw" })).toThrow(
      /kind/
    );

    const earnRow = rowFor("earn");
    expect(() => unifiedTransactionSchema.parse({ ...earnRow, kind: "batch_pay" })).toThrow(/kind/);
  });
});
