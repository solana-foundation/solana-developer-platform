import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty } from "@sdp/types";
import { lightsparkCounterpartyRequirements } from "./counterparty";

const COUNTERPARTY: Counterparty = {
  id: "cp_123",
  organizationId: "org_123",
  projectId: "proj_123",
  externalId: null,
  entityType: "individual",
  displayName: "Ada Lovelace",
  status: "active",
  createdBy: null,
  createdAt: "2026-06-11T00:00:00.000Z",
  updatedAt: "2026-06-11T00:00:00.000Z",
};

describe("lightsparkCounterpartyRequirements", () => {
  it("returns ready with the active corridor account and payout tree", () => {
    const requirements = lightsparkCounterpartyRequirements(COUNTERPARTY, {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      cryptoRail: "usdc.solana",
      payoutAccounts: [
        {
          id: "account_us",
          destinationCountry: "US",
          paymentRail: "ACH",
          status: "active",
        },
      ],
      destinationCountry: "US",
      providerCustomerReference: "Customer:cus_123",
    });

    assert.equal(requirements.status, "ready");
    if (requirements.status !== "ready" || requirements.provider !== "lightspark") {
      assert.fail("Expected Lightspark ready requirements");
    }
    assert.equal(requirements.direction, "offramp");
    if (requirements.direction !== "offramp") {
      assert.fail("Expected Lightspark off-ramp requirements");
    }
    assert.equal(requirements.providerAccountId, "account_us");
    if (requirements.payout === undefined) {
      assert.fail("Expected ready requirements to carry the payout tree");
    }
    assert.deepEqual(requirements.payout.accounts, [
      {
        id: "account_us",
        destinationCountry: "US",
        paymentRail: "ACH",
        status: "active",
      },
    ]);
    assert.deepEqual(requirements.payout.countryRails.US, [
      { value: "ACH", label: "ACH" },
      { value: "FEDNOW", label: "FedNow" },
      { value: "RTP", label: "RTP" },
      { value: "WIRE", label: "Wire" },
      { value: "SWIFT", label: "SWIFT" },
    ]);
  });

  it("collects an account when no active account matches the destination country", () => {
    const requirements = lightsparkCounterpartyRequirements(COUNTERPARTY, {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      cryptoRail: "usdc.solana",
      payoutAccounts: [
        {
          id: "account_us_pending",
          destinationCountry: "US",
          paymentRail: "ACH",
          status: "CREATED",
        },
        {
          id: "account_gb_active",
          destinationCountry: "GB",
          paymentRail: "SWIFT",
          status: "ACTIVE",
        },
      ],
      destinationCountry: "US",
      providerCustomerReference: "Customer:cus_123",
    });

    assert.equal(requirements.status, "collect_account");
  });

  it("keeps collecting an account when destinationCountry is absent", () => {
    const requirements = lightsparkCounterpartyRequirements(COUNTERPARTY, {
      direction: "offramp",
      providerData: { lightspark: { purposeOfPayment: "GOODS_OR_SERVICES" } },
      fiatCurrency: "USD",
      cryptoRail: "usdc.solana",
      payoutAccounts: [
        {
          id: "account_us",
          destinationCountry: "US",
          paymentRail: "ACH",
          status: "ACTIVE",
        },
      ],
      providerCustomerReference: "Customer:cus_123",
    });

    assert.equal(requirements.status, "collect_account");
  });
});
