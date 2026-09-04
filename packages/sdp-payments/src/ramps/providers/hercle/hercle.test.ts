import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty, CounterpartyProviderData } from "@sdp/types/counterparties";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { RampDiscoveryContext, ValidateCounterpartyOptions } from "../../types";
import { buildHercleSignature, HercleRampClient, parseCryptoRail } from "./client";
import {
  HERCLE_PAYOUT_ACCOUNT_HOLDER_FIELD_KEY,
  HERCLE_PAYOUT_BIC_FIELD_KEY,
  HERCLE_PAYOUT_IBAN_FIELD_KEY,
  HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
  HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
  hercleCounterpartyRequirements,
  hercleJurisdictionForCountry,
} from "./counterparty";
import { hercleOnboardingRequirements, mapHercleVerificationStatus } from "./provider-data";

function businessCounterparty(): Counterparty {
  return {
    id: "cpty_1",
    organizationId: "org_1",
    projectId: "proj_1",
    externalId: null,
    displayName: "Acme AG",
    status: "active",
    createdBy: null,
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
    entityType: "business",
  };
}

function options(
  providerData: CounterpartyProviderData = {},
  extra: { providerCustomerReference?: string } = {}
): ValidateCounterpartyOptions {
  return { direction: "offramp", providerData, ...extra };
}

describe("buildHercleSignature", () => {
  it("implements Signed Key v1: HMAC-SHA256 over ts + METHOD + pathWithQuery + rawBody", async () => {
    // Vector pinned against the Hercle partner spec (documentation-only secret).
    const signature = await buildHercleSignature(
      // biome-ignore lint/security/noSecrets: published documentation-only test vector secret
      "cvVdfH8pVpI3rWx1Gt4duZAxRq0Y2eaB7kNQ5mM1sT2",
      1756200000,
      "get",
      "/partner/v1/ping",
      ""
    );
    // biome-ignore lint/security/noSecrets: published documentation-only test vector signature
    assert.equal(signature, "iMXClpe2o7fK3tmryuWZYDrMArC9EeWU8K+lqqc06uQ=");
  });
});

describe("hercleJurisdictionForCountry", () => {
  it("maps CH to SWISS, EEA members to EU, and everything else to unsupported", () => {
    assert.equal(hercleJurisdictionForCountry("CH"), "SWISS");
    assert.equal(hercleJurisdictionForCountry("DE"), "EU");
    assert.equal(hercleJurisdictionForCountry("NO"), "EU");
    assert.equal(hercleJurisdictionForCountry("US"), undefined);
    assert.equal(hercleJurisdictionForCountry("GB"), undefined);
  });
});

describe("hercleCounterpartyRequirements", () => {
  it("refuses counterparties that are not businesses", () => {
    const individual = { ...businessCounterparty(), entityType: "individual" as const };
    assert.equal(hercleCounterpartyRequirements(individual, options()).status, "unsupported");
  });

  it("collects the KYB inputs before an account exists, since SDP stores no PII", () => {
    const requirements = hercleCounterpartyRequirements(businessCounterparty(), options());
    assert.equal(requirements.status, "collect");
    if (requirements.status !== "collect") {
      assert.fail("expected collect");
    }
    const keys = requirements.fields.map((field) => field.key);
    assert.ok(keys.includes(HERCLE_REGISTRATION_NUMBER_FIELD_KEY));
    assert.ok(keys.includes(HERCLE_REGISTRATION_COUNTRY_FIELD_KEY));
    // The payout account is collected with the registration data: fiat is first-party only, so it is
    // the business's own account and there is nothing to choose per order.
    assert.ok(keys.includes(HERCLE_PAYOUT_IBAN_FIELD_KEY));
    assert.ok(keys.includes(HERCLE_PAYOUT_BIC_FIELD_KEY));
    assert.ok(keys.includes(HERCLE_PAYOUT_ACCOUNT_HOLDER_FIELD_KEY));
    assert.ok(requirements.fields.every((field) => field.required));

    // The country field is the jurisdiction discriminator, so it must be a closed CH/EEA list.
    const country = requirements.fields.find(
      (field) => field.key === HERCLE_REGISTRATION_COUNTRY_FIELD_KEY
    );
    assert.equal(country?.kind, "select");
    if (country?.kind !== "select") {
      assert.fail("expected a select field");
    }
    const countryCodes = country.options.map((option) => option.value);
    assert.ok(countryCodes.includes("CH"));
    assert.ok(countryCodes.includes("DE"));
    assert.ok(!countryCodes.includes("US"));
  });

  it("defers to the handler once the customer link exists", () => {
    // Verification and payout state live in provider-account rows the API handler resolves; the
    // pure decision has nothing left to say beyond "collect" versus "linked".
    const linked = hercleCounterpartyRequirements(
      businessCounterparty(),
      options({}, { providerCustomerReference: "acct_1" })
    );
    assert.equal(linked.status, "ready");
  });
});

