import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty, CounterpartyProviderData } from "@sdp/types/counterparties";
import type { RampDiscoveryContext, ValidateCounterpartyOptions } from "../../types";
import { buildHercleSignature, HercleRampClient } from "./client";
import {
  HERCLE_PRIVACY_CONSENT_FIELD_KEY,
  HERCLE_PRIVACY_POLICY_URL,
  HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
  HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
  HERCLE_TERMS_CONSENT_FIELD_KEY,
  HERCLE_TERMS_URL,
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
  return { direction: "onramp", providerData, ...extra };
}

describe("buildHercleSignature", () => {
  it("implements Signed Key v1: HMAC-SHA256 over ts + METHOD + pathWithQuery + rawBody", async () => {
    // Vector pinned against the Hercle partner spec (documentation-only secret).
    const signature = await buildHercleSignature(
      "cvVdfH8pVpI3rWx1Gt4duZAxRq0Y2eaB7kNQ5mM1sT2",
      1756200000,
      "get",
      "/partner/v1/ping",
      ""
    );
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
    // No bank details: Hercle offers no off-ramp, so there is no payout destination to collect.
    assert.ok(!keys.some((key) => key.toLowerCase().includes("payout")));
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

  it("collects the acceptance of Hercle's terms and privacy policy with the KYB inputs", () => {
    // Hercle opens no account for a business that has not accepted both (TS-KYC-01 D14), so the
    // collect step carries them as required consents linking the documents being accepted.
    const requirements = hercleCounterpartyRequirements(businessCounterparty(), options());
    if (requirements.status !== "collect") {
      assert.fail("expected collect");
    }
    const consents = requirements.fields.filter((field) => field.kind === "consent");
    assert.deepEqual(
      consents.map((field) => [
        field.key,
        field.required,
        field.kind === "consent" ? field.documentUrl : null,
      ]),
      [
        [HERCLE_TERMS_CONSENT_FIELD_KEY, true, HERCLE_TERMS_URL],
        [HERCLE_PRIVACY_CONSENT_FIELD_KEY, true, HERCLE_PRIVACY_POLICY_URL],
      ]
    );
    assert.equal(HERCLE_TERMS_URL, "https://hercle.com/terms/");
    assert.equal(HERCLE_PRIVACY_POLICY_URL, "https://hercle.com/privacy/");
  });

  it("defers to the handler once the customer link exists", () => {
    // Verification state lives in the provider-account row the API handler resolves; the
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
      { verificationStatus: "verification_required" },
      "onramp",
      "https://verify.example/x"
    );
    assert.deepEqual(required, {
      provider: "hercle",
      direction: "onramp",
      status: "customer_verification_required",
      verificationUrl: "https://verify.example/x",
    });
    assert.equal(
      hercleOnboardingRequirements({ verificationStatus: "verifying" }, "onramp").status,
      "customer_verifying"
    );
    assert.equal(
      hercleOnboardingRequirements({ verificationStatus: "verification_failed" }, "onramp").status,
      "customer_verification_failed"
    );
    // Verification is the whole lifecycle: there is no payout account to wait for on an on-ramp-only rail.
    assert.equal(
      hercleOnboardingRequirements({ verificationStatus: "ready" }, "onramp").status,
      "ready"
    );
  });

  it("never invents a verification URL", () => {
    assert.throws(() =>
      hercleOnboardingRequirements({ verificationStatus: "verification_required" }, "onramp")
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

describe("rail catalogue", () => {
  it("declares the EUR-only, on-ramp-only launch corridor", async () => {
    const { snapshot } = await new HercleRampClient().discoverCurrencyAndRails(
      {} as RampDiscoveryContext
    );

    assert.deepEqual(Object.keys(snapshot.onramp.currencies), ["EUR"]);
    // Mural's shape: an empty off-ramp side keeps the pair out of the catalogue altogether.
    assert.deepEqual(snapshot.offramp, { currencies: {}, cryptos: [] });
  });
});
