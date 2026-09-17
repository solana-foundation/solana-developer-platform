import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBvnkCustomerExternalReference,
  buildBvnkOfframpWalletName,
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkOnrampWalletName,
  buildBvnkWalletIdempotencyKey,
  bvnkUnverifiedOnboardingStatus,
  parseBvnkOfframpWalletName,
  parseBvnkOnrampPaymentRuleKey,
  parseBvnkOnrampWalletName,
} from "./provider-data";

const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

describe("bvnkUnverifiedOnboardingStatus", () => {
  it("maps PENDING (submitted, in review) to verifying", () => {
    assert.equal(bvnkUnverifiedOnboardingStatus("PENDING"), "verifying");
  });

  it("maps INFO_REQUIRED / ACTIONS_REQUIRED to verification_required", () => {
    assert.equal(bvnkUnverifiedOnboardingStatus("INFO_REQUIRED"), "verification_required");
    assert.equal(bvnkUnverifiedOnboardingStatus("ACTIONS_REQUIRED"), "verification_required");
  });

  it("maps the terminal REJECTED status to verification_failed", () => {
    assert.equal(bvnkUnverifiedOnboardingStatus("REJECTED"), "verification_failed");
  });

  it("maps the terminal TERMINATED status to verification_failed", () => {
    assert.equal(bvnkUnverifiedOnboardingStatus("TERMINATED"), "verification_failed");
  });

  it("is case-insensitive", () => {
    assert.equal(bvnkUnverifiedOnboardingStatus("pending"), "verifying");
  });

  it("throws on an unmapped status", () => {
    assert.throws(() => bvnkUnverifiedOnboardingStatus("WAT"));
  });

  it("throws on a missing status", () => {
    assert.throws(() => bvnkUnverifiedOnboardingStatus(undefined));
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
