import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty } from "@sdp/types";
import { SdpPaymentsError } from "../../../errors";
import { countryField, parseCollectedFields } from "../../requirements";
import type { ValidateCounterpartyOptions } from "../../types";
import {
  bvnkOfframpFields,
  buildBvnkThirdPartyRuleEntity,
  isBvnkOfframpCurrency,
  validateBvnkCounterparty,
} from "./counterparty";
import type { BvnkContactV3 } from "./schemas";

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

function individualContact(): BvnkContactV3 {
  return {
    id: "a3700c37-3f46-4766-b0db-3250b073fd9c",
    description: "cpty_123e4567-e89b-12d3-a456-426614174000",
    entity: {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      address: {
        addressLine1: "1 Main Street",
        addressLine2: "Suite 400",
        city: "Austin",
        stateCode: "TX",
        postalCode: "78701",
        region: "Texas",
        country: "US",
      },
    },
    createdAt: "2026-06-10T10:30:00Z",
    updatedAt: "2026-06-10T10:30:00Z",
  };
}

function companyContact(): BvnkContactV3 {
  return {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    description: "cpty_123e4567-e89b-12d3-a456-426614174000",
    entity: {
      type: "COMPANY",
      relationshipType: "THIRD_PARTY",
      legalName: "Acme Corporation",
      registrationNumber: "12345678",
    },
    createdAt: "2026-06-10T10:30:00Z",
    updatedAt: "2026-06-10T10:30:00Z",
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
        validateBvnkCounterparty(
          counterparty(),
          { direction: "offramp", providerData: {} } as unknown as ValidateCounterpartyOptions
        ),
      SdpPaymentsError
    );
  });
});

describe("buildBvnkThirdPartyRuleEntity", () => {
  it("maps an individual contact onto a THIRD_PARTY INDIVIDUAL rule entity", () => {
    const entity = buildBvnkThirdPartyRuleEntity(individualContact(), counterparty().id);

    assert.deepEqual(entity, {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: counterparty().id,
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      address: {
        addressLine1: "1 Main Street",
        addressLine2: "Suite 400",
        city: "Austin",
        stateCode: "TX",
        postalCode: "78701",
        countryCode: "US",
        country: "US",
      },
    });
  });

  it("omits optional identity lanes when the contact has no address or birth date", () => {
    const minimal: BvnkContactV3 = {
      ...individualContact(),
      entity: {
        type: "INDIVIDUAL",
        relationshipType: "THIRD_PARTY",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    };

    const entity = buildBvnkThirdPartyRuleEntity(minimal, counterparty().id);

    assert.equal(entity.type, "INDIVIDUAL");
    assert.equal(entity.address, undefined);
    assert.equal(entity.dateOfBirth, undefined);
  });

  it("maps a company contact onto a THIRD_PARTY COMPANY rule entity", () => {
    const entity = buildBvnkThirdPartyRuleEntity(companyContact(), counterparty().id);

    assert.deepEqual(entity, {
      type: "COMPANY",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: counterparty().id,
      legalName: "Acme Corporation",
      registrationNumber: "12345678",
    });
  });
});
