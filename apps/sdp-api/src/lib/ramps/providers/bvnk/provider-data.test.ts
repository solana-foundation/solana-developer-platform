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
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { describe, expect, it } from "vitest";

const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

describe("bvnkUnverifiedOnboardingStatus", () => {
  it("maps PENDING (submitted, in review) to verifying", () => {
    expect(bvnkUnverifiedOnboardingStatus("PENDING")).toBe("verifying");
  });

  it("maps INFO_REQUIRED / ACTIONS_REQUIRED to verification_required", () => {
    expect(bvnkUnverifiedOnboardingStatus("INFO_REQUIRED")).toBe("verification_required");
    expect(bvnkUnverifiedOnboardingStatus("ACTIONS_REQUIRED")).toBe("verification_required");
  });

  it("maps the terminal REJECTED status to verification_failed", () => {
    expect(bvnkUnverifiedOnboardingStatus("REJECTED")).toBe("verification_failed");
  });

  it("maps the terminal TERMINATED status to verification_failed", () => {
    expect(bvnkUnverifiedOnboardingStatus("TERMINATED")).toBe("verification_failed");
  });

  it("is case-insensitive", () => {
    expect(bvnkUnverifiedOnboardingStatus("pending")).toBe("verifying");
  });

  it("throws on an unmapped status", () => {
    expect(() => bvnkUnverifiedOnboardingStatus("WAT")).toThrow();
  });

  it("throws on a missing status", () => {
    expect(() => bvnkUnverifiedOnboardingStatus(undefined)).toThrow();
  });
});

describe("buildBvnkCustomerExternalReference", () => {
  it("builds a compact cp_ externalReference from an SDP counterparty id", () => {
    expect(buildBvnkCustomerExternalReference("cpty_123e4567-e89b-12d3-a456-426614174000")).toBe(
      "cp_123e4567e89b12d3a456426614174000"
    );
  });

  it("rejects a malformed counterparty id", () => {
    expect(() => buildBvnkCustomerExternalReference("cpty_123")).toThrow(
      "Malformed SDP counterparty id for BVNK externalReference"
    );
  });

  it("rejects a retired-prefix counterparty id", () => {
    expect(() =>
      buildBvnkCustomerExternalReference("counterparty_123e4567-e89b-12d3-a456-426614174000")
    ).toThrow("Malformed SDP counterparty id for BVNK externalReference");
  });
});

describe("parseBvnkOfframpWalletName", () => {
  it("round-trips an SDP off-ramp wallet name", () => {
    expect(parseBvnkOfframpWalletName(buildBvnkOfframpWalletName("USD", "cpty_123"))).toEqual({
      namespace: "sdp",
      direction: "offramp",
      fiatCurrency: "USD",
      counterpartyId: "cpty_123",
    });
  });

  it("rejects malformed wallet names", () => {
    expect(() => parseBvnkOfframpWalletName("sdp:onramp:USD:cpty_123")).toThrow(
      "Malformed BVNK off-ramp wallet name"
    );
    expect(() => parseBvnkOfframpWalletName("sdp:offramp:NOTFIAT:cpty_123")).toThrow(
      "Malformed BVNK off-ramp wallet name"
    );
    expect(() => parseBvnkOfframpWalletName("sdp:offramp:USD:cpty_123:extra")).toThrow(
      "Malformed BVNK off-ramp wallet name"
    );
  });
});

describe("parseBvnkOnrampWalletName", () => {
  it("round-trips an SDP on-ramp wallet name", () => {
    const walletName = buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY);

    expect(walletName).toBe("sdp:onramp:cpty_123:USD:USDC_SOLANA:dest");
    expect(parseBvnkOnrampWalletName(walletName)).toEqual({
      namespace: "sdp",
      direction: "onramp",
      counterpartyId: "cpty_123",
      onrampKey: ONRAMP_KEY,
    });
  });

  it("rejects wallet names with malformed payment rule keys", () => {
    expect(() => parseBvnkOnrampWalletName("sdp:onramp:cpty_123:USD:USDC_NOPE:dest")).toThrow(
      "Malformed BVNK on-ramp wallet name"
    );
  });
});

describe("buildBvnkWalletIdempotencyKey", () => {
  it("hashes the BVNK wallet name to a stable 36-character key", async () => {
    const walletName = buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY);

    const key = await buildBvnkWalletIdempotencyKey(walletName);

    expect(key).toMatch(/^[a-f0-9]{36}$/);
    expect(key).toHaveLength(36);
    expect(await buildBvnkWalletIdempotencyKey(walletName)).toBe(key);
    expect(await buildBvnkWalletIdempotencyKey(`${walletName}:changed`)).not.toBe(key);
  });
});

describe("BVNK on-ramp payment rule key", () => {
  it("builds and parses the payment rule key", () => {
    const key = buildBvnkOnrampPaymentRuleKey("USD", "USDC", "SOLANA", "dest");

    expect(key).toBe(ONRAMP_KEY);
    expect(parseBvnkOnrampPaymentRuleKey(key)).toEqual({
      fiatCurrency: "USD",
      cryptoCurrency: "USDC",
      cryptoNetwork: "SOLANA",
      destinationWalletAddress: "dest",
    });
  });

  it("rejects non-Solana crypto networks", () => {
    expect(() => parseBvnkOnrampPaymentRuleKey("USD:BCH_BITCOIN_CASH:dest")).toThrow(
      "Malformed BVNK on-ramp payment rule key"
    );
  });

  it("rejects malformed payment rule keys", () => {
    expect(() => parseBvnkOnrampPaymentRuleKey("USD:USDC_SOLANA")).toThrow(
      "Malformed BVNK on-ramp payment rule key"
    );
    expect(() => parseBvnkOnrampPaymentRuleKey("USD:USDC_NOT_A_NETWORK:dest")).toThrow(
      "Malformed BVNK on-ramp payment rule key"
    );
    expect(() => parseBvnkOnrampPaymentRuleKey("NOPE:USDC_SOLANA:dest")).toThrow(
      "Malformed BVNK on-ramp payment rule key"
    );
  });
});
