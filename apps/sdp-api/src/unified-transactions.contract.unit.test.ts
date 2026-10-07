import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
  type UnifiedTransactionStatus,
} from "@sdp/types";
import { unifiedTransactionSchema } from "./routes/transactions/schemas";

describe("unified transaction contract", () => {
  it("maps every module status onto a canonical unified status", () => {
    for (const module of UNIFIED_TRANSACTION_MODULES) {
      const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS[module];

      expect(contract.moduleStatuses.length, `${module}: declares statuses`).toBeGreaterThan(0);
      expect(new Set(contract.moduleStatuses).size, `${module}: statuses are unique`).toBe(
        contract.moduleStatuses.length
      );
      // The status map must cover exactly the declared module statuses: the SQL
      // view generator CASEs on these keys, so a missing entry yields NULL and
      // an extra one is dead.
      expect(Object.keys(contract.status).sort(), `${module}: status map coverage`).toEqual(
        [...contract.moduleStatuses].sort()
      );
      for (const [moduleStatus, status] of Object.entries(contract.status)) {
        expect(
          UNIFIED_TRANSACTION_STATUSES,
          `${module}: ${moduleStatus} maps to a canonical unified status`
        ).toContain(status);
      }
    }
  });

  it("parses one row per module status", () => {
    for (const module of UNIFIED_TRANSACTION_MODULES) {
      const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS[module];
      const statusOf: Readonly<Record<string, UnifiedTransactionStatus>> = contract.status;
      for (const moduleStatus of contract.moduleStatuses) {
        const status = statusOf[moduleStatus];
        expect(
          unifiedTransactionSchema.parse({
            id: `${module}:row`,
            module,
            kind: contract.kinds[0],
            moduleId: `${module}:module-row`,
            moduleStatus,
            status,
            organizationId: "org_test",
            projectId: "project_test",
            custodyWalletId: null,
            custodyWalletLabel: null,
            token: null,
            amount: null,
            counterpartyId: null,
            signature: null,
            createdAt: "2026-09-15T00:00:00.000Z",
          })
        ).toEqual({
          id: `${module}:row`,
          module,
          kind: contract.kinds[0],
          moduleId: `${module}:module-row`,
          moduleStatus,
          status,
          organizationId: "org_test",
          projectId: "project_test",
          custodyWalletId: null,
          custodyWalletLabel: null,
          token: null,
          amount: null,
          counterpartyId: null,
          signature: null,
          createdAt: "2026-09-15T00:00:00.000Z",
        });
      }
    }
  });
});
