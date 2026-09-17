import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty } from "@sdp/types";
import { SdpPaymentsError } from "../../../errors";
import { countryField, parseCollectedFields } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import { bvnkOfframpFields, isBvnkOfframpCurrency, validateBvnkCounterparty } from "./counterparty";

function counterparty(): Counterparty {
  return {
    id: "cpty_123e4567-e89b-12d3-a456-426614174000",
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
}

describe("country field options", () => {
  it("validates collected values against the offered subset", () => {
    const fields = [
      countryField({
        key: "taxResidenceCountryCode",
        label: "Tax residence country",
        required: true,
        options: ["US", "DE"],
      }),
    ];

    assert.deepEqual(parseCollectedFields(fields, { taxResidenceCountryCode: "DE" }, "message"), {
      taxResidenceCountryCode: "DE",
    });
    assert.throws(
      () => parseCollectedFields(fields, { taxResidenceCountryCode: "RU" }, "message"),
      SdpPaymentsError
    );
  });
});

describe("BVNK off-ramp currency and fields", () => {
  it("accepts the verified payout corridors", () => {
    assert.equal(isBvnkOfframpCurrency("USD"), true);
    assert.equal(isBvnkOfframpCurrency("EUR"), true);
    assert.equal(isBvnkOfframpCurrency("GBP"), false);
  });

  it("builds the corridor field set", () => {
    const fields = bvnkOfframpFields("USD");
    assert.deepEqual(
      fields.map((field) => field.key),
      ["accountNumber", "routingNumber"]
    );
  });
});

describe("validateBvnkCounterparty", () => {
  it("rejects off-ramp payouts in an unsupported currency", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "GBP",
    });

    assert.equal(requirements.status, "unsupported");
  });

  it("collects bank details when no off-ramp beneficiary is stored", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "offramp",
      providerData: {},
      fiatCurrency: "USD",
    });

    assert.equal(requirements.status, "collect");
    assert.deepEqual(requirements.fields, bvnkOfframpFields("USD"));
  });

  it("reports provisioning while the off-ramp wallet is inactive", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "offramp",
      providerData: {
        bvnk: {
          offramp: {
            beneficiaries: {
              "USD:abc123": {
                key: "USD:abc123",
                fiatCurrency: "USD",
                accountType: "ACH",
                createdAt: "2026-06-11T00:00:00.000Z",
              },
            },
            wallets: { USD: { id: "wallet-id", status: "INACTIVE" } },
          },
        },
      },
      fiatCurrency: "USD",
    });

    assert.deepEqual(requirements, {
      provider: "bvnk",
      direction: "offramp",
      status: "provisioning",
    });
  });

  it("reports ready once the off-ramp wallet is active", () => {
    const requirements = validateBvnkCounterparty(counterparty(), {
      direction: "offramp",
      providerData: {
        bvnk: {
          offramp: {
            beneficiaries: {
              "USD:abc123": {
                key: "USD:abc123",
                fiatCurrency: "USD",
                accountType: "ACH",
                createdAt: "2026-06-11T00:00:00.000Z",
              },
            },
            wallets: { USD: { id: "wallet-id", status: "ACTIVE" } },
          },
        },
      },
      fiatCurrency: "USD",
    });

    assert.deepEqual(requirements, {
      provider: "bvnk",
      direction: "offramp",
      status: "ready",
    });
  });

  it("requires a fiat currency for off-ramp validation", () => {
    assert.throws(
      () =>
        validateBvnkCounterparty(counterparty(), {
          direction: "offramp",
          providerData: {},
        } as unknown as ValidateCounterpartyOptions),
      SdpPaymentsError
    );
  });
});
