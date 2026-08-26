import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Counterparty, CounterpartyProviderData } from "@sdp/types/counterparties";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { RampDiscoveryContext, ValidateCounterpartyOptions } from "../../types";
import { buildHercleSignature, HercleRampClient, parseCryptoRail } from "./client";
import {
  HERCLE_REGISTRATION_COUNTRY_FIELD_KEY,
  HERCLE_REGISTRATION_NUMBER_FIELD_KEY,
  hercleCounterpartyRequirements,
  hercleJurisdictionForCountry,
} from "./counterparty";
import {
  hercleOnboardingRequirements,
  mapHercleVerificationStatus,
  readHercleData,
} from "./provider-data";

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

function options(providerData: CounterpartyProviderData = {}): ValidateCounterpartyOptions {
  return { direction: "offramp", providerData };
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

  it("surfaces the stored verification lifecycle once an account exists", () => {
    const verificationRequired = hercleCounterpartyRequirements(
      businessCounterparty(),
      options({
        hercle: {
          accountId: "acct_1",
          verificationStatus: "verification_required",
          verificationUrl: "https://verify.example/x",
        },
      })
    );
    assert.equal(verificationRequired.status, "customer_verification_required");

    const ready = hercleCounterpartyRequirements(
      businessCounterparty(),
      options({ hercle: { accountId: "acct_1", verificationStatus: "ready" } })
    );
    assert.equal(ready.status, "ready");
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
    assert.throws(() => mapHercleVerificationStatus("SOMETHING_NEW"));
  });

  it("never invents a verification URL", () => {
    assert.throws(() =>
      hercleOnboardingRequirements(
        { accountId: "acct_1", verificationStatus: "verification_required" },
        "onramp"
      )
    );
  });

  it("reads provider data defensively", () => {
    assert.deepEqual(readHercleData({}), {});
    assert.deepEqual(readHercleData({ hercle: "garbage" }), {});
    const partial = readHercleData({
      hercle: { accountId: "acct_1", verificationStatus: "not-a-status" },
    });
    assert.equal(partial.accountId, "acct_1");
    assert.equal(partial.verificationStatus, undefined);
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