describe("hercleOnboardingRequirements", () => {
  it("surfaces the verification lifecycle with the link minted for this read", () => {
    const required = hercleOnboardingRequirements(
      { verificationStatus: "verification_required", payoutAccountStatus: "pending" },
      "offramp",
      "https://verify.example/x"
    );
    assert.deepEqual(required, {
      provider: "hercle",
      direction: "offramp",
      status: "customer_verification_required",
      verificationUrl: "https://verify.example/x",
    });
    assert.equal(
      hercleOnboardingRequirements({ verificationStatus: "verifying" }, "offramp").status,
      "customer_verifying"
    );
    assert.equal(
      hercleOnboardingRequirements({ verificationStatus: "verification_failed" }, "offramp").status,
      "customer_verification_failed"
    );
    assert.equal(
      hercleOnboardingRequirements(
        { verificationStatus: "ready", payoutAccountStatus: "active" },
        "offramp"
      ).status,
      "ready"
    );
  });

  it("is not ready while the bank rail is still registering the payout account", () => {
    // Hercle refuses off-ramp orders until the account is active, so the wizard must keep polling.
    assert.equal(
      hercleOnboardingRequirements(
        { verificationStatus: "ready", payoutAccountStatus: "pending" },
        "offramp"
      ).status,
      "funding_account_provisioning"
    );
    assert.equal(
      hercleOnboardingRequirements(
        { verificationStatus: "ready", payoutAccountStatus: "refused" },
        "offramp"
      ).status,
      "unsupported"
    );
  });

  it("never invents a verification URL", () => {
    assert.throws(() =>
      hercleOnboardingRequirements({ verificationStatus: "verification_required" }, "offramp")
    );
  });
});

describe("provider-data mapping", () => {
  it("normalizes the Hercle API status vocabulary and throws on unknown values", () => {
    assert.equal(mapHercleVerificationStatus("UNVERIFIED"), "verification_required");
    assert.equal(mapHercleVerificationStatus("action_required"), "verification_required");
    assert.equal(mapHercleVerificationStatus("pending"), "verifying");
    assert.equal(mapHercleVerificationStatus("rejected"), "verification_failed");
    assert.equal(mapHercleVerificationStatus("VERIFIED"), "ready");
    assert.equal(mapHercleVerificationStatus("approved"), "ready");
    assert.throws(() => mapHercleVerificationStatus("something-new"));
  });
});

describe("parseCryptoRail", () => {
  it("resolves the token symbols quotes send", () => {
    assert.equal(parseCryptoRail("SOL"), "sol.solana");
    assert.equal(parseCryptoRail("USDC"), "usdc.solana");
  });

  it("passes through the rail ids estimates send", () => {
    assert.equal(parseCryptoRail("sol.solana"), "sol.solana");
    assert.equal(parseCryptoRail("usdc.solana"), "usdc.solana");
  });

  it("tolerates casing and padding", () => {
    assert.equal(parseCryptoRail(" sol "), "sol.solana");
    assert.equal(parseCryptoRail("Usdc"), "usdc.solana");
    assert.equal(parseCryptoRail("USDC.SOLANA"), "usdc.solana");
  });

  it("rejects tokens outside the Solana rails", () => {
    assert.throws(() => parseCryptoRail("BTC"));
    assert.throws(() => parseCryptoRail("usdc.ethereum"));
    assert.throws(() => parseCryptoRail(""));
  });

  it("accepts every crypto the provider declares, addressed either way", async () => {
    // The bug this guards: the rail catalogue offered SOL while the quote path
    // rejected "SOL", so the pair was selectable and then unquotable.
    const { snapshot } = await new HercleRampClient().discoverCurrencyAndRails(
      {} as RampDiscoveryContext
    );

    for (const rail of [...snapshot.onramp.cryptos, ...snapshot.offramp.cryptos]) {
      assert.equal(parseCryptoRail(rail), rail);
      assert.equal(parseCryptoRail(getCryptoRailAssetLabel(rail)), rail);
    }
  });

  it("declares the EUR-only launch corridor", async () => {
    const { snapshot } = await new HercleRampClient().discoverCurrencyAndRails(
      {} as RampDiscoveryContext
    );

    assert.deepEqual(Object.keys(snapshot.onramp.currencies), ["EUR"]);
    assert.deepEqual(Object.keys(snapshot.offramp.currencies), ["EUR"]);
  });
});
