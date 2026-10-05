import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");

/** The declared requirement: every family here needs at least one contract. */
const REQUIRED_FAMILIES = [
  "batch",
  "recurring",
  "issuance",
  "payments",
  "ramps",
  "custody",
  "earn",
  "dvp",
] as const;

type ValueMovingFamily = (typeof REQUIRED_FAMILIES)[number];

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
      file: "apps/sdp-api/src/routes/payments/transfer-batches/create.ts",
      evidence: "resolved.scope.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/transfer-batches/index.ts",
      section: 'transferBatches.post(\n  "/",',
      before: "extract: extractTransferBatchPolicyCandidate",
      after: "\n  createTransferBatch\n",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments/transfer-batches/handlers.test.ts",
        evidence: "replays the original transfer batch for the same idempotency key and payload",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments/transfer-batches/handlers.test.ts",
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
      after: "solanaServices.createOrgSignerForCustodyWallet(",
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
      before: "extract: extractUpdateAuthorityPolicyCandidate",
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
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/freeze.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/freeze",',
      before: "policyGate({ extract: extractFreezePolicyCandidate })",
      after: "freezeAccount",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence:
          "replays freeze from its persisted account without live target or authority lookup",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/freeze.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/unfreeze",',
      before: "policyGate({ extract: extractUnfreezePolicyCandidate })",
      after: "unfreezeAccount",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays unfreeze from its persisted account",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/pause.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/pause",',
      before: "policyGate({ extract: extractPausePolicyCandidate })",
      after: "  pauseToken",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays %s only for the original exact wallet",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/pause.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/unpause",',
      before: "policyGate({ extract: extractUnpausePolicyCandidate })",
      after: "unpauseToken",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays %s only for the original exact wallet",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/seize.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/seize",',
      before: "policyGate({ extract: extractSeizePolicyCandidate })",
      after: "executeSeize",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays seize without resolving the current permanent delegate",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/force-burn.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/force-burn",',
      before: "policyGate({ extract: extractForceBurnPolicyCandidate })",
      after: "executeForceBurn",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays force-burn without resolving the current permanent delegate",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/burn.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/burn",',
      before: "policyGate({ extract: extractBurnPolicyCandidate })",
      after: "executeBurn",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays burn before runtime checks and rejects a different exact wallet",
      },
    ],
  },
  {
    /** Mint: value creation, gated like its burn/unfreeze siblings. */
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/mint.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/mint",',
      before: "extract: extractMintPolicyCandidate",
      after: "executeMint",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "returns an idempotent mint replay before fresh admission or policy writes",
      },
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "stops a denied mint before signer and issuance side effects",
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
      file: "apps/sdp-api/src/routes/payments/transfers/index.ts",
      section: "transfers.post(",
      before: "extract: extractTransferPolicyCandidate",
      after: "\n  createTransfer\n",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments.transfers.idempotency.test.ts",
        evidence: "replays a transfer when the same Idempotency-Key + body is retried",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/payments.transfers.idempotency.test.ts",
        evidence: "rejects the same Idempotency-Key with a different body",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/tokens.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId",',
      before: "policyGate({ extract: extractTokenUpdatePolicyCandidate })",
      after: "  updateToken",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "rejects metadata updates while token deployment is in progress",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/deploy.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/deploy",',
      before: "policyGate({ extract: extractDeployPolicyCandidate })",
      after: "  deployToken",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "replays a completed direct deploy by its exact wallet without deploying again",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/allowlist.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/allowlist",',
      before: "policyGate({ extract: extractAllowlistAddPolicyCandidate })",
      after: "addAllowlistEntry",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "refuses to re-add an address already on the control list",
      },
    ],
  },
  {
    family: "issuance",
    trustedContext: {
      file: "apps/sdp-api/src/routes/issuance/handlers/allowlist.ts",
      evidence: "const { auth, projectId, orgId } = requireProjectScope(c)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/issuance/index.ts",
      section: '"/tokens/:tokenId/allowlist/:entryId",',
      before: "policyGate({ extract: extractAllowlistRemovePolicyCandidate })",
      after: "removeAllowlistEntry",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/issuance.test.ts",
        evidence: "acknowledges removing an already revoked allowlist entry without signing",
      },
    ],
  },
  {
    family: "ramps",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/ramps/onramp/handlers.ts",
      evidence: "scope.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/ramps/onramp/index.ts",
      section: '"/quote",',
      before: "policyGate({ extract: extractOnrampQuotePolicyCandidate })",
      after: "\n  createOnrampQuote\n",
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
    /** Offramp quotes are gated like onramp quotes; payouts settle through the shared webhook pipeline. */
    family: "ramps",
    trustedContext: {
      file: "apps/sdp-api/src/routes/payments/ramps/offramp/handlers.ts",
      evidence: "organizationId: scope.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/payments/ramps/offramp/index.ts",
      section: '"/quote",',
      before: "policyGate({ extract: extractOfframpQuotePolicyCandidate })",
      after: "\n  createOfframpQuote\n",
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
    /** DvP settle: wallet policy decides before the settlement authority signs. */
    family: "dvp",
    trustedContext: {
      file: "apps/sdp-api/src/routes/dvp/action-context.ts",
      evidence: "const settlement = await readDvpSettlementWallet(c.env, {",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/dvp/index.ts",
      section: '"/trades/:tradeId/settle",',
      before: "policyGate({ extract: extractDvpSettlePolicyCandidate })",
      after: "settleTrade",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/services/dvp/settle.test.ts",
        evidence: "refuses to settle a trade that is already closed",
      },
      {
        mode: "fresh_blockhash_per_attempt",
        file: "apps/sdp-api/src/services/dvp/settle.test.ts",
        evidence: "fetches a fresh blockhash for every attempt",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/services/dvp/leg-action-idempotency.test.ts",
        evidence: "answers a retry with the signature the first close sent, without closing again",
      },
    ],
  },
  {
    /** DvP fund: wallet policy decides before a custody wallet's tokens leave. */
    family: "dvp",
    trustedContext: {
      file: "apps/sdp-api/src/routes/dvp/action-context.ts",
      evidence: "const auth = getAuth(c);",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/dvp/index.ts",
      section: '"/trades/:tradeId/fund",',
      before: "policyGate({ extract: extractDvpFundPolicyCandidate })",
      after: "fundTrade",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/services/dvp/leg-action-idempotency.test.ts",
        evidence: "answers a retry with the same key from the first result, without running again",
      },
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/services/dvp/fund.test.ts",
        evidence: "tops a partly funded leg up by the shortfall, not the full target",
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
      file: "apps/sdp-api/src/routes/private-channels/handlers/transfers.ts",
      section: "export async function createPrivateChannelTransfer",
      before: "const context = await resolveTransferCreateContext(",
      after: "const signer = await createPrivateChannelSigner(",
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
  {
    /**
     * The exit half (PRO-1702). Registered WITH the route rather than after
     * it, so this money-moving surface is born governed — the deposit above is
     * the cautionary tale.
     */
    family: "earn",
    trustedContext: {
      file: "apps/sdp-api/src/routes/earn/handlers/vault.ts",
      evidence: "const wallet = resolveEarnVaultCustodyWallet(wallets, position.custodyWalletId)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/earn/index.ts",
      section: '"/vault-withdrawals",',
      before: "extract: extractEarnVaultWithdrawalPolicyCandidate",
      after: "createEarnVaultWithdrawal",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/services/earn/vault-withdraw.service.test.ts",
        evidence: "replays the original vault withdrawal for the same requestId and payload",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/services/earn/vault-withdraw.service.test.ts",
        evidence: "rejects the same requestId with a different payload",
      },
    ],
  },
  {
    /**
     * The queued exit half: a withdrawal REQUEST escrows shares (or hands a
     * par redemption to the provider's operator) before any settlement, so
     * the gate runs where value is first committed, not where it leaves.
     */
    family: "earn",
    trustedContext: {
      file: "apps/sdp-api/src/routes/earn/handlers/queued-withdrawals.ts",
      evidence: "organizationId: target.auth.organizationId",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/earn/index.ts",
      section: '"/vault-withdrawal-requests",',
      before: "extract: extractEarnVaultWithdrawalRequestPolicyCandidate",
      after: "createEarnVaultWithdrawalRequest",
    },
    replay: [
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/routes/earn.vault-withdrawals.test.ts",
        evidence: "puts the delegated intermediate, not the share mint, in front of policy",
      },
      {
        mode: "claimed_state_machine",
        file: "apps/sdp-api/src/services/earn/vault-queued-withdrawal-reconciliation.service.test.ts",
        evidence: "recovers a live request PDA when signature history is missing after expiry",
      },
    ],
  },
  {
    /**
     * The custodial program payout (HOO-1559): a program has no custody
     * wallet, so the route pays a caller-supplied destination out of the
     * organization's provider account under the API key's own control
     * profile. Without the gate none of the deny rules, limits, destination
     * controls or approval requirements would run.
     */
    family: "earn",
    trustedContext: {
      file: "apps/sdp-api/src/routes/earn/handlers/program.ts",
      evidence: "await requireProgramContext(c, programId)",
    },
    authorization: {
      file: "apps/sdp-api/src/routes/earn/index.ts",
      section: '"/programs/:programId/withdrawals",',
      before: "extract: extractEarnProgramWithdrawalPolicyCandidate",
      after: "createEarnProgramWithdrawal",
    },
    replay: [
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/earn-program.test.ts",
        evidence:
          "resolves a caller-key retry from the ledger: one provider create, replay served live",
      },
      {
        mode: "idempotency_fingerprint",
        file: "apps/sdp-api/src/routes/earn-program.test.ts",
        evidence: "keeps two different Idempotency-Keys apart",
      },
    ],
  },
];

