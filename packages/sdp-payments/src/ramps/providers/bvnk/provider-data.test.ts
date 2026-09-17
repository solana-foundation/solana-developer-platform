import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBvnkThirdPartyRuleEntity } from "./counterparty";
import {
  buildBvnkOfframpWalletName,
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkOnrampWalletName,
  buildBvnkWalletIdempotencyKey,
  parseBvnkOfframpWalletName,
  parseBvnkOnrampPaymentRuleKey,
  parseBvnkOnrampWalletName,
} from "./provider-data";
import type { BvnkContactV3 } from "./schemas";

const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

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

describe("parseBvnkOfframpWalletName", () => {
  it("round-trips an SDP off-ramp wallet name", () => {
    assert.deepEqual(parseBvnkOfframpWalletName(buildBvnkOfframpWalletName("USD", "cpty_123")), {
      namespace: "sdp",
      direction: "offramp",
      fiatCurrency: "USD",
      counterpartyId: "cpty_123",
    });
  });

  it("rejects malformed wallet names", () => {
    assert.throws(() => parseBvnkOfframpWalletName("sdp:onramp:USD:cpty_123"), {
      message: /Malformed BVNK off-ramp wallet name/,
    });
    assert.throws(() => parseBvnkOfframpWalletName("sdp:offramp:NOTFIAT:cpty_123"), {
      message: /Malformed BVNK off-ramp wallet name/,
    });
    assert.throws(() => parseBvnkOfframpWalletName("sdp:offramp:USD:cpty_123:extra"), {
      message: /Malformed BVNK off-ramp wallet name/,
    });
  });
});

describe("parseBvnkOnrampWalletName", () => {
  it("round-trips an SDP on-ramp wallet name", () => {
    const walletName = buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY);

    assert.equal(walletName, "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest");
    assert.deepEqual(parseBvnkOnrampWalletName(walletName), {
      namespace: "sdp",
      direction: "onramp",
      counterpartyId: "cpty_123",
      onrampKey: ONRAMP_KEY,
    });
  });

  it("rejects wallet names with malformed payment rule keys", () => {
    assert.throws(() => parseBvnkOnrampWalletName("sdp:onramp:cpty_123:USD:USDC_NOPE:dest"), {
      message: /Malformed BVNK on-ramp wallet name/,
    });
  });
});

describe("buildBvnkWalletIdempotencyKey", () => {
  it("hashes the BVNK wallet name to a stable 36-character key", async () => {
    const walletName = buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY);

    const key = await buildBvnkWalletIdempotencyKey(walletName);

    assert.match(key, /^[a-f0-9]{36}$/);
    assert.equal(key.length, 36);
    assert.equal(await buildBvnkWalletIdempotencyKey(walletName), key);
    assert.notEqual(await buildBvnkWalletIdempotencyKey(`${walletName}:changed`), key);
  });
});

describe("BVNK on-ramp payment rule key", () => {
  it("builds and parses the payment rule key", () => {
    const key = buildBvnkOnrampPaymentRuleKey("USD", "USDC", "SOLANA", "dest");

    assert.equal(key, ONRAMP_KEY);
    assert.deepEqual(parseBvnkOnrampPaymentRuleKey(key), {
      fiatCurrency: "USD",
      cryptoCurrency: "USDC",
      cryptoNetwork: "SOLANA",
      destinationWalletAddress: "dest",
    });
  });

  it("rejects non-Solana crypto networks", () => {
    assert.throws(() => parseBvnkOnrampPaymentRuleKey("USD:BCH_BITCOIN_CASH:dest"), {
      message: /Malformed BVNK on-ramp payment rule key/,
    });
  });

  it("rejects malformed payment rule keys", () => {
    assert.throws(() => parseBvnkOnrampPaymentRuleKey("USD:USDC_SOLANA"), {
      message: /Malformed BVNK on-ramp payment rule key/,
    });
    assert.throws(() => parseBvnkOnrampPaymentRuleKey("USD:USDC_NOT_A_NETWORK:dest"), {
      message: /Malformed BVNK on-ramp payment rule key/,
    });
    assert.throws(() => parseBvnkOnrampPaymentRuleKey("NOPE:USDC_SOLANA:dest"), {
      message: /Malformed BVNK on-ramp payment rule key/,
    });
  });
});
