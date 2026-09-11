import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IMPLICIT_DEFAULT_ALLOW_POLICY } from "./evaluate";
import { apiKeyPolicy, walletPolicy } from "./test-support";
import {
  collectVelocityRules,
  createVelocityLookup,
  serializeVelocityObservationKey,
  velocityObservationKeys,
} from "./velocity";

describe("velocityObservationKeys", () => {
  it("yields one key per asset with the default wallet scope and sorted operation types", () => {
    assert.deepEqual(
      velocityObservationKeys({
        kind: "velocity",
        window: "P1D",
        max: "10",
        asset: "USDC",
        assets: ["USDG", "USDC"],
        operationTypes: ["earn_vault_withdrawal", "earn_vault_deposit", "earn_vault_deposit"],
      }),
      [
        {
          scope: "wallet",
          window: "P1D",
          asset: "USDC",
          operationTypes: ["earn_vault_deposit", "earn_vault_withdrawal"],
        },
        {
          scope: "wallet",
          window: "P1D",
          asset: "USDG",
          operationTypes: ["earn_vault_deposit", "earn_vault_withdrawal"],
        },
      ]
    );
  });

  it("treats an empty operation type filter as every type", () => {
    assert.deepEqual(
      velocityObservationKeys({ kind: "velocity", window: "P1D", max: "10", asset: "USDC" }),
      [{ scope: "wallet", window: "P1D", asset: "USDC", operationTypes: null }]
    );
  });

  it("yields nothing for a rule naming no asset", () => {
    assert.deepEqual(velocityObservationKeys({ kind: "velocity", window: "P1D", max: "10" }), []);
  });
});

describe("createVelocityLookup", () => {
  it("answers by key regardless of operation type ordering", () => {
    const lookup = createVelocityLookup([
      {
        scope: "organization",
        window: "P1D",
        asset: "USDC",
        operationTypes: ["earn_vault_deposit", "earn_vault_withdrawal"],
        total: "5",
      },
    ]);
    assert.equal(
      lookup.lookup({
        scope: "organization",
        window: "P1D",
        asset: "USDC",
        operationTypes: ["earn_vault_withdrawal", "earn_vault_deposit"],
      })?.total,
      "5"
    );
    assert.equal(
      lookup.lookup({ scope: "organization", window: "P1D", asset: "USDC", operationTypes: null }),
      null
    );
    assert.equal(
      lookup.lookup({ scope: "wallet", window: "P1D", asset: "USDC", operationTypes: null }),
      null
    );
  });

  it("serializes equal keys identically", () => {
    assert.equal(
      serializeVelocityObservationKey({
        scope: "api_key",
        window: "PT1H",
        asset: "USDC",
        operationTypes: null,
      }),
      "api_key|PT1H|USDC|*"
    );
  });
});

describe("collectVelocityRules", () => {
  it("gathers velocity rules from both scopes' active revisions in order", () => {
    const rules = collectVelocityRules({
      walletPolicy: walletPolicy([
        { kind: "always" },
        { id: "w", kind: "velocity", window: "P1D", max: "1", asset: "USDC" },
      ]),
      apiKeyPolicy: apiKeyPolicy([
        { id: "k", kind: "velocity", window: "PT1H", max: "2", asset: "USDC" },
      ]),
    });
    assert.deepEqual(
      rules.map((rule) => rule.id),
      ["w", "k"]
    );
  });

  it("returns nothing for implicit-allow scopes", () => {
    assert.deepEqual(
      collectVelocityRules({ walletPolicy: IMPLICIT_DEFAULT_ALLOW_POLICY, apiKeyPolicy: null }),
      []
    );
  });
});
