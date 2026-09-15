import {
  DVP_TRADE_STATUSES,
  EARN_TRANSACTION_MODULE_STATUSES,
  HELIUS_RINGS_OPERATION_STATUSES,
  PAYMENT_TRANSFER_STATUSES,
  PRIVATE_CHANNEL_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_STATUSES,
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
} from "@sdp/types";
import { unifiedTransactionSchema } from "./routes/transactions/schemas";

describe("unified transaction contract", () => {
  it("references every canonical status vocabulary", () => {
    expect(UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments.moduleStatuses).toBe(
      PAYMENT_TRANSFER_STATUSES
    );
    expect(UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.moduleStatuses).toBe(
      EARN_TRANSACTION_MODULE_STATUSES
    );
    expect(UNIFIED_TRANSACTION_MODULE_CONTRACTS.dvp.moduleStatuses).toBe(DVP_TRADE_STATUSES);
    expect(UNIFIED_TRANSACTION_MODULE_CONTRACTS.private_channels.moduleStatuses).toBe(
      PRIVATE_CHANNEL_TRANSACTION_STATUSES
    );
    expect(UNIFIED_TRANSACTION_MODULE_CONTRACTS.issuance.moduleStatuses).toBe(
      TOKEN_TRANSACTION_STATUSES
    );
    expect(UNIFIED_TRANSACTION_MODULE_CONTRACTS.rings.moduleStatuses).toBe(
      HELIUS_RINGS_OPERATION_STATUSES
    );
  });

  it("parses one row per module", () => {
    for (const module of UNIFIED_TRANSACTION_MODULES) {
      const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS[module];
      expect(
        unifiedTransactionSchema.parse({
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
        }).module
      ).toBe(module);
    }
  });
});
