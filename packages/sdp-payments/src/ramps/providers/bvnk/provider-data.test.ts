import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBvnkCustomerExternalReference,
  buildBvnkFundingWalletName,
  buildBvnkOfframpWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkCustomerStatusRequirements,
  bvnkRuleEntityFromCustomer,
  parseBvnkFundingWalletName,
  parseBvnkOfframpWalletName,
  parseBvnkWalletName,
} from "./provider-data";
import { bvnkCustomer } from "./test-fixtures";

describe("bvnkCustomerStatusRequirements", () => {
  it("answers ready for VERIFIED", () => {
    assert.deepEqual(bvnkCustomerStatusRequirements("VERIFIED", "onramp"), {
      provider: "bvnk",
      direction: "onramp",
      status: "ready",
    });
  });

  it("answers customer_verifying for PENDING", () => {
    assert.deepEqual(bvnkCustomerStatusRequirements("PENDING", "offramp"), {
      provider: "bvnk",
      direction: "offramp",
      status: "customer_verifying",
    });
  });

  it("answers customer_verification_required with the JIT URL for INFO_REQUIRED", () => {
    assert.deepEqual(
      bvnkCustomerStatusRequirements("INFO_REQUIRED", "onramp", "https://in.sumsub.com/websdk/p/t"),
      {
        provider: "bvnk",
        direction: "onramp",
        status: "customer_verification_required",
        verificationUrl: "https://in.sumsub.com/websdk/p/t",
      }
    );
  });

  it("answers customer_verification_required with the JIT URL for ACTIONS_REQUIRED", () => {
    assert.deepEqual(
      bvnkCustomerStatusRequirements(
        "ACTIONS_REQUIRED",
        "onramp",
        "https://in.sumsub.com/websdk/p/t"
      ),
      {
        provider: "bvnk",
        direction: "onramp",
        status: "customer_verification_required",
        verificationUrl: "https://in.sumsub.com/websdk/p/t",
      }
    );
  });

  it("throws when a verification-required status has no JIT URL", () => {
    assert.throws(() => bvnkCustomerStatusRequirements("INFO_REQUIRED", "onramp"), {
      message: /verification_required.*without a JIT verification URL/,
    });
  });

  it("answers customer_verification_failed for REJECTED", () => {
    assert.deepEqual(bvnkCustomerStatusRequirements("REJECTED", "onramp"), {
      provider: "bvnk",
      direction: "onramp",
      status: "customer_verification_failed",
    });
  });

  it("answers customer_verification_failed for TERMINATED", () => {
    assert.deepEqual(bvnkCustomerStatusRequirements("TERMINATED", "onramp"), {
      provider: "bvnk",
      direction: "onramp",
      status: "customer_verification_failed",
    });
  });
});

describe("bvnkRuleEntityFromCustomer", () => {
  const person = {
    firstName: "Jane",
    lastName: "Doe",
    dateOfBirth: "1984-06-30",
    address: {
      addressLine1: "1 Main Street",
      addressLine2: "Apt 4",
      city: "Austin",
      postalCode: "78701",
      stateCode: "TX",
      countryCode: "US",
    },
  };

  it("maps the person block onto BVNK's rule-entity address keys", () => {
    const customer = bvnkCustomer({
      reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      status: "VERIFIED",
      individual: { person },
    });

    assert.deepEqual(bvnkRuleEntityFromCustomer(customer), {
      type: "INDIVIDUAL",
      relationshipType: "SELF_OWNED",
      customerIdentifier: customer.reference,
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main Street",
        addressLine2: "Apt 4",
        city: "Austin",
        region: "TX",
        postCode: "78701",
        country: "US",
      },
    });
  });

  it("omits optional address keys the person block does not carry", () => {
    const customer = bvnkCustomer({
      reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      status: "VERIFIED",
      individual: {
        person: {
          firstName: "Jane",
          lastName: "Doe",
          dateOfBirth: "1984-06-30",
          address: {
            addressLine1: "1 Main Street",
            city: "Austin",
            countryCode: "US",
          },
        },
      },
    });

    const entity = bvnkRuleEntityFromCustomer(customer);
    if (entity.type !== "INDIVIDUAL") {
      throw new Error(`expected an individual entity, got ${entity.type}`);
    }
    assert.deepEqual(entity.address, {
      addressLine1: "1 Main Street",
      city: "Austin",
      country: "US",
    });
  });

  it("throws naming the customer when no individual details are present", () => {
    const customer = bvnkCustomer({
      reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      status: "VERIFIED",
    });

    assert.throws(() => bvnkRuleEntityFromCustomer(customer), {
      message: /BVNK customer 2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3 has no individual details/,
    });
  });
});

