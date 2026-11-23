import { runInClusterScope } from "@sdp/rpc/scope";
import type { Operation, OperationProposalBinding, SubmitOperation } from "@sdp/types/operations";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OperationClaim,
  OperationScope,
  OperationUpdate,
} from "@/db/repositories/operations.repository";
import { conflict, forbidden, serviceUnavailable } from "@/lib/errors";
import { MoneyMovementRefusedError } from "@/lib/money-admission";
import type { AppContext } from "@/routes/earn/context";
import {
  ProposalAdmissionRefusedError,
  ProposalNotSentError,
} from "@/services/domain/signing/admitted-proposer";
import { env } from "@/test/helpers/env";
import {
  advanceEarnOperation,
  projectEarnOperation,
  submitEarnOperation,
} from "./strategy-operations.service";
import type { PreparedStrategySigningTarget } from "./strategy-transactions.service";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  submit: vi.fn(),
  claim: vi.fn(),
  transition: vi.fn(),
  recordSigned: vi.fn(),
  recordBinding: vi.fn(),
  dispatch: vi.fn(),
  request: vi.fn(),
  restrict: vi.fn(),
  release: vi.fn(),
  sign: vi.fn(),
  sponsor: vi.fn(),
  proposer: vi.fn(),
  height: vi.fn(),
  strategy: vi.fn(),
  depositAdmission: vi.fn(),
  moneyAdmission: vi.fn(),
  withdrawal: vi.fn(),
  movement: vi.fn(),
  position: vi.fn(),
  prepareProposal: vi.fn(),
  propose: vi.fn(),
  readProposal: vi.fn(),
  admitProposal: vi.fn(),
  cancelProposal: vi.fn(),
  signatureStatus: vi.fn(),
  committed: vi.fn(),
}));

vi.mock("@sdp/rpc/factory", async (original) => ({
  ...(await original<typeof import("@sdp/rpc/factory")>()),
  createClusterRpc: () => ({ getSignatureStatuses: () => ({ send: mocks.signatureStatus }) }),
}));

vi.mock("./strategy-operation-build.service", () => ({ resolveEarnOperationBuild: mocks.build }));
vi.mock("@/middleware/idempotency", async (original) => ({
  ...(await original<typeof import("@/middleware/idempotency")>()),
  markIdempotencyCommitted: mocks.committed,
}));
vi.mock("@/services/operation-execution-audit.service", () => ({
  acceptOperationExecution: (_c: unknown, ...args: unknown[]) => mocks.request(...args),
}));
vi.mock("@/services/operations.service", () => ({
  createOperationsService: () => ({
    claimSubmission: mocks.claim,
    transition: mocks.transition,
    recordSignedAttempt: mocks.recordSigned,
    recordProposalBinding: mocks.recordBinding,
    markDispatchStarted: mocks.dispatch,
    repository: {
      requestExecution: mocks.request,
      restrictToObservation: mocks.restrict,
      release: mocks.release,
    },
  }),
}));
vi.mock("./strategy-transactions.service", async (original) => ({
  ...(await original<typeof import("./strategy-transactions.service")>()),
  signPreparedStrategyTransaction: mocks.sign,
  sponsorPreparedStrategyTransaction: mocks.sponsor,
}));
vi.mock("@/services/solana/signer", async (original) => ({
  ...(await original<typeof import("@/services/solana/signer")>()),
  createOrgTransactionProposerForCustodyWallet: mocks.proposer,
}));
vi.mock("./vault-intent-execution.service", async (original) => ({
  ...(await original<typeof import("./vault-intent-execution.service")>()),
  readConfirmedBlockHeight: mocks.height,
}));
vi.mock("@/routes/earn/handlers/admission", () => ({
  assertRecordedStrategyDepositAdmitted: mocks.depositAdmission,
}));
vi.mock("@/routes/earn/strategy-catalogue", () => ({
  isEarnStrategyInExecutionShelf: () => true,
}));
vi.mock("@/lib/money-admission", async (original) => ({
  ...(await original<typeof import("@/lib/money-admission")>()),
  assertMoneyStartAdmitted: mocks.moneyAdmission,
}));
vi.mock("@/db/client", async (original) => ({
  ...(await original<typeof import("@/db/client")>()),
  getDb: () => ({}),
}));
vi.mock("@/db/repositories/earn.repository.postgres", () => ({
  createPostgresEarnRepository: () => ({
    getStrategyById: mocks.strategy,
  }),
}));
vi.mock("@/db/repositories/earn-vault-withdrawal-requests.repository", () => ({
  createPostgresEarnVaultWithdrawalRequestsRepository: () => ({ getById: mocks.withdrawal }),
}));
vi.mock("@/db/repositories/earn-movements.repository", () => ({
  createPostgresEarnMovementsRepository: () => ({
    getMovementById: mocks.movement,
    getPositionById: mocks.position,
  }),
}));

