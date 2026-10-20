import assert from "node:assert/strict";
import { test } from "vitest";
import type { FireblocksPolicyRule } from "./fireblocks-policy";
import { evaluateFireblocksTransferPolicy } from "./fireblocks-policy-match";

const transfer = {
  initiatorId: "api-user",
  vaultId: "0",
  assetId: "SOL",
  amount: "0.01",
  destination: null,
};
function rule(overrides: FireblocksPolicyRule = {}): FireblocksPolicyRule {
  return {
    id: "rule",
    name: "Treasury SOL",
    type: "TRANSFER",
    policyEngineVersion: "v2",
    initiator: { operator: "INCLUDES", users: ["api-user"] },
    source: { operator: "INCLUDES", ids: [{ type: "VAULT", id: "0" }] },
    destination: { operator: "INCLUDES", addressType: "ONE_TIME", type: ["ONE_TIME_ADDRESS"] },
    asset: { nftTransfer: false, assetTypes: ["SOL"] },
    amount: { currency: "USD", range: { min: "0" } },
    verdict: { action: "2-TIER" },
    ...overrides,
  };
}
test("first matching block wins over a later allowing rule", () => {
  assert.equal(
    evaluateFireblocksTransferPolicy([rule({ verdict: { action: "BLOCK" } }), rule()], transfer)
      .state,
    "blocked"
  );
});
test("binds the API user, source vault, exact asset and whitelisted destination", () => {
  for (const selection of [{ initiatorId: "other" }, { vaultId: "2" }, { assetId: "USDC_SOL" }])
    assert.equal(
      evaluateFireblocksTransferPolicy([rule()], { ...transfer, ...selection }).state,
      "missing"
    );
  const whitelisted = rule({
    destination: { operator: "INCLUDES", addressType: "WHITELISTED", type: ["UNMANAGED"] },
  });
  assert.equal(evaluateFireblocksTransferPolicy([whitelisted], transfer).state, "missing");
  assert.equal(
    evaluateFireblocksTransferPolicy([whitelisted], {
      ...transfer,
      destination: {
        walletId: "w",
        walletType: "EXTERNAL_WALLET",
        name: "Payee",
        address: "x",
        assetId: "SOL",
        status: "APPROVED",
        activationTime: null,
      },
    }).state,
    "covered"
  );
});
test("does not guess fiat prices, quota consumption, ambiguous selectors or unsupported conditions", () => {
  for (const change of [
    { amount: { currency: "USD", range: { min: "0", max: "100" } } },
    { amountOverTime: { period: "DAY" } },
    { source: { operator: "INCLUDES", type: ["VAULT"], ids: [{ type: "VAULT", id: "other" }] } },
    { source: { operator: "INCLUDES", tags: [{ id: "tag" }] } },
    { initiator: { operator: "INCLUDES", groups: ["group"] } },
    { subType: "RAW" },
    { programCall: {} },
    { isGlobalPolicy: true },
  ])
    assert.equal(
      evaluateFireblocksTransferPolicy([rule(change), rule()], transfer).state,
      "unknown"
    );
});
test("irrelevant unsupported rules do not mask a later match; native amounts compare exactly", () => {
  assert.equal(
    evaluateFireblocksTransferPolicy(
      [
        rule({
          source: { operator: "INCLUDES", ids: [{ type: "VAULT", id: "other" }] },
          amountOverTime: {},
        }),
        rule(),
      ],
      transfer
    ).state,
    "covered"
  );
  const bounded = rule({
    amount: { currency: "NATIVE", range: { min: "0.000000001", max: "9007199254740993" } },
  });
  assert.equal(evaluateFireblocksTransferPolicy([bounded], transfer).state, "covered");
  assert.equal(
    evaluateFireblocksTransferPolicy([bounded], {
      ...transfer,
      amount: "9007199254740993.000000001",
    }).state,
    "missing"
  );
});
test("inconsistent precedence and unknown rule types require review", () => {
  assert.equal(
    evaluateFireblocksTransferPolicy([rule({ index: 2 }), rule({ index: 1 })], transfer).state,
    "unknown"
  );
  assert.equal(
    evaluateFireblocksTransferPolicy([rule({ type: undefined }), rule()], transfer).state,
    "unknown"
  );
});

test("out-of-range native amounts remain unknown instead of widening a policy", () => {
  const bounded = rule({
    amount: { currency: "NATIVE", range: { min: "0", max: "9".repeat(90) } },
  });
  assert.equal(evaluateFireblocksTransferPolicy([bounded, rule()], transfer).state, "unknown");
});