const signingSinkInventory: Record<string, string[]> = {
  // The custody signer check is deliberately absent: it partially signs and
  // SIMULATES its memo transaction — verified locally, never broadcast — so it
  // has no signAndSend sink and cannot spend sponsorship.
  "apps/sdp-api/src/services/earn/vault-execution.service.ts": [
    // Sponsored signing adds the fee-payer signature without broadcasting, so
    // the final signature can still be recorded before bytes reach the network.
    "signAsFeePayer",
    // Wallet-paid signing likewise returns fully signed bytes without sending.
    "signTransactionMessageWithSigners",
  ],
  // DvP create, fund, settle/cancel and payments share the owned sponsorship
  // submission sink, which signs and persists before broadcasting; fund and
  // settle only partially sign as authorities and are not sinks of their own.
  "apps/sdp-api/src/routes/pay.ts": ["signAsFeePayer"],
  "apps/sdp-api/src/services/sponsorship-submission.ts": ["prepareOwnedSubmission"],
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
  // DvP settles and cancels sign from the project's settlement-authority
  // custody wallet, so it is a money-moving sink like the ones above.
  "apps/sdp-api/src/services/dvp",
  "apps/sdp-api/src/services/sponsorship-submission.ts",
  "packages/sdp-issuance/src",
  "packages/sdp-solana/src",
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  // A root may name a single module: the owned sponsorship submission helper
  // lives beside the sponsorship services rather than in a directory of its own.
  if (statSync(directory).isFile()) {
    return [directory];
  }
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
  const sinkPattern =
    /\.(signAndSend|signAsFeePayer|prepareOwnedSubmission)\(|\b(signTransactionMessageWithSigners)\(/g;
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

/**
 * Every `extract: extractXPolicyCandidate` site in the production route tree.
 * This is how a gated route announces that policy decides before the handler
 * runs — so the set of those sites is the set of boundaries the contracts
 * below must account for, read from production instead of transcribed.
 */
function discoverGatedExtractors(): string[] {
  const extractorPattern = /extract:\s*(extract\w+PolicyCandidate)/g;
  const extractors = new Set<string>();
  for (const file of sourceFiles(path.join(repositoryRoot, "apps/sdp-api/src/routes"))) {
    for (const match of readFileSync(file, "utf8").matchAll(extractorPattern)) {
      extractors.add(match[1]);
    }
  }
  return [...extractors].sort();
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
    // Compared against the DECLARED requirement, not a transcription of the
    // array below: this test used to compare `contracts` against a
    // hand-maintained copy of its own families, so dropping a contract — the
    // exact way `earn` once shipped ungoverned — only required editing this
    // file twice to stay green.
    const covered = new Set(contracts.map((contract) => contract.family));
    expect([...covered].sort()).toEqual([...REQUIRED_FAMILIES].sort());
  });

  it("registers every policy-gated route exactly once", () => {
    // A gated value-moving route with no contract is the `earn` failure shape
    // this file exists to prevent; a contract claiming an extractor twice
    // would let one boundary impersonate another. Family-level coverage above
    // cannot see either gap when several contracts share a family (issuance
    // has thirteen). Recurring and custody gate inside services without an
    // extractor, so they stay pinned by their own contracts below.
    const gated = discoverGatedExtractors();
    expect(gated.length).toBeGreaterThan(0);

    const claims = new Map<string, string[]>();
    for (const contract of contracts) {
      const extractor = /extract:\s*(extract\w+PolicyCandidate)/.exec(
        contract.authorization.before
      )?.[1];
      if (extractor === undefined) continue;
      const claimed = claims.get(extractor) ?? [];
      claimed.push(contract.authorization.file);
      claims.set(extractor, claimed);
    }

    for (const extractor of gated) {
      expect(
        claims.get(extractor),
        `${extractor} gates a route in production but has no registered contract`
      ).toHaveLength(1);
    }
    for (const [extractor, files] of claims) {
      expect(
        gated,
        `${extractor} is claimed by ${files.join(", ")} but production no longer gates with it`
      ).toContain(extractor);
    }
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

  it("refuses platform-held signing keys in a managed deployment", async () => {
    const { assertSigningProviderAllowed } = await import("@/services/adapters/signing");

    for (const env of [
      { SDP_DEPLOYMENT_MODE: "managed", SIGNING_PROVIDER: "local", CUSTODY_PRIVATE_KEY: "k" },
      { SDP_DEPLOYMENT_MODE: "managed", CUSTODY_PRIVATE_KEY: "k" },
      { CUSTODY_PRIVATE_KEY: "k" },
    ]) {
      expect(() => assertSigningProviderAllowed(env as never)).toThrow(/Local signing/);
    }

    expect(() =>
      assertSigningProviderAllowed({
        SDP_DEPLOYMENT_MODE: "managed",
        SIGNING_PROVIDER: "coinbase_cdp",
      } as never)
    ).not.toThrow();
    expect(() =>
      assertSigningProviderAllowed({
        SDP_DEPLOYMENT_MODE: "self_hosted",
        SIGNING_PROVIDER: "local",
      } as never)
    ).not.toThrow();
  });

  it("never loads or creates a stored local signing key in a managed deployment", async () => {
    const { createAdapterFromEncryptedConfig } = await import(
      "@/services/domain/signing/provider-adapter-factory"
    );
    const localRecord = {
      id: "cfg_local",
      organizationId: "org_1",
      projectId: null,
      provider: "local",
      config: JSON.stringify({ provider: "local", encryptedPrivateKey: "ciphertext" }),
      encryptionVersion: "v2",
      defaultWalletId: null,
      status: "active",
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    } as const;
    const decrypt = vi.fn().mockRejectedValue(new Error("decrypt reached"));
    // SAFETY: the guard reads only SDP_DEPLOYMENT_MODE, and decrypt is the one
    // cipher method these paths can reach; the fakes implement exactly that.
    const managedEnv = {
      SDP_DEPLOYMENT_MODE: "managed",
      DATABASE_URL: "postgres://unused",
    } as never;
    const selfHostedEnv = { SDP_DEPLOYMENT_MODE: "self_hosted" } as never;
    const cipher = { decrypt } as never;

    await expect(
      createAdapterFromEncryptedConfig(managedEnv, "org_1", localRecord, cipher)
    ).rejects.toThrow(/Local signing/);
    expect(decrypt).not.toHaveBeenCalled();

    await expect(
      createAdapterFromEncryptedConfig(selfHostedEnv, "org_1", localRecord, cipher)
    ).rejects.toThrow("decrypt reached");

    const { SigningService } = await import("@/services/domain/signing.service");
    const configStore = { findActiveByProvider: vi.fn() };
    // SAFETY: initializeLocalSigning must refuse before its first store call;
    // the fake only records whether that call happened.
    const service = new SigningService(configStore as never, managedEnv);
    await expect(service.initializeLocalSigning("org_1")).rejects.toThrow(/Local signing/);
    expect(configStore.findActiveByProvider).not.toHaveBeenCalled();
  });

  it("keeps the local custody provider unavailable in a managed deployment", async () => {
    const { isProviderConfigured } = await import("@/services/provider-availability.service");

    expect(
      isProviderConfigured(
        { SDP_DEPLOYMENT_MODE: "managed", CUSTODY_PRIVATE_KEY: "k" } as never,
        "custody",
        "local"
      )
    ).toBe(false);
    expect(
      isProviderConfigured(
        { SDP_DEPLOYMENT_MODE: "self_hosted", CUSTODY_PRIVATE_KEY: "k" } as never,
        "custody",
        "local"
      )
    ).toBe(true);
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