describe("buildBvnkCustomerExternalReference", () => {
  it("drops the cpty_ prefix to fit BVNK's 36-character externalReference", () => {
    assert.equal(
      buildBvnkCustomerExternalReference("cpty_123e4567-e89b-12d3-a456-426614174000"),
      "123e4567-e89b-12d3-a456-426614174000"
    );
  });

  it("rejects a malformed counterparty id", () => {
    assert.throws(() => buildBvnkCustomerExternalReference("cpty_123"), {
      message: /Malformed SDP counterparty id for BVNK externalReference/,
    });
  });

  it("rejects a retired-prefix counterparty id", () => {
    assert.throws(
      () => buildBvnkCustomerExternalReference("counterparty_123e4567-e89b-12d3-a456-426614174000"),
      { message: /Malformed SDP counterparty id for BVNK externalReference/ }
    );
  });
});

describe("parseBvnkOfframpWalletName", () => {
  it("round-trips an SDP off-ramp wallet name", () => {
    assert.deepEqual(parseBvnkOfframpWalletName(buildBvnkOfframpWalletName("USD", "cpty_123")), {
      namespace: "sdp",
      kind: "merchant_offramp",
      fiatCurrency: "USD",
      counterpartyId: "cpty_123",
    });
  });

  it("rejects malformed wallet names", () => {
    assert.throws(() => parseBvnkOfframpWalletName("sdp:onramp:USD:cpty_123"), {
      message: /Malformed BVNK off-ramp wallet name/,
    });
    assert.throws(() => parseBvnkOfframpWalletName("sdp:sideways:USD:cpty_123"), {
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

describe("parseBvnkFundingWalletName", () => {
  it("parses a customer funding wallet name into its provider-account id", () => {
    assert.equal(buildBvnkFundingWalletName("cpa_123"), "sdp:onramp:cpa_123");
    assert.deepEqual(parseBvnkFundingWalletName("sdp:onramp:cpa_123"), {
      namespace: "sdp",
      kind: "funding_wallet",
      providerAccountId: "cpa_123",
    });
    assert.deepEqual(parseBvnkWalletName("sdp:onramp:cpa_123"), {
      namespace: "sdp",
      kind: "funding_wallet",
      providerAccountId: "cpa_123",
    });
  });

  it("rejects wallet names that are not the 3-part funding shape", () => {
    assert.throws(() => parseBvnkFundingWalletName("sdp:onramp:cpa_123:extra"), {
      message: /Malformed BVNK funding wallet name/,
    });
  });

  it("rejects wallet names with the wrong direction segment", () => {
    assert.throws(() => parseBvnkFundingWalletName("sdp:sideways:cpa_123"), {
      message: /Malformed BVNK funding wallet name/,
    });
  });
});

describe("parseBvnkWalletName", () => {
  it("round-trips the merchant off-ramp wallet name", () => {
    assert.deepEqual(parseBvnkWalletName(buildBvnkOfframpWalletName("USD", "cpty_123")), {
      namespace: "sdp",
      kind: "merchant_offramp",
      fiatCurrency: "USD",
      counterpartyId: "cpty_123",
    });
  });

  it("reports the legacy 6-part on-ramp wallet name as unrecognised", () => {
    assert.deepEqual(parseBvnkWalletName("sdp:onramp:cpty_123:USD:USDC_SOLANA:dest"), {
      kind: "unrecognised",
      name: "sdp:onramp:cpty_123:USD:USDC_SOLANA:dest",
    });
  });

  it("reports other foreign wallet names as unrecognised", () => {
    assert.deepEqual(parseBvnkWalletName("sdp:sideways:USD:cpty_123"), {
      kind: "unrecognised",
      name: "sdp:sideways:USD:cpty_123",
    });
    assert.deepEqual(parseBvnkWalletName("a:foreign:wallet:1"), {
      kind: "unrecognised",
      name: "a:foreign:wallet:1",
    });
  });
});

describe("buildBvnkWalletIdempotencyKey", () => {
  it("hashes the BVNK wallet name to a stable 36-character key", async () => {
    const walletName = buildBvnkFundingWalletName("cpa_123");

    const key = await buildBvnkWalletIdempotencyKey(walletName);

    assert.match(key, /^[a-f0-9]{36}$/);
    assert.equal(key.length, 36);
    assert.equal(await buildBvnkWalletIdempotencyKey(walletName), key);
    assert.notEqual(await buildBvnkWalletIdempotencyKey(`${walletName}:changed`), key);
  });
});