const scope: OperationScope = {
  organizationId: "org",
  projectId: "project",
  environment: "sandbox",
};
const scoped = <T>(work: () => T): T =>
  runInClusterScope({ projectId: scope.projectId, environment: scope.environment }, work);
let keyPair: CryptoKeyPair;
let owner: string;
let signed: string;
let transactionSignature: string;
let target: PreparedStrategySigningTarget;
let claim: OperationClaim;

function operation(): Operation {
  return {
    id: "operation",
    kind: "earn.deposit",
    status: "prepared",
    environment: "sandbox",
    intent: {
      kind: "earn.deposit",
      strategyId: "strategy",
      source: { walletId: "wallet" },
      amount: { mint: "mint", value: "10" },
    },
    actionId: "action",
    version: 1,
    nextAction: { type: "submit" },
    terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
    buildRef: { kind: "earn.strategy_transaction", id: "build" },
    resourceRef: null,
    canCancel: false,
    result: null,
    cancelRequestedAt: null,
    error: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
  };
}

async function transaction(message: string) {
  const compiled = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (value) => setTransactionMessageFeePayer(address(owner), value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 100n },
          value
        ),
      (value) =>
        appendTransactionMessageInstruction(
          {
            programAddress: MEMO_PROGRAM_ADDRESS,
            accounts: [],
            data: new TextEncoder().encode(message),
          },
          value
        )
    )
  );
  const authorized = await partiallySignTransaction([keyPair], compiled);
  return {
    unsigned: Buffer.from(getTransactionEncoder().encode(compiled)).toString("base64"),
    signed: Buffer.from(getTransactionEncoder().encode(authorized)).toString("base64"),
    signature: getSignatureFromTransaction(authorized),
  };
}

const body = (): SubmitOperation => ({
  actionId: claim.operation.actionId,
  version: claim.operation.version,
});

function useExistingProposal() {
  const binding: OperationProposalBinding = {
    provider: "fireblocks",
    externalId: "attempt",
    connectionId: "connection",
    accountFingerprint: "fingerprint",
    vaultAccountId: "account",
    assetId: "SOL_TEST",
    sourceAddress: owner,
  };
  claim.attempt.proposalBinding = binding;
  claim.attempt.dispatchStartedAt = "2026-11-18T00:00:00.000Z";
  claim.recoveryRequired = true;
  mocks.proposer.mockResolvedValue({
    provider: "fireblocks",
    address: owner,
    prepare: mocks.prepareProposal,
    propose: mocks.propose,
    read: mocks.readProposal,
    admit: mocks.admitProposal,
    cancel: mocks.cancelProposal,
  });
  return binding;
}

