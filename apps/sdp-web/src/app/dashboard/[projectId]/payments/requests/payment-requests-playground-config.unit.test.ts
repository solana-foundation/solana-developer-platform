import type { PaymentsDashboardWallet } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { buildPaymentRequestsPlaygroundEndpointConfigs } from "./payment-requests-playground-config";

const wallet: PaymentsDashboardWallet = {
  id: "cwlt_a",
  walletId: "provider_shared",
  label: "Treasury",
  publicKey: "saved_destination",
  isRuntimeExecutionAllowed: true,
};

describe("Request playground recipient selection", () => {
  it("keeps separate SDP IDs for wallets sharing a label, provider reference and address", () => {
    const create = buildPaymentRequestsPlaygroundEndpointConfigs(
      [wallet, { ...wallet, id: "cwlt_b" }],
      [],
      (key) => key
    ).find((endpoint) => endpoint.id === "create-payment-request");
    expect(create?.bodyFields[0]).toMatchObject({
      key: "custodyWalletId",
      defaultValue: "cwlt_a",
      options: [
        { value: "cwlt_a", label: "Treasury" },
        { value: "cwlt_b", label: "Treasury" },
      ],
    });
    expect(create?.bodyFields.map(({ key }) => key)).not.toContain("walletId");
    expect(create?.expectedResponse).toMatchObject({ custodyWalletId: "cwlt_example" });
    expect(create?.expectedResponse).not.toHaveProperty("walletId");
  });
});
