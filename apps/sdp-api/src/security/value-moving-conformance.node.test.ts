import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

type ValueMovingFamily =
  | "batch"
  | "recurring"
  | "issuance"
  | "payments"
  | "ramps"
  | "custody"
  | "earn";

interface OrderedBoundary {
  file: string;
  section: string;
  before: string;
  after: string;
}

interface ReplayEvidence {
  mode:
    | "idempotency_fingerprint"
    | "claimed_state_machine"
    | "provider_signature_window"
    | "fresh_blockhash_per_attempt";
  file: string;
  evidence: string;
}

interface ValueMovingContract {
  family: ValueMovingFamily;
  trustedContext: { file: string; evidence: string };
  authorization: OrderedBoundary;
  replay: ReplayEvidence[];
}

const contracts: ValueMovingContract[] = [
  {
    family: "batch",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/handlers/transfer-batches/create.ts",
      evidence: "resolved.scope.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/index.ts",
      section: '"/transfer-batches",',
      before: "extract: extractTransferBatchPolicyCandidate",
      after: "createTransferBatch",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments/transfer-batches.test.ts",
        evidence: "replays the original transfer batch for the same idempotency key and payload",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments/transfer-batches.test.ts",
        evidence: "returns the original batch when a concurrent insert loses the idempotency race",
      },
    ],
  },
  {
    family: "recurring",
    trustedContext: {
      file: "apps/sdp-api/src/services/payments/recurring-payments/shared.ts",
      evidence: "createProjectSponsorshipFeePayment(input.env",
    },
    authorization: {
      file: "apps/sdp-api/src/services/payments/recurring-payments/collection.ts",
      section: "export async function collectRecurringPayment",
      before: "await enforceRecurringPaymentPolicy({",
      after: "solanaServices.createOrgSigner(",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/payments.recurring.test.ts",
        evidence:
          "recovers stale authorized recurring payments without re-confirming old signatures",
      },
      {
        mode: "fresh_blockhash_per_attempt",
        file: "apps/sdp-api/src/routes/payments.recurring.test.ts",
        evidence: "journals failed on-chain activation attempts and retries with a fresh signature",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/authority.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/authority",',
      before: "policyGate({ extract: extractUpdateAuthorityPolicyCandidate })",
      after: "executeUpdateAuthority",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "without poisoning the idempotency slot",
      },
    ],
  },
  {
    family: "payments",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/context.ts",
      evidence: "createRequestSponsorshipFeePayment(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/index.ts",
      section: '"/transfers",',
      before: "extract: extractTransferPolicyCandidate",
      after: "createTransfer",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments.transfers.test.ts",
        evidence: "replays a transfer when the same Idempotency-Key + body is retried",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments.transfers.test.ts",
        evidence: "rejects the same Idempotency-Key with a different body",
      },
    ],
  },
  {
    family: "ramps",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/handlers/ramps.ts",
      evidence: "scope.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/index.ts",
      section: '"/ramps/onramp/quote",',
      before: "policyGate({ extract: extractOnrampQuotePolicyCandidate })",
      after: "createOnrampQuote",
    },
    replay: [
      {
        mode: "provider_signature_window",
        file: "apps/sdp-api/src/routes/webhooks/ramps/stripe.test.ts",
        evidence: "accepts a correctly signed webhook and rejects a forged one",
      },
      {
        mode: "provider_signature_window",
        file: "apps/sdp-api/src/routes/webhooks/ramps/stripe.test.ts",
        evidence: "rejects a correctly signed but stale webhook",
      },
    ],
  },
  {
    family: "custody",
    trustedContext: {
      file: "apps/sdp-api/src/routes/private-channels/transfer-access.ts",
      evidence: "const scope = { organizationId: auth.organizationId, projectId }",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/private-channels/transfer-access.ts",
      section: "export async function resolveTransferCreateContext",
      before: "if (!verifiedSource)",
      after: "signer = await createOrgSigner(",
    },
    replay: [
      {
        mode: "fresh_blockhash_per_attempt",
        file: "apps/sdp-api/src/services/private-channels/transfer.node.test.ts",
        evidence: "fetches the blockhash and sends within one gateway unit",
      },
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/services/private-channels/transfer.node.test.ts",
        evidence: "allows a later retry",
      },
    ],
  },
  {
    /**
     * Non-custodial Earn vault deposits. Registered late — the route shipped
     * ungoverned, and the inventory below could not see it because
     * `apps/sdp-api/src/services/earn` was not a scanned root, so this test
     * passed while a value-moving path had no policy gate at all.
     */
    family: "earn",
    trustedContext: {
      file: "apps/sdp-api/src/routes/earn/handlers/vault.ts",
      evidence: "const wallets = await new CustodyRuntimeTargets",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/earn/index.ts",
      section: '"/vault-deposits",',
      before: "extract: extractEarnVaultDepositPolicyCandidate",
      after: "createEarnVaultDeposit",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/services/earn/vault-deposit.service.test.ts",
        evidence: "replays the original vault deposit for the same requestId and payload",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/services/earn/vault-deposit.service.test.ts",
        evidence: "rejects the same requestId with a different payload",
      },
    ],
  },
];

