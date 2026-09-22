import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBvnkCustomerExternalReference,
  buildBvnkFundingWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkCustomerStatusRequirements,
  bvnkPayoutPartyDetailsFromCustomer,
  parseBvnkFundingWalletName,
  parseBvnkTransferIdFromRemittance,
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
    const verified = {
      provider: "bvnk",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://in.sumsub.com/websdk/p/t",
    };
    assert.deepEqual(
      bvnkCustomerStatusRequirements("INFO_REQUIRED", "onramp", "https://in.sumsub.com/websdk/p/t"),
      verified
    );
    // ACTIONS_REQUIRED carries the same JIT verification URL.
    assert.deepEqual(
      bvnkCustomerStatusRequirements(
        "ACTIONS_REQUIRED",
        "onramp",
        "https://in.sumsub.com/websdk/p/t"
      ),
      verified
    );
    // A verification-required status without a JIT URL is a caller bug.
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
    // TERMINATED is terminal for KYC in the same way.
    assert.deepEqual(bvnkCustomerStatusRequirements("TERMINATED", "onramp"), {
      provider: "bvnk",
      direction: "onramp",
      status: "customer_verification_failed",
    });
  });
});

describe("parseBvnkTransferIdFromRemittance", () => {
  it("reassembles the live v1 sample when the overflow carries its leading space", () => {
    const expected = "xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44";
    // Live v1 sample: the split rail writes the tail into the overflow with a leading space.
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", " d7-088e-4f73-bcc6-7d60c7b3ae44"),
      expected
    );
    // The overflow without a leading space joins the same way.
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", "d7-088e-4f73-bcc6-7d60c7b3ae44"),
      expected
    );
    // Mixed case matches and the id is normalized to lowercase.
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", "D7-088E-4F73-BCC6-7D60C7B3AE44"),
      expected
    );
    // Non-splitting rail: the full id already sits in the payment reference.
    assert.equal(parseBvnkTransferIdFromRemittance(expected, undefined), expected);
    // No id in the overflow or reference: null.
    assert.equal(parseBvnkTransferIdFromRemittance("REFERENCE01", "no-transfer-id-here"), null);
    assert.equal(parseBvnkTransferIdFromRemittance("REFERENCE01", undefined), null);
    // Two distinct ids in the joined remittance are ambiguous.
    assert.throws(
      () =>
        parseBvnkTransferIdFromRemittance(
          "XFR_2AB355",
          "d7-088e-4f73-bcc6-7d60c7b3ae44 xfr_00889a6d-a8f3-48fd-a9ac-040903652de3"
        ),
      { message: /Ambiguous BVNK remittance/ }
    );
  });
});

describe("bvnkPayoutPartyDetailsFromCustomer", () => {
  const person = {
    firstName: "Zach",
    lastName: "Khong",
    dateOfBirth: "2001-04-01",
    address: {
      addressLine1: "1 Main Street",
      city: "Austin",
      postalCode: "78701",
      stateCode: "TX",
      countryCode: "US",
    },
  };

  it("maps the probe person block onto the accepted partyDetails shape", () => {
    const customer = bvnkCustomer({
      reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      status: "VERIFIED",
      individual: { person },
    });

    assert.deepEqual(bvnkPayoutPartyDetailsFromCustomer(customer, "BENEFICIARY"), {
      type: "BENEFICIARY",
      entityType: "INDIVIDUAL",
      firstName: "Zach",
      lastName: "Khong",
      dateOfBirth: "2001-04-01",
      relationshipType: "THIRD_PARTY",
      countryCode: "US",
    });
    assert.deepEqual(bvnkPayoutPartyDetailsFromCustomer(customer, "ORIGINATOR"), {
      type: "ORIGINATOR",
      entityType: "INDIVIDUAL",
      firstName: "Zach",
      lastName: "Khong",
      dateOfBirth: "2001-04-01",
      relationshipType: "THIRD_PARTY",
      countryCode: "US",
    });

    // Missing individual details name the customer in the throw.
    const withoutDetails = bvnkCustomer({
      reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      status: "VERIFIED",
    });
    assert.throws(() => bvnkPayoutPartyDetailsFromCustomer(withoutDetails, "BENEFICIARY"), {
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

describe("parseBvnkFundingWalletName", () => {
  it("parses a customer funding wallet name into its provider-account id", () => {
    assert.equal(buildBvnkFundingWalletName("cpa_123"), "sdp:onramp:cpa_123");
    const parsed = {
      namespace: "sdp",
      kind: "funding_wallet",
      providerAccountId: "cpa_123",
    };
    assert.deepEqual(parseBvnkFundingWalletName("sdp:onramp:cpa_123"), parsed);
    assert.deepEqual(parseBvnkWalletName("sdp:onramp:cpa_123"), parsed);

    // The 3-part funding shape is the only accepted one.
    assert.throws(() => parseBvnkFundingWalletName("sdp:onramp:cpa_123:extra"), {
      message: /Malformed BVNK funding wallet name/,
    });
    assert.throws(() => parseBvnkFundingWalletName("sdp:sideways:cpa_123"), {
      message: /Malformed BVNK funding wallet name/,
    });

    // Other names never parse as funding wallets, including the retired
    // merchant off-ramp shape: unrecognised.
    assert.deepEqual(parseBvnkWalletName("sdp:sideways:USD:cpty_123"), {
      kind: "unrecognised",
      name: "sdp:sideways:USD:cpty_123",
    });
    assert.deepEqual(parseBvnkWalletName("sdp:offramp:USD:cpty_123"), {
      kind: "unrecognised",
      name: "sdp:offramp:USD:cpty_123",
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
    assert.equal(await buildBvnkWalletIdempotencyKey(walletName), key);
    assert.notEqual(await buildBvnkWalletIdempotencyKey(`${walletName}:changed`), key);
  });
});
