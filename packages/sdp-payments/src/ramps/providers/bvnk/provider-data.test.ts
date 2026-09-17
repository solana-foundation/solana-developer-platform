import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBvnkThirdPartyRuleEntity } from "./counterparty";
import {
  buildBvnkOfframpWalletName,
  buildBvnkOnrampWalletName,
  buildBvnkWalletIdempotencyKey,
} from "./provider-data";
import type { BvnkContactV3 } from "./schemas";

function bvnkContactV3Fixture(id: string, entity: BvnkContactV3["entity"]): BvnkContactV3 {
  return {
    id,
    entity,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

describe("buildBvnkThirdPartyRuleEntity", () => {
  const COUNTERPARTY_ID = "cpty_123e4567-e89b-12d3-a456-426614174000";

  it("maps an individual contact to a THIRD_PARTY rule entity keyed to the counterparty", () => {
    const contact = bvnkContactV3Fixture("contact_individual_1", {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      address: {
        addressLine1: "1 Analytical Engine Way",
        city: "Austin",
        postalCode: "78701",
        country: "US",
      },
    });

    assert.deepEqual(buildBvnkThirdPartyRuleEntity(contact, COUNTERPARTY_ID), {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: COUNTERPARTY_ID,
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      address: {
        addressLine1: "1 Analytical Engine Way",
        city: "Austin",
        postalCode: "78701",
        country: "US",
        countryCode: "US",
      },
    });
  });

  it("omits the optional individual fields when the contact does not carry them", () => {
    const contact = bvnkContactV3Fixture("contact_individual_2", {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    assert.deepEqual(buildBvnkThirdPartyRuleEntity(contact, COUNTERPARTY_ID), {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: COUNTERPARTY_ID,
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("maps a company contact to a THIRD_PARTY rule entity with legal entity fields", () => {
    const contact = bvnkContactV3Fixture("contact_company_1", {
      type: "COMPANY",
      relationshipType: "THIRD_PARTY",
      legalName: "Acme Widgets Ltd",
      registrationNumber: "01234567",
      address: {
        addressLine1: "20 Finsbury Circus",
        city: "London",
        postalCode: "EC2M 7DT",
        country: "GB",
      },
    });

    assert.deepEqual(buildBvnkThirdPartyRuleEntity(contact, COUNTERPARTY_ID), {
      type: "COMPANY",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: COUNTERPARTY_ID,
      legalName: "Acme Widgets Ltd",
      registrationNumber: "01234567",
      address: {
        addressLine1: "20 Finsbury Circus",
        city: "London",
        postalCode: "EC2M 7DT",
        country: "GB",
        countryCode: "GB",
      },
    });
  });

  it("omits the optional company fields when the contact does not carry them", () => {
    const contact = bvnkContactV3Fixture("contact_company_2", {
      type: "COMPANY",
      relationshipType: "THIRD_PARTY",
      legalName: "Acme Widgets Ltd",
    });

    assert.deepEqual(buildBvnkThirdPartyRuleEntity(contact, COUNTERPARTY_ID), {
      type: "COMPANY",
      relationshipType: "THIRD_PARTY",
      customerIdentifier: COUNTERPARTY_ID,
      legalName: "Acme Widgets Ltd",
    });
  });

  it("mirrors the contact address country into country and countryCode", () => {
    const contact = bvnkContactV3Fixture("contact_country_1", {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      firstName: "Gottfried",
      lastName: "Leibniz",
      address: {
        addressLine1: "1 Philosophiengasse",
        city: "Leipzig",
        postalCode: "04109",
        country: "DE",
      },
    });

    const entity = buildBvnkThirdPartyRuleEntity(contact, COUNTERPARTY_ID);

    assert.equal(entity.address?.country, "DE");
    assert.equal(entity.address?.countryCode, "DE");
  });
});

describe("BVNK wallet names", () => {
  it("builds the display-only on-ramp wallet name from the counterparty id and fiat currency", () => {
    assert.equal(buildBvnkOnrampWalletName("cpty_123", "USD"), "sdp:onramp:cpty_123:USD");
    assert.equal(buildBvnkOnrampWalletName("cpty_456", "EUR"), "sdp:onramp:cpty_456:EUR");
  });

  it("builds the display-only off-ramp wallet name from the counterparty id and fiat currency", () => {
    assert.equal(buildBvnkOfframpWalletName("cpty_123", "USD"), "sdp:offramp:cpty_123:USD");
    assert.equal(buildBvnkOfframpWalletName("cpty_456", "EUR"), "sdp:offramp:cpty_456:EUR");
  });
});

describe("buildBvnkWalletIdempotencyKey", () => {
  it("hashes the provider-account row id to a stable 36-character key", async () => {
    const providerAccountRowId =
      "counterparty_provider_account_123e4567-e89b-12d3-a456-426614174000";

    const key = await buildBvnkWalletIdempotencyKey(providerAccountRowId);

    assert.match(key, /^[a-f0-9]{36}$/);
    assert.equal(key.length, 36);
    assert.equal(await buildBvnkWalletIdempotencyKey(providerAccountRowId), key);
    assert.notEqual(await buildBvnkWalletIdempotencyKey(`${providerAccountRowId}:changed`), key);
  });
});