beforeEach(async () => {
  vi.resetAllMocks();
  keyPair = await generateKeyPair();
  owner = await getAddressFromPublicKey(keyPair.publicKey);
  const built = await transaction("reviewed deposit");
  signed = built.signed;
  transactionSignature = built.signature;
  target = {
    id: "build",
    owner_address: owner,
    unsigned_transaction: built.unsigned,
    fee_payer: null,
    fee_mode: "wallet",
    last_valid_block_height: "100",
    movement: "earn.deposit",
  };
  claim = {
    operation: operation(),
    token: "claim",
    fence: 1,
    purpose: "execute",
    recoveryRequired: false,
    attempt: {
      id: "attempt",
      operationId: "operation",
      actionId: "action",
      version: 1,
      principal: { kind: "member", userId: "member" },
      buildRef: { kind: "earn.strategy_transaction", id: "build" },
      signedTransaction: null,
      signature: null,
      lastValidBlockHeight: null,
      dispatchStartedAt: null,
      executionRequestedAt: null,
      auditIntentId: null,
      observationOnly: false,
      proposalBinding: null,
      resourceRef: null,
    },
  };
  mocks.claim.mockImplementation(async () => claim);
  mocks.build.mockImplementation(async () => ({
    target,
    transactionScope: { ...scope, custodyWalletId: "wallet" },
    submit: mocks.submit,
  }));
  mocks.transition.mockImplementation(
    async (_scope: OperationScope, current: OperationClaim, update: OperationUpdate) => ({
      ...current.operation,
      ...update,
    })
  );
  mocks.recordSigned.mockImplementation(
    async (
      _scope: OperationScope,
      current: OperationClaim,
      record: { signedTransaction: string; signature: string; lastValidBlockHeight: string }
    ) => ({ ...current.attempt, ...record })
  );
  mocks.dispatch.mockResolvedValue(true);
  mocks.proposer.mockResolvedValue(null);
  mocks.height.mockResolvedValue(50n);
  mocks.strategy.mockResolvedValue({ id: "strategy", environment: "sandbox" });
  mocks.sign.mockResolvedValue(signed);
  mocks.submit.mockResolvedValue({ kind: "earn.movement", id: "movement" });
  mocks.signatureStatus.mockResolvedValue({ value: [null] });
});

function walletBuild() {
  claim.operation.intent = {
    kind: "earn.deposit",
    strategyId: "strategy",
    source: { ownerAddress: owner },
    amount: { mint: "mint", value: "10" },
  };
  claim.operation.nextAction = {
    type: "sign_transaction",
    transaction: target.unsigned_transaction,
    lastValidBlockHeight: "100",
    expiresAt: null,
  };
  mocks.build.mockImplementation(async () => ({
    target,
    transactionScope: { ...scope, custodyWalletId: null },
    submit: mocks.submit,
  }));
}

describe("asynchronous operation execution", () => {
  it("acknowledges a custody action without resolving a signer, proposal or broadcast", async () => {
    expect(
      await scoped(() => submitEarnOperation(env, scope, "operation", body(), {} as AppContext))
    ).toMatchObject({ status: "queued", nextAction: { type: "wait" }, result: null });
    expect(mocks.request).toHaveBeenCalledWith(scope, claim, undefined);
    expect(mocks.committed).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.committed.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.committed.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transition.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(scope, claim);
  });

  it("reports a custody deposit its strategy stopped admitting as DEPOSIT_REFUSED", async () => {
    mocks.depositAdmission.mockRejectedValue(
      forbidden("Vault deposits are paused for this strategy")
    );
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "DEPOSIT_REFUSED", message: "Vault deposits are paused for this strategy" },
    });
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("keeps a custody deposit's withdrawn permission as SIGNING_REJECTED", async () => {
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      error: { code: "SIGNING_REJECTED", message: "Permission was withdrawn before signing" },
    });
    expect(mocks.depositAdmission).not.toHaveBeenCalled();
  });

  it("verifies and durably records owner-signed bytes before acknowledging queued work", async () => {
    walletBuild();
    expect(
      await scoped(() =>
        submitEarnOperation(
          env,
          scope,
          "operation",
          { ...body(), signedTransaction: signed },
          {} as AppContext
        )
      )
    ).toMatchObject({ status: "queued", result: null });
    expect(mocks.request).toHaveBeenCalledWith(scope, claim, {
      signedTransaction: signed,
      signature: transactionSignature,
      lastValidBlockHeight: "100",
    });
    // The acceptance transaction, not an earlier write, owns signed outbox bytes.
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps acceptance committed when the later response transition fails", async () => {
    mocks.transition.mockRejectedValue(serviceUnavailable("Response transition unavailable"));
    await expect(
      scoped(() => submitEarnOperation(env, scope, "operation", body(), {} as AppContext))
    ).rejects.toThrow("Response transition unavailable");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.committed).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(scope, claim);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects a genuine owner signature over forged bytes before requesting execution", async () => {
    walletBuild();
    const forged = await transaction("different unreviewed deposit");
    await expect(
      scoped(() =>
        submitEarnOperation(
          env,
          scope,
          "operation",
          {
            ...body(),
            signedTransaction: forged.signed,
          },
          {} as AppContext
        )
      )
    ).rejects.toThrow("does not match the built transaction");
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.committed).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(scope, claim);
  });

  it("rejects a changed owner-signed replay even after the original bytes were retained", async () => {
    walletBuild();
    claim.attempt.signedTransaction = signed;
    claim.recoveryRequired = true;
    const forged = await transaction("changed replay after acceptance");
    await expect(
      scoped(() =>
        submitEarnOperation(
          env,
          scope,
          "operation",
          { ...body(), signedTransaction: forged.signed },
          {} as AppContext
        )
      )
    ).rejects.toThrow("does not match the built transaction");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("passes a verified exact signed replay through atomic acceptance", async () => {
    walletBuild();
    claim.attempt.signedTransaction = signed;
    claim.recoveryRequired = true;
    await scoped(() =>
      submitEarnOperation(
        env,
        scope,
        "operation",
        { ...body(), signedTransaction: signed },
        {} as AppContext
      )
    );
    expect(mocks.request).toHaveBeenCalledWith(scope, claim, {
      signedTransaction: signed,
      signature: transactionSignature,
      lastValidBlockHeight: "100",
    });
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refuses caller-supplied signed bytes on custody actions during recovery", async () => {
    claim.attempt.signedTransaction = signed;
    claim.recoveryRequired = true;
    await expect(
      scoped(() =>
        submitEarnOperation(
          env,
          scope,
          "operation",
          { ...body(), signedTransaction: signed },
          {} as AppContext
        )
      )
    ).rejects.toThrow("Custody transactions are signed through their configured provider");
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("lets the worker sign only after acceptance and persists its bytes before submission", async () => {
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "submitted",
      resourceRef: { kind: "earn.movement", id: "movement" },
    });
    expect(mocks.sign).toHaveBeenCalledTimes(1);
    expect(mocks.recordSigned).toHaveBeenCalledWith(
      scope,
      claim,
      expect.objectContaining({ signedTransaction: signed, signature: transactionSignature })
    );
    expect(mocks.recordSigned.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.submit.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.submit).toHaveBeenCalledWith(signed, true);
  });
});

