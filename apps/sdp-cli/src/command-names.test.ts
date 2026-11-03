import assert from "node:assert/strict";
import test from "node:test";
import { commands } from "./commands";
import { operationById } from "./contract";
import { runCli } from "./run";

test("command names cannot shadow a longer command and silently select another operation", () => {
  for (const command of commands) {
    assert(command.words.every((word) => /^[a-z][a-z0-9-]*$/.test(word)));
    for (const other of commands) {
      if (command === other) continue;
      assert(
        !command.words.every((word, index) => other.words[index] === word),
        `${command.words.join(" ")} shadows ${other.words.join(" ")}`
      );
    }
  }
});

test("names distinguish unsigned builds, provider execution, signed submission and recorded resources", () => {
  const expectations = [
    ["createPaymentTransfer", "transfers execute", "POST", "/v1/payments/transfers/execute"],
    [
      "createPaymentTransferBatch",
      "transfer-batches execute",
      "POST",
      "/v1/payments/transfer-batches/execute",
    ],
    ["createPaymentOnrampQuote", "onramps start", "POST", "/v1/payments/ramps/onramp/start"],
    ["createPaymentOfframpQuote", "offramps start", "POST", "/v1/payments/ramps/offramp/start"],
    ["createEarnVaultDeposit", "earn deposits execute", "POST", "/v1/earn/deposits/execute"],
    [
      "createEarnExternalWalletDepositTransaction",
      "earn deposits build-unsigned-transaction",
      "POST",
      "/v1/earn/deposits/build-unsigned-transaction",
    ],
    [
      "createEarnExternalWalletDeposit",
      "earn deposits submit-signed-transaction",
      "POST",
      "/v1/earn/deposits/submit-signed-transaction",
    ],
    [
      "retargetEarnProgram",
      "earn portfolio-accounts allocation update",
      "PUT",
      "/v1/earn/portfolio-accounts/{programId}/allocation",
    ],
    [
      "listEarnVaultPositions",
      "earn positions provider-signed list",
      "GET",
      "/v1/earn/positions/provider-signed",
    ],
    [
      "listEarnExternalWalletPositions",
      "earn positions caller-signed list",
      "GET",
      "/v1/earn/positions/caller-signed",
    ],
    [
      "executeMint",
      "issuance tokens mint execute",
      "POST",
      "/v1/issuance/tokens/{tokenId}/mint/execute",
    ],
    [
      "prepareMint",
      "issuance tokens mint build-unsigned-transaction",
      "POST",
      "/v1/issuance/tokens/{tokenId}/mint/build-unsigned-transaction",
    ],
    [
      "confirmDeploy",
      "issuance tokens deploy confirm-submitted-transaction",
      "POST",
      "/v1/issuance/tokens/{tokenId}/deploy/confirm-submitted-transaction",
    ],
    [
      "createTokenWithAssetProfile",
      "issuance tokens create-with-asset-profile",
      "POST",
      "/v1/issuance/tokens/create-with-asset-profile",
    ],
    [
      "createPaymentSubscriptionPlan",
      "subscription-plans create-record",
      "POST",
      "/v1/payments/subscription-plans",
    ],
    [
      "preparePaymentSubscriptionPlanCreate",
      "subscription-plans create build-unsigned-transaction",
      "POST",
      "/v1/payments/subscription-plans/{planId}/create/build-unsigned-transaction",
    ],
    [
      "preparePaymentLinkTransaction",
      "payment-links transactions build-sponsored-transaction",
      "POST",
      "/pay/{publicToken}/tx",
    ],
    [
      "createHeliusRingsOperation",
      "helius-rings operations execute",
      "POST",
      "/v1/helius-rings/operations/execute",
    ],
    [
      "executeHeliusRingsOperation",
      "helius-rings operations resume-execution",
      "POST",
      "/v1/helius-rings/operations/{operationId}/resume-execution",
    ],
    [
      "completeCustodySetupConnection",
      "custody connections complete-installation",
      "POST",
      "/internal/dashboard/custody/connections/{connectionId}/complete-installation",
    ],
    [
      "getCounterpartyRequirements",
      "counterparties ramp-requirements get",
      "GET",
      "/v1/counterparties/{counterpartyId}/ramp-requirements",
    ],
    [
      "submitCounterpartyRequirements",
      "counterparties ramp-requirements check",
      "POST",
      "/v1/counterparties/{counterpartyId}/ramp-requirements/check",
    ],
    ["receiveClerkWebhook", "webhooks clerk deliver", "POST", "/webhooks/clerk"],
  ] as const;
  for (const [id, name, method, path] of expectations) {
    const command = commands.find((entry) => entry.operationId === id);
    assert(command, id);
    assert.equal(command.words.join(" "), name);
    const operation = operationById(id);
    assert.equal(operation.method, method);
    assert.equal(operation.path, path);
  }
});

test("former execution names never dispatch a different money operation", async () => {
  for (const args of [
    ["transfers", "create"],
    ["onramps", "quote"],
    ["offramps", "quote"],
    ["issuance", "tokens", "prepare-mint", "tok_example"],
    ["issuance", "tokens", "mint", "tok_example"],
    ["earn", "vault-deposits", "create"],
    ["earn", "external-wallet", "deposits", "submit"],
    ["helius-rings", "operations", "create"],
    ["helius-rings", "operations", "execute", "hop_example"],
    ["subscription-plans", "create"],
  ]) {
    let requests = 0;
    const code = await runCli(args, {
      env: { SDP_TOKEN: "fixture-session", SDP_PROJECT_ID: "prj_example" },
      fetcher: async () => {
        requests += 1;
        throw new Error("A former name must not send a request");
      },
      readStdin: async () => "",
      stdout: () => {},
      stderr: () => {},
    });
    assert([0, 2].includes(code), args.join(" "));
    assert.equal(requests, 0, args.join(" "));
  }
});