const signingSinkInventory: Record<string, string[]> = {
  "apps/sdp-api/src/routes/custody/handlers/signer-check.ts": ["signAndSend"],
  "apps/sdp-api/src/services/earn/vault-execution.service.ts": [
    // Sponsored signing adds the fee-payer signature without broadcasting, so
    // the final signature can still be recorded before bytes reach the network.
    "signAsFeePayer",
    // Wallet-paid signing likewise returns fully signed bytes without sending.
    "signTransactionMessageWithSigners",
  ],
  "apps/sdp-api/src/routes/pay.ts": ["signAsFeePayer"],
  "apps/sdp-api/src/routes/payments/handlers/transfer-batches/execute.ts": ["signAndSend"],
  "apps/sdp-api/src/routes/payments/handlers/transfers.ts": [
    "signAndSend",
    "signAndSend",
    "signAndSend",
  ],
  "apps/sdp-api/src/services/payments/recurring-payments/shared.ts": ["signAndSend"],
  "apps/sdp-api/src/services/private-channels/deposit.ts": ["signTransactionMessageWithSigners"],
  "apps/sdp-api/src/services/private-channels/transfer.ts": ["signTransactionMessageWithSigners"],
  "apps/sdp-api/src/services/private-channels/withdraw.ts": ["signTransactionMessageWithSigners"],
  "packages/sdp-issuance/src/mosaic/service.ts": [
    "signAndSend",
    "signTransactionMessageWithSigners",
  ],
  "packages/sdp-solana/src/token-2022.ts": ["signAndSend", "signTransactionMessageWithSigners"],
};

const valueMovingSourceRoots = [
  "apps/sdp-api/src/routes",
  "apps/sdp-api/src/services/payments",
  "apps/sdp-api/src/services/private-channels",
  // Earn's vault-direct path signs and broadcasts from a custody wallet. It was
  // missing here, which is why the inventory below did not notice a whole
  // money-moving surface — the omission the `earn` contract above now pins.
  "apps/sdp-api/src/services/earn",
  "packages/sdp-issuance/src",
  "packages/sdp-solana/src",
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".spec.ts")
    ) {
      return [];
    }
    return [entryPath];
  });
}

function discoverSigningSinks(): Record<string, string[]> {
  const sinkPattern = /\.(signAndSend|signAsFeePayer)\(|\b(signTransactionMessageWithSigners)\(/g;
  const inventory: Record<string, string[]> = {};

  for (const root of valueMovingSourceRoots) {
    for (const file of sourceFiles(path.join(repositoryRoot, root))) {
      const sinks = [...readFileSync(file, "utf8").matchAll(sinkPattern)].map(
        (match) => match[1] ?? match[2]
      );
      if (sinks.length > 0) {
        inventory[path.relative(repositoryRoot, file)] = sinks;
      }
    }
  }

  return inventory;
}

function sectionSource(boundary: OrderedBoundary): string {
  const source = readSource(boundary.file);
  const start = source.indexOf(boundary.section);
  expect(start, `${boundary.file} must retain section ${boundary.section}`).toBeGreaterThanOrEqual(
    0
  );
  return source.slice(start);
}

describe("value-moving authorization and replay conformance", () => {
  it("covers every required value-moving family", () => {
    expect(contracts.map((contract) => contract.family).sort()).toEqual([
      "batch",
      "custody",
      "earn",
      "issuance",
      "payments",
      "ramps",
      "recurring",
    ]);
  });

  it.each(contracts)("authorizes $family from trusted context before signing", (contract) => {
    expect(readSource(contract.trustedContext.file)).toContain(contract.trustedContext.evidence);

    const source = sectionSource(contract.authorization);
    const authorizationIndex = source.indexOf(contract.authorization.before);
    const signerIndex = source.indexOf(contract.authorization.after);
    expect(authorizationIndex, `${contract.family} authorization marker`).toBeGreaterThanOrEqual(0);
    expect(signerIndex, `${contract.family} signing marker`).toBeGreaterThanOrEqual(0);
    expect(authorizationIndex).toBeLessThan(signerIndex);
  });

  it.each(contracts)("keeps explicit replay evidence for $family", (contract) => {
    expect(contract.replay.length).toBeGreaterThan(0);
    for (const replay of contract.replay) {
      expect(readSource(replay.file), `${contract.family}: ${replay.mode}`).toContain(
        replay.evidence
      );
    }
  });

  it("enforces policy inside the gate before the handler runs", () => {
    const gateSource = readSource("apps/sdp-api/src/middleware/policy-gate.ts");
    const start = gateSource.indexOf("export function policyGate");
    expect(start, "policy gate middleware must exist").toBeGreaterThanOrEqual(0);
    const source = gateSource.slice(start);
    const orderedMarkers = [
      "isDryRunRequest(c)",
      "findIdempotentKeyReplay",
      "candidate === null",
      "await enforceWalletOperationPolicy(",
      "return next()",
    ];
    let cursor = 0;
    for (const marker of orderedMarkers) {
      const index = source.indexOf(marker, cursor);
      expect(index, `policy gate must retain ${marker} in order`).toBeGreaterThanOrEqual(cursor);
      cursor = index + marker.length;
    }
  });

  it("catalogs every production signing sink", () => {
    expect(discoverSigningSinks()).toEqual(signingSinkInventory);
  });

  it("keeps durable nonce lifetimes disabled", () => {
    const productionSource = valueMovingSourceRoots
      .flatMap((root) => sourceFiles(path.join(repositoryRoot, root)))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(productionSource).not.toMatch(
      /durable.?nonce|nonce.?account|advance.?nonce|setTransactionMessageLifetimeUsingDurableNonce/i
    );
  });
});