describe("custody proposal recovery", () => {
  it.each([false, true])(
    "fails an unsigned expired action before requesting signing (async=%s)",
    async (asyncSigning) => {
      if (asyncSigning) {
        useExistingProposal();
        claim.attempt.proposalBinding = null;
        claim.attempt.dispatchStartedAt = null;
      }
      mocks.height.mockResolvedValue(101n);
      expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
        status: "failed",
        nextAction: null,
        error: { code: "TRANSACTION_EXPIRED" },
      });
      expect(mocks.prepareProposal).not.toHaveBeenCalled();
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    }
  );

  it("fails an expired incomplete sponsored signature without offering refresh", async () => {
    useExistingProposal();
    target.fee_mode = "sponsored";
    mocks.height.mockResolvedValue(101n);
    mocks.readProposal.mockResolvedValue({
      phase: "signed",
      providerTransactionId: "proposal",
      signedTransaction: signed,
    });
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "TRANSACTION_EXPIRED" },
    });
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("uses one confirmed-height read while preparing and observing a new custody proposal", async () => {
    const binding = useExistingProposal();
    mocks.prepareProposal.mockResolvedValue(binding);
    mocks.recordBinding.mockImplementation(
      async (
        _scope: OperationScope,
        current: OperationClaim,
        proposalBinding: OperationProposalBinding
      ) => ({ ...current.attempt, proposalBinding })
    );
    claim.attempt.proposalBinding = null;
    claim.attempt.dispatchStartedAt = null;
    mocks.propose.mockResolvedValue({
      phase: "pending",
      providerTransactionId: "proposal",
      signedTransaction: null,
    });
    await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.prepareProposal).toHaveBeenCalledTimes(1);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.height).toHaveBeenCalledTimes(1);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("waits for wallet-provider signing and broadcasts its signature without another submission", async () => {
    const binding = useExistingProposal();
    claim.operation.status = "queued";
    claim.attempt.executionRequestedAt = "2026-11-18T00:00:00.000Z";
    mocks.readProposal.mockResolvedValueOnce({
      phase: "pending",
      providerTransactionId: "proposal",
      signedTransaction: null,
    });
    const pending = await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(pending).toMatchObject({
      status: "awaiting_signature",
      nextAction: {
        type: "sign_in_provider",
        provider: "fireblocks",
        providerTransactionId: "proposal",
        instructions: "Sign this transaction with your wallet provider",
      },
      error: null,
    });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    claim.operation = pending;
    mocks.readProposal.mockResolvedValueOnce({
      phase: "signed",
      providerTransactionId: "proposal",
      signedTransaction: signed,
    });
    mocks.sponsor.mockResolvedValue(signed);
    const submitted = await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(submitted).toMatchObject({
      status: "submitted",
      resourceRef: { kind: "earn.movement", id: "movement" },
      nextAction: { type: "wait" },
    });
    expect(mocks.readProposal).toHaveBeenCalledTimes(2);
    expect(mocks.readProposal).toHaveBeenLastCalledWith({
      binding,
      unsignedTransaction: target.unsigned_transaction,
    });
    expect(mocks.recordSigned).toHaveBeenCalledOnce();
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, true);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled"] as const)(
    "ends the accepted operation after provider signing is %s",
    async (phase) => {
      useExistingProposal();
      mocks.readProposal.mockResolvedValue({
        phase,
        providerTransactionId: "proposal",
        signedTransaction: null,
      });
      expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
        status: "failed",
        nextAction: null,
        error: { code: "SIGNING_REJECTED" },
        resourceRef: { kind: "custody.proposal", id: "proposal" },
      });
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    }
  );

  it("waits for verified signing cancellation before declaring the expired operation failed", async () => {
    const binding = useExistingProposal();
    mocks.height.mockResolvedValue(101n);
    mocks.readProposal.mockResolvedValueOnce({
      phase: "pending",
      providerTransactionId: "proposal",
      signedTransaction: null,
    });
    const pending = await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(pending).toMatchObject({
      status: "awaiting_signature",
      nextAction: { type: "wait" },
    });
    expect(mocks.cancelProposal).toHaveBeenCalledExactlyOnceWith(binding);
    claim.operation = pending;
    mocks.readProposal.mockResolvedValueOnce({
      phase: "cancelled",
      providerTransactionId: "proposal",
      signedTransaction: null,
    });
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "TRANSACTION_EXPIRED" },
    });
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("yields before creating a proposal when the remaining action budget is exhausted", async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    try {
      const binding = useExistingProposal();
      claim.attempt.dispatchStartedAt = null;
      claim.attempt.proposalBinding = null;
      mocks.prepareProposal.mockImplementation(async () => {
        elapsed = 101_000;
        return binding;
      });
      await expect(scoped(() => advanceEarnOperation(env, scope, claim))).rejects.toThrow(
        "worker yielded"
      );
      expect(mocks.recordBinding).toHaveBeenCalledTimes(1);
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("persists a completed signature before yielding an exhausted send budget", async () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    try {
      mocks.sign.mockImplementation(async () => {
        elapsed = 105_000;
        return signed;
      });
      await expect(scoped(() => advanceEarnOperation(env, scope, claim))).rejects.toThrow(
        "worker yielded"
      );
      expect(mocks.recordSigned).toHaveBeenCalledTimes(1);
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("ends a definitively unsent signing request without another provider POST", async () => {
    useExistingProposal();
    claim.attempt.dispatchStartedAt = null;
    claim.recoveryRequired = false;
    mocks.propose.mockRejectedValue(new ProposalNotSentError(forbidden("Revoked credential")));
    const result = await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(result).toMatchObject({
      status: "failed",
      resourceRef: { kind: "custody.proposal_not_sent", id: claim.attempt.id },
      error: { code: "SIGNING_REJECTED" },
      nextAction: null,
    });
    claim.operation = result;
    await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.readProposal).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not claim unsent evidence after an uncertain provider error", async () => {
    useExistingProposal();
    claim.attempt.dispatchStartedAt = null;
    mocks.propose.mockRejectedValue(serviceUnavailable("Provider timed out"));
    await expect(scoped(() => advanceEarnOperation(env, scope, claim))).rejects.toThrow(
      "Provider timed out"
    );
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("withdraws authority durably before sponsoring a late signed proposal", async () => {
    useExistingProposal();
    target.fee_mode = "sponsored";
    mocks.readProposal.mockResolvedValue({
      phase: "signed",
      providerTransactionId: "proposal",
      signedTransaction: signed,
    });
    mocks.admitProposal.mockRejectedValue(
      new ProposalAdmissionRefusedError("credential_revoked", forbidden("Revoked credential"))
    );
    await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("re-admits persisted custody bytes before their first broadcast", async () => {
    claim.attempt.signedTransaction = signed;
    claim.attempt.signature = transactionSignature;
    mocks.moneyAdmission.mockRejectedValue(forbidden("Signing authority revoked"));
    const result = await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.moneyAdmission).toHaveBeenCalledWith(
      env,
      scope,
      expect.objectContaining({ movement: "earn.deposit" }),
      { custodyWalletId: "wallet" }
    );
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(result).toMatchObject({ nextAction: { type: "wait" } });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("only looks up an uncertain proposal and never creates another after a missing lookup", async () => {
    const binding = useExistingProposal();
    mocks.readProposal.mockResolvedValue(null);
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "awaiting_signature",
      nextAction: { type: "wait" },
    });
    expect(mocks.readProposal).toHaveBeenCalledWith({
      binding,
      unsignedTransaction: target.unsigned_transaction,
    });
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.prepareProposal).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("withdraws authority durably before asking the provider to cancel a refused pending proposal", async () => {
    const binding = useExistingProposal();
    mocks.readProposal.mockResolvedValue({
      phase: "pending",
      providerTransactionId: "proposal",
      signedTransaction: null,
    });
    mocks.admitProposal.mockRejectedValue(
      new ProposalAdmissionRefusedError("credential_revoked", forbidden("Revoked credential"))
    );
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "awaiting_signature",
      nextAction: { type: "wait" },
    });
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.cancelProposal).toHaveBeenCalledWith(binding);
    expect(mocks.restrict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cancelProposal.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps authority unchanged when the live admission read is temporarily unavailable", async () => {
    useExistingProposal();
    mocks.readProposal.mockResolvedValue({
      phase: "pending",
      providerTransactionId: "proposal",
      signedTransaction: null,
    });
    mocks.admitProposal.mockRejectedValue(serviceUnavailable("Admission unavailable"));
    await expect(scoped(() => advanceEarnOperation(env, scope, claim))).rejects.toThrow(
      "Admission unavailable"
    );
    expect(mocks.restrict).not.toHaveBeenCalled();
    expect(mocks.cancelProposal).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("operation settlement projection", () => {
  function queue(status: string, mechanism = "solver_queue") {
    claim.operation.kind = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
    claim.operation.status = "settling";
    claim.operation.resourceRef = { kind: "earn.withdrawal_request", id: "request" };
    mocks.withdrawal.mockResolvedValue({
      project_id: scope.projectId,
      status,
      mechanism,
      position_id: "position",
      custody_wallet_id: "wallet",
      owner_address: owner,
      token_mint: "underlying",
      creation_signature: "escrow-signature",
      closing_signature: null,
      assets_paid: null,
      failure_reason: null,
      updated_at: claim.operation.updatedAt,
    });
  }

  it.each(["solver_queue", "operator_redemption"])(
    "keeps an unobserved %s creation submitted even when its signature is recorded",
    async (mechanism) => {
      queue("creating", mechanism);
      claim.operation.status = "submitted";
      expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
        status: "submitted",
        nextAction: { type: "wait", reason: "Waiting for transaction confirmation" },
        result: { signature: "escrow-signature", settledAmount: null, settlementOutcome: null },
      });
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    }
  );

  it("projects provider-observed queue entry as semantic progress without changing its signature", async () => {
    queue("creating");
    claim.operation.status = "submitted";
    const creating = await scoped(() => projectEarnOperation(env, scope, claim.operation));
    const request = await mocks.withdrawal();
    const observedAt = "2026-11-18T00:00:10.000Z";
    mocks.withdrawal.mockResolvedValue({ ...request, status: "pending", updated_at: observedAt });
    const pending = await scoped(() => projectEarnOperation(env, scope, creating));
    expect(creating.status).toBe("submitted");
    expect(creating.updatedAt).toBe(claim.operation.updatedAt);
    expect(pending.status).toBe("settling");
    expect(pending.updatedAt).toBe(observedAt);
    expect(pending.result).toEqual(creating.result);
    expect(pending.nextAction).toEqual({ type: "wait", reason: "Waiting for provider settlement" });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("retains later operation metadata when request evidence has an older timestamp", async () => {
    queue("pending");
    const request = await mocks.withdrawal();
    mocks.withdrawal.mockResolvedValue({ ...request, updated_at: "2026-11-18T00:00:10.000Z" });
    claim.operation.updatedAt = "2026-11-18T00:00:20.000Z";
    const projected = await scoped(() => projectEarnOperation(env, scope, claim.operation));
    expect(projected.updatedAt).toBe(claim.operation.updatedAt);
    expect(projected.status).toBe("settling");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not regress an older stored settling operation while creation remains unobserved", async () => {
    queue("creating");
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "settling",
      nextAction: { type: "wait", reason: "Waiting for provider settlement" },
    });
    expect(mocks.transition).toHaveBeenCalledWith(
      scope,
      claim,
      expect.objectContaining({ status: "settling" })
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps a confirmed escrow request settling without claiming an underlying payout", async () => {
    queue("pending");
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "settling",
      result: { signature: "escrow-signature", settledAmount: null, settlementOutcome: null },
    });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("does not call a cancelled par redemption an underlying payout or recreated shares", async () => {
    queue("cancelled", "operator_redemption");
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "cancelled",
      nextAction: null,
      result: {
        settledAmount: null,
        settlementOutcome: "cancelled",
        source: { walletId: "wallet" },
      },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps a closed position's strategy on its withdrawal history", async () => {
    claim.operation.kind = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
    claim.operation.resourceRef = { kind: "earn.movement", id: "movement" };
    mocks.movement.mockResolvedValue({
      environment: scope.environment,
      project_id: scope.projectId,
      position_id: "position",
      status: "finalized",
      signature: "signature",
      token_amount_settled: "10",
      chain_finalized_at: "2026-11-18T00:00:00.000Z",
    });
    mocks.position.mockResolvedValue({
      id: "position",
      strategy_id: "held-strategy",
      custody_wallet_id: "wallet",
      token_mint: "mint",
      closed_at: "2026-11-18T00:00:00.000Z",
    });
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "completed",
      result: { strategyId: "held-strategy", positionId: "position" },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("includes the held strategy in queued withdrawal history", async () => {
    queue("pending");
    mocks.position.mockResolvedValue({ strategy_id: "held-strategy" });
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      result: { strategyId: "held-strategy" },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("shows the accepted cancellation signature while its outcome is pending", async () => {
    queue("cancelling");
    const request = await mocks.withdrawal();
    mocks.withdrawal.mockResolvedValue({ ...request, cancel_signature: "cancel-signature" });
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "settling",
      result: { signature: "cancel-signature", settledAmount: null, settlementOutcome: null },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("live operation exit permission", () => {
  const exits = [
    "earn.withdraw",
    "earn.queued_withdraw_request",
    "earn.queued_withdraw_cancel",
  ] as const;
  beforeEach(() => {
    claim.operation.kind = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
  });

  it.each(exits)("refuses new %s signing after its execute grant is removed", async (movement) => {
    target.movement = movement;
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "SIGNING_REJECTED" },
    });
    expect(mocks.moneyAdmission).toHaveBeenCalledWith(
      env,
      scope,
      expect.objectContaining({ movement, requiredAction: "earn.execute" }),
      { custodyWalletId: "wallet" }
    );
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rechecks membership after a slow read before requesting a signature", async () => {
    target.movement = "earn.queued_withdraw_cancel";
    mocks.moneyAdmission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new MoneyMovementRefusedError("principal_not_live"));
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
    });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refuses a new provider proposal after its reviewed operation loses execute permission", async () => {
    target.movement = "earn.queued_withdraw_cancel";
    useExistingProposal();
    claim.attempt.dispatchStartedAt = null;
    mocks.moneyAdmission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new MoneyMovementRefusedError("action_not_held", "earn.execute"));
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      nextAction: null,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("retains caller-signed withdrawal bytes after execute permission is removed", async () => {
    walletBuild();
    target.movement = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
    claim.attempt.signedTransaction = signed;
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      nextAction: { type: "wait" },
    });
    expect(mocks.moneyAdmission).toHaveBeenCalledWith(
      env,
      scope,
      expect.objectContaining({ movement: "earn.withdraw", requiredAction: "earn.execute" }),
      { custodyWalletId: null }
    );
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(claim.attempt.signedTransaction).toBe(signed);
  });

  it.each(["action_not_held", "principal_not_live"] as const)(
    "keeps provider cleanup available after %s without another proposal",
    async (reason) => {
      target.movement = "earn.queued_withdraw_cancel";
      const binding = useExistingProposal();
      mocks.moneyAdmission.mockRejectedValue(
        reason === "action_not_held"
          ? new MoneyMovementRefusedError(reason, "earn.execute")
          : new MoneyMovementRefusedError(reason)
      );
      mocks.readProposal.mockResolvedValue({
        phase: "pending",
        providerTransactionId: "proposal",
        signedTransaction: null,
      });
      expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
        status: "awaiting_signature",
        nextAction: { type: "wait" },
      });
      expect(mocks.readProposal).toHaveBeenCalledWith({
        binding,
        unsignedTransaction: target.unsigned_transaction,
      });
      expect(mocks.cancelProposal).toHaveBeenCalledWith(binding);
      expect(mocks.propose).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.sponsor).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each(["action_not_held", "principal_not_live"] as const)(
    "observes persisted recovery bytes after %s without broadcasting",
    async (reason) => {
      target.movement = "earn.queued_withdraw_cancel";
      claim.attempt.signedTransaction = signed;
      mocks.moneyAdmission.mockRejectedValue(
        reason === "action_not_held"
          ? new MoneyMovementRefusedError(reason, "earn.execute")
          : new MoneyMovementRefusedError(reason)
      );
      expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
        nextAction: { type: "wait" },
      });
      expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
      expect(mocks.signatureStatus).toHaveBeenCalledTimes(1);
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
    }
  );

  it("records an already observed signature after revocation without sending it", async () => {
    target.movement = "earn.queued_withdraw_cancel";
    claim.attempt.signedTransaction = signed;
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    mocks.signatureStatus.mockResolvedValue({ value: [{ slot: 100n }] });
    await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("adopts a revoked release for observation before its signature appears", async () => {
    target.movement = "earn.queued_withdraw_cancel";
    claim.attempt.signedTransaction = signed;
    mocks.build.mockImplementation(async () => ({
      target,
      transactionScope: { ...scope, custodyWalletId: "wallet" },
      submit: mocks.submit,
      currentRelease: true,
    }));
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    mocks.signatureStatus.mockResolvedValue({ value: [null] });
    await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not sponsor a proposal signed after its operation loses permission", async () => {
    target.movement = "earn.queued_withdraw_cancel";
    target.fee_mode = "sponsored";
    useExistingProposal();
    mocks.moneyAdmission
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new MoneyMovementRefusedError("principal_not_live"));
    mocks.readProposal.mockResolvedValue({
      phase: "signed",
      providerTransactionId: "proposal",
      signedTransaction: signed,
    });
    await scoped(() => advanceEarnOperation(env, scope, claim));
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("withdrawal recovery races", () => {
  beforeEach(() => {
    target = { ...target, movement: "earn.queued_withdraw_cancel" };
    claim.operation.kind = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
    claim.attempt.signedTransaction = signed;
  });

  it("ends only a recovery whose original request was definitively closed", async () => {
    mocks.submit.mockRejectedValue(
      conflict("Closed", { reason: "withdrawal_recovery_unavailable" })
    );
    expect(await scoped(() => advanceEarnOperation(env, scope, claim))).toMatchObject({
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: { code: "TRANSACTION_FAILED" },
    });
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("does not turn an uncertain provider conflict into nonexecution", async () => {
    const error = conflict("Provider state is unknown");
    mocks.submit.mockRejectedValue(error);
    await expect(scoped(() => advanceEarnOperation(env, scope, claim))).rejects.toBe(error);
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
