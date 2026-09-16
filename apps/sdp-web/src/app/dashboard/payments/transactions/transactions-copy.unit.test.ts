import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import messages from "../../../../../messages/en/dashboard-payments.json";

describe("unified transaction English copy", () => {
  it("covers every module, kind, and status class in the registry", () => {
    const transactions = messages.DashboardPayments.transactions;
    for (const module of UNIFIED_TRANSACTION_MODULES) {
      expect(transactions.modules[module]).toBeTruthy();
      for (const kind of UNIFIED_TRANSACTION_MODULE_CONTRACTS[module].kinds) {
        expect((transactions.kinds[module] as Record<string, string>)[kind]).toBeTruthy();
      }
    }
    for (const status of UNIFIED_TRANSACTION_STATUSES) {
      expect(transactions.statuses[status]).toBeTruthy();
    }
  });
});
