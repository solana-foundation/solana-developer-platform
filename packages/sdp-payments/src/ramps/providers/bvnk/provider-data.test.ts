import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BVNK_ONRAMP_REMITTANCE_PREFIX,
  buildBvnkCustomerExternalReference,
  buildBvnkFundingWalletName,
  buildBvnkOfframpWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkCustomerStatusRequirements,
  bvnkOnrampRemittance,
  bvnkPayoutPartyDetailsFromCustomer,
  parseBvnkFundingWalletName,
  parseBvnkOfframpWalletName,
  parseBvnkTransferIdFromRemittance,
  parseBvnkWalletName,
  readBvnkOnrampTransferData,
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

describe("parseBvnkTransferIdFromRemittance", () => {
  it("reassembles the live v1 sample when the overflow carries its leading space", () => {
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", " d7-088e-4f73-bcc6-7d60c7b3ae44"),
      "xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44"
    );
  });

  it("reassembles the second live v1 sample", () => {
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_00889A", " 6d-a8f3-48fd-a9ac-040903652de3"),
      "xfr_00889a6d-a8f3-48fd-a9ac-040903652de3"
    );
  });

  it("reassembles the id when the overflow has no leading space", () => {
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", "d7-088e-4f73-bcc6-7d60c7b3ae44"),
      "xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44"
    );
  });

  it("returns null when no xfr_ id appears in the overflow or reference", () => {
    assert.equal(parseBvnkTransferIdFromRemittance("REFERENCE01", "no-transfer-id-here"), null);
    assert.equal(parseBvnkTransferIdFromRemittance("REFERENCE01", undefined), null);
  });

  it("matches mixed case and returns the lowercased id", () => {
    assert.equal(
      parseBvnkTransferIdFromRemittance("XFR_2AB355", "D7-088E-4F73-BCC6-7D60C7B3AE44"),
      "xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44"
    );
  });

  it("parses a non-splitting rail where the full id sits in the payment reference", () => {
    assert.equal(
      parseBvnkTransferIdFromRemittance("xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44", undefined),
      "xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44"
    );
  });

  it("throws when the joined remittance contains two distinct transfer ids", () => {
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

describe("bvnkOnrampRemittance", () => {
  it("formats the remittance as the 10-char prefix plus the transfer id", () => {
    assert.equal(BVNK_ONRAMP_REMITTANCE_PREFIX.length, 10);
    assert.equal(
      bvnkOnrampRemittance("xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44"),
      "SDP-ONRAMP xfr_2ab355d7-088e-4f73-bcc6-7d60c7b3ae44"
    );
  });
});

describe("readBvnkOnrampTransferData", () => {
  it("parses the empty initial state the prebook writes", () => {
    assert.deepEqual(readBvnkOnrampTransferData({ bvnk: {} }), {});
  });

  it("throws when the bvnk key is missing", () => {
    assert.throws(() => readBvnkOnrampTransferData({}), {
      message: /provider_data has no bvnk object/,
    });
  });

  it("throws on a malformed payout shape", () => {
    assert.throws(() => readBvnkOnrampTransferData({ bvnk: { payout: { claimedAt: 123 } } }), {
      message: /provider_data\.bvnk is malformed/,
    });
  });

  it("parses a fully written payout payload", () => {
    assert.deepEqual(
      readBvnkOnrampTransferData({
        bvnk: {
          payout: {
            claimedAt: "2026-09-18T10:00:00Z",
            attempts: 1,
            intent: {
              amount: "1.20",
              currency: "USD",
              cryptoCurrency: "USDC",
              network: "SOLANA",
              address: "H1grN1mr3sEQ2NLdeC1fXwvgaj7YiQYp8YBW21gJDWNZ",
            },
            payoutId: "01a0b3f2-ad2d-7a55-95dc-98d85d4def2f",
          },
        },
      }),
      {
        payout: {
          claimedAt: "2026-09-18T10:00:00Z",
          attempts: 1,
          intent: {
            amount: "1.20",
            currency: "USD",
            cryptoCurrency: "USDC",
            network: "SOLANA",
            address: "H1grN1mr3sEQ2NLdeC1fXwvgaj7YiQYp8YBW21gJDWNZ",
          },
          payoutId: "01a0b3f2-ad2d-7a55-95dc-98d85d4def2f",
        },
      }
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

    assert.deepEqual(bvnkPayoutPartyDetailsFromCustomer(customer), {
      type: "BENEFICIARY",
      entityType: "INDIVIDUAL",
      firstName: "Zach",
      lastName: "Khong",
      dateOfBirth: "2001-04-01",
      relationshipType: "THIRD_PARTY",
      countryCode: "US",
    });
  });

  it("throws naming the customer when no individual details are present", () => {
    const customer = bvnkCustomer({
      reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
      status: "VERIFIED",
    });

    assert.throws(() => bvnkPayoutPartyDetailsFromCustomer(customer), {
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
