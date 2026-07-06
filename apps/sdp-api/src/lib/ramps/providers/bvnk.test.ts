import { describe, expect, it } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { AppError } from "@/lib/errors";
import {
  BvnkRampClient,
  buildBvnkCustomerExternalReference,
  buildBvnkOfframpWalletName,
  buildBvnkOnrampPaymentRuleKey,
  buildBvnkOnrampWalletName,
  buildBvnkRuleEntity,
  buildBvnkWalletIdempotencyKey,
  bvnkOnrampStatusFromProviderData,
  bvnkUnverifiedOnboardingStatus,
  parseBvnkOfframpWalletName,
  parseBvnkOnrampPaymentRuleKey,
  parseBvnkOnrampWalletName,
} from "./bvnk";

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

describe("BvnkRampClient.parseBvnkWebhookEvent", () => {
  it("parses BVNK wallet create webhooks with walletName", () => {
    const client = new BvnkRampClient();

    expect(
      client.parseBvnkWebhookEvent({
        event: "bvnk:ledger:wallet:create",
        data: {
          id: "wallet_1",
          status: "COMPLETED",
          walletName: buildBvnkOnrampWalletName("counterparty_123", ONRAMP_KEY),
          customerReference: "customer_1",
          ledgers: [{ type: "FIAT", accountNumber: "900368997705", code: "101019644" }],
        },
      })
    ).toMatchObject({
      kind: "bvnk:ledger:wallet:create",
      customerReference: "customer_1",
      walletId: "wallet_1",
      walletName: "sdp:onramp:counterparty_123:USD:USDC_SOLANA:dest",
      walletStatus: "COMPLETED",
      bankAccount: { accountNumber: "900368997705" },
    });
  });

  it("parses a BVNK fiat pay-in status-change webhook", () => {
    const client = new BvnkRampClient();

    expect(
      client.parseBvnkWebhookEvent({
        event: "bvnk:payment:payin:status-change",
        data: {
          status: "COMPLETED",
          customerReference: "customer_1",
          amount: { value: 100, currencyCode: "USD" },
          beneficiary: { walletId: "a:1:wallet:1" },
        },
      })
    ).toMatchObject({
      kind: "bvnk:payment:payin:status-change",
      customerReference: "customer_1",
      walletId: "a:1:wallet:1",
      status: "COMPLETED",
      amount: "100",
    });
  });

  it("ignores an unhandled BVNK event instead of throwing", () => {
    const client = new BvnkRampClient();

    expect(
      client.parseBvnkWebhookEvent({
        event: "bvnk:totally:new-event",
        data: {},
      })
    ).toEqual({ kind: "ignore", event: "bvnk:totally:new-event" });
  });
});

describe("buildBvnkCustomerExternalReference", () => {
  it("builds a compact cp_ externalReference from an SDP counterparty id", () => {
    expect(
      buildBvnkCustomerExternalReference("counterparty_123e4567-e89b-12d3-a456-426614174000")
    ).toBe("cp_123e4567e89b12d3a456426614174000");
  });

  it("rejects a malformed counterparty id", () => {
    expect(() => buildBvnkCustomerExternalReference("counterparty_123")).toThrow(
      "Malformed SDP counterparty id for BVNK externalReference"
    );
  });
});

describe("parseBvnkOfframpWalletName", () => {
  it("round-trips an SDP off-ramp wallet name", () => {
    expect(
      parseBvnkOfframpWalletName(buildBvnkOfframpWalletName("USD", "counterparty_123"))
    ).toEqual({
      namespace: "sdp",
      direction: "offramp",
      fiatCurrency: "USD",
      counterpartyId: "counterparty_123",
    });
  });

  it("rejects malformed wallet names", () => {
    expect(() => parseBvnkOfframpWalletName("sdp:onramp:USD:counterparty_123")).toThrow(
      "Malformed BVNK off-ramp wallet name"
    );
    expect(() => parseBvnkOfframpWalletName("sdp:offramp:NOTFIAT:counterparty_123")).toThrow(
      "Malformed BVNK off-ramp wallet name"
    );
    expect(() => parseBvnkOfframpWalletName("sdp:offramp:USD:counterparty_123:extra")).toThrow(
      "Malformed BVNK off-ramp wallet name"
    );
  });
});

describe("parseBvnkOnrampWalletName", () => {
  it("round-trips an SDP on-ramp wallet name", () => {
    const walletName = buildBvnkOnrampWalletName("counterparty_123", ONRAMP_KEY);

    expect(walletName).toBe("sdp:onramp:counterparty_123:USD:USDC_SOLANA:dest");
    expect(parseBvnkOnrampWalletName(walletName)).toEqual({
      namespace: "sdp",
      direction: "onramp",
      counterpartyId: "counterparty_123",
      onrampKey: ONRAMP_KEY,
    });
  });

  it("rejects wallet names with malformed payment rule keys", () => {
    expect(() =>
      parseBvnkOnrampWalletName("sdp:onramp:counterparty_123:USD:USDC_NOPE:dest")
    ).toThrow("Malformed BVNK on-ramp wallet name");
  });
});

describe("buildBvnkWalletIdempotencyKey", () => {
  it("hashes the BVNK wallet name to a stable 36-character key", async () => {
    const walletName = buildBvnkOnrampWalletName("counterparty_123", ONRAMP_KEY);

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

  it("parses crypto networks that contain underscores", () => {
    expect(parseBvnkOnrampPaymentRuleKey("USD:BCH_BITCOIN_CASH:dest")).toEqual({
      fiatCurrency: "USD",
      cryptoCurrency: "BCH",
      cryptoNetwork: "BITCOIN_CASH",
      destinationWalletAddress: "dest",
    });
  });

  it("rejects malformed payment rule keys", () => {
    expect(() => parseBvnkOnrampPaymentRuleKey("USD:USDC_SOLANA")).toThrow(
      "Malformed BVNK on-ramp payment rule key"
    );
    expect(() => parseBvnkOnrampPaymentRuleKey("USD:USDC_NOT_A_NETWORK:dest")).toThrow(
      "Malformed BVNK on-ramp payment rule key"
    );
    expect(() => buildBvnkOnrampPaymentRuleKey("NOPE", "USDC", "SOLANA", "dest")).toThrow(
      "Malformed BVNK on-ramp payment rule key input"
    );
  });
});

function counterpartyRow(overrides?: Partial<CounterpartyRow>): CounterpartyRow {
  return {
    id: "cp_123",
    organization_id: "org_123",
    project_id: "proj_123",
    external_id: null,
    entity_type: "individual",
    display_name: "Ada Lovelace",
    email: "ada@example.com",
    identity: {
      firstName: "Ada",
      lastName: "Lovelace",
      address: {
        line1: "1 Market St",
        city: "San Francisco",
        countryCode: "US",
        subdivisionCode: "US-TX",
      },
    },
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildBvnkRuleEntity", () => {
  it("normalizes an ISO-prefixed stored subdivision code to BVNK's bare stateCode", () => {
    const entity = buildBvnkRuleEntity(counterpartyRow());

    expect(entity.address?.stateCode).toBe("TX");
  });

  it("throws for a non-US subdivision that does not resolve to 2 characters", () => {
    const row = counterpartyRow({
      identity: {
        firstName: "Ada",
        lastName: "Lovelace",
        address: {
          line1: "1 High St",
          city: "London",
          countryCode: "GB",
          subdivisionCode: "GB-ENG",
        },
      },
    });

    expect(() => buildBvnkRuleEntity(row)).toThrowError(AppError);
  });
});
