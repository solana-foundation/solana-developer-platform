import { describe, expect, it } from "vitest";
import { bvnkOnrampStatusFromProviderData, bvnkUnverifiedOnboardingStatus } from "./bvnk";

const ONRAMP_PARAMS = {
  cryptoToken: "USDC_SOLANA",
  fiatCurrency: "USD",
  destinationWalletAddress: "dest",
};
const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

function providerData(
  customer?: Record<string, unknown>,
  wallets?: Record<string, unknown>
): Record<string, unknown> {
  return { bvnk: { ...(customer ? { customer } : {}), ...(wallets ? { wallets } : {}) } };
}

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

describe("bvnkOnrampStatusFromProviderData", () => {
  it("returns onboarding_not_started without a customer", () => {
    expect(bvnkOnrampStatusFromProviderData(providerData(), ONRAMP_PARAMS)).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "onboarding_not_started",
    });
  });

  it("returns customer_verifying for a PENDING customer even with a stale cached verificationUrl", () => {
    const result = bvnkOnrampStatusFromProviderData(
      providerData({
        customerReference: "cust_1",
        status: "PENDING",
        verificationUrl: "https://in.sumsub.com/x",
      }),
      ONRAMP_PARAMS
    );
    expect(result.status).toBe("customer_verifying");
  });

  it("returns customer_verification_required with the URL for INFO_REQUIRED", () => {
    const result = bvnkOnrampStatusFromProviderData(
      providerData({
        customerReference: "cust_1",
        status: "INFO_REQUIRED",
        verificationUrl: "https://in.sumsub.com/x",
      }),
      ONRAMP_PARAMS
    );
    expect(result).toEqual({
      provider: "bvnk",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://in.sumsub.com/x",
    });
  });

  it("returns customer_verification_failed for a REJECTED customer instead of throwing", () => {
    const result = bvnkOnrampStatusFromProviderData(
      providerData({
        customerReference: "cust_1",
        status: "REJECTED",
        verificationUrl: "https://in.sumsub.com/x",
      }),
      ONRAMP_PARAMS
    );
    expect(result.status).toBe("customer_verification_failed");
  });

  it("returns ready when a verified customer has a rule and bank account", () => {
    const result = bvnkOnrampStatusFromProviderData(
      providerData(
        { customerReference: "cust_1", status: "VERIFIED" },
        {
          [ONRAMP_KEY]: { ruleId: "rule_1", bankAccount: { accountNumber: "123" } },
        }
      ),
      ONRAMP_PARAMS
    );
    expect(result.status).toBe("ready");
  });

  it("returns funding_account_provisioning for a verified customer mid-provision", () => {
    const result = bvnkOnrampStatusFromProviderData(
      providerData({ customerReference: "cust_1", status: "VERIFIED" }, { [ONRAMP_KEY]: {} }),
      ONRAMP_PARAMS
    );
    expect(result.status).toBe("funding_account_provisioning");
  });
});
