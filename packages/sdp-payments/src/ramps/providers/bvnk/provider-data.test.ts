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
  readBvnkOfframpTransferData,
} from "./provider-data";
import { bvnkCustomer, bvnkVerifiedIndividualCustomer } from "./test-fixtures";

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
    assert.deepEqual(
      bvnkCustomerStatusRequirements(
        "ACTIONS_REQUIRED",
        "onramp",
        "https://in.sumsub.com/websdk/p/t"
      ),
      verified
    );
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
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", " d7-088e-4f73-bcc6-7d60c7b3ae44"),
      expected
    );
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", "d7-088e-4f73-bcc6-7d60c7b3ae44"),
      expected
    );
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", "D7-088E-4F73-BCC6-7D60C7B3AE44"),
      expected
    );
    assert.equal(parseBvnkTransferIdFromRemittance(expected, undefined), expected);
    assert.equal(parseBvnkTransferIdFromRemittance("REFERENCE01", "no-transfer-id-here"), null);
    assert.equal(parseBvnkTransferIdFromRemittance("REFERENCE01", undefined), null);
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
  it("maps the probe person block onto the accepted partyDetails shape", () => {
    const customer = bvnkVerifiedIndividualCustomer({});

    assert.deepEqual(bvnkPayoutPartyDetailsFromCustomer(customer, "BENEFICIARY"), {
      type: "BENEFICIARY",
      entityType: "INDIVIDUAL",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      relationshipType: "THIRD_PARTY",
      countryCode: "US",
    });
    assert.deepEqual(bvnkPayoutPartyDetailsFromCustomer(customer, "ORIGINATOR"), {
      type: "ORIGINATOR",
      entityType: "INDIVIDUAL",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1815-12-10",
      relationshipType: "THIRD_PARTY",
      countryCode: "US",
    });
    const withoutDetails = bvnkCustomer({
      reference: "00000000-0000-4000-8000-00000000c058",
      status: "VERIFIED",
    });
    assert.throws(() => bvnkPayoutPartyDetailsFromCustomer(withoutDetails, "BENEFICIARY"), {
      message: /BVNK customer 00000000-0000-4000-8000-00000000c058 has no individual details/,
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

    assert.throws(() => parseBvnkFundingWalletName("sdp:onramp:cpa_123:extra"), {
      message: /Malformed BVNK funding wallet name/,
    });
    assert.throws(() => parseBvnkFundingWalletName("sdp:sideways:cpa_123"), {
      message: /Malformed BVNK funding wallet name/,
    });

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
describe("readBvnkOfframpTransferData", () => {
  it("parses a recorded channel payload", () => {
    const providerData = {
      bvnk: {
        channel: {
          id: "01000000-0000-7000-8000-00000000c002",
          walletId: "a:funding:wallet:1",
          customerReference: "00000000-0000-4000-8000-00000000c058",
        },
      },
    };
    assert.deepEqual(readBvnkOfframpTransferData(providerData), {
      channel: {
        id: "01000000-0000-7000-8000-00000000c002",
        walletId: "a:funding:wallet:1",
        customerReference: "00000000-0000-4000-8000-00000000c058",
      },
    });
  });

  it("parses a prebook payload with no channel yet", () => {
    assert.deepEqual(readBvnkOfframpTransferData({ bvnk: {} }), {});
  });

  it("throws INTERNAL_ERROR when the bvnk key is missing", () => {
    assert.throws(() => readBvnkOfframpTransferData({}), {
      message: /BVNK off-ramp transfer provider_data has no bvnk object/,
    });
  });

  it("throws INTERNAL_ERROR on an unknown key inside bvnk", () => {
    assert.throws(
      () => readBvnkOfframpTransferData({ bvnk: { channel: { id: "c1" }, stray: true } }),
      { message: /BVNK off-ramp transfer provider_data\.bvnk is malformed/ }
    );
    assert.throws(
      () =>
        readBvnkOfframpTransferData({
          bvnk: {
            channel: { id: "c1", walletId: "w1", customerReference: "x1", stray: true },
          },
        }),
      { message: /BVNK off-ramp transfer provider_data\.bvnk is malformed/ }
    );
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
