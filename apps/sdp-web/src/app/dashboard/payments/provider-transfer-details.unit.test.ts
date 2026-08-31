import { describe, expect, it } from "vitest";
import { providerTransferDetailRows } from "./provider-transfer-details";

describe("providerTransferDetailRows", () => {
  it("builds a MoonPay sell receipt from the bound provider transaction id", () => {
    const rows = providerTransferDetailRows(
      {
        id: "xfr_123",
        status: "completed",
        signature: null,
        rampsMemo: {},
        type: "offramp",
        provider: "moonpay",
        providerReference: "772f7a7f-142e-43cf-824f-8d861aefe8bd",
      },
      { cluster: "devnet" },
      (key) => key
    );

    expect(rows).toContainEqual({
      key: "DashboardPayments.transferDetails.receipt",
      label: "DashboardPayments.transferDetails.receipt",
      value: "DashboardPayments.transferDetails.viewReceipt",
      href: "https://buy.moonpay.com/v2/transaction-tracker?transactionId=772f7a7f-142e-43cf-824f-8d861aefe8bd",
    });
  });
});
