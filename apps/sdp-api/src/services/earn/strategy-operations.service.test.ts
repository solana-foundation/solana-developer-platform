import { runInClusterScope } from "@sdp/rpc/scope";
import type { EarnVaultWithdrawalRequestStatus } from "@sdp/types/earn";
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
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import * as earnRepositories from "@/db/repositories/earn.repository.postgres";
import * as movementRepositories from "@/db/repositories/earn-movements.repository";
import type { EarnVaultWithdrawalRequestRow } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import * as withdrawalRepositories from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import {
  conflict,
  custodyPolicyRefused,
  forbidden,
  serviceUnavailable,
  vaultExposureCapExceeded,
} from "@/lib/errors";
import * as moneyAdmission from "@/lib/money-admission";
import * as idempotency from "@/middleware/idempotency";
import * as depositAdmission from "@/routes/earn/handlers/admission";
import * as catalogue from "@/routes/earn/strategy-catalogue";
import {
  ProposalAdmissionRefusedError,
  ProposalNotSentError,
} from "@/services/domain/signing/admitted-proposer";
import type {
  CustodyTransactionProposer,
  TransactionProposalObservation,
} from "@/services/domain/signing/admitted-transaction-proposer";
import * as executionAudit from "@/services/operation-execution-audit.service";
import * as operationServices from "@/services/operations.service";
import * as signers from "@/services/solana/signer";
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import type { Env } from "@/types/env";
import {
  createOperationObservationRpc,
  type OperationObservationRpc,
} from "./operation-observation-rpc";
import * as builds from "./strategy-operation-build.service";
import {
  advanceEarnOperation,
  projectEarnOperation,
  submitEarnOperation,
} from "./strategy-operations.service";
import type { PreparedStrategySigningTarget } from "./strategy-transactions.service";
import * as strategyTransactions from "./strategy-transactions.service";

const { MoneyMovementRefusedError } = moneyAdmission;
type OperationBuild = Awaited<ReturnType<typeof builds.resolveEarnOperationBuild>>;

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
let mocks: ReturnType<typeof spyOnCollaborators>;

/**
 * Real collaborators with spies on exactly what the worker reaches: the shared service and
 * repository instances, the module seams it calls, and the injected observation reads.
 */
function spyOnCollaborators() {
  const operations = operationServices.createOperationsService(env);
  vi.spyOn(operationServices, "createOperationsService").mockReturnValue(operations);
  const strategies = earnRepositories.createPostgresEarnRepository(getDb(env));
  vi.spyOn(earnRepositories, "createPostgresEarnRepository").mockReturnValue(strategies);
  const requests = withdrawalRepositories.createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  );
  vi.spyOn(
    withdrawalRepositories,
    "createPostgresEarnVaultWithdrawalRequestsRepository"
  ).mockReturnValue(requests);
  const ledger = movementRepositories.createPostgresEarnMovementsRepository(getDb(env));
  vi.spyOn(movementRepositories, "createPostgresEarnMovementsRepository").mockReturnValue(ledger);
  return {
    build: vi.spyOn(builds, "resolveEarnOperationBuild"),
    submit: vi.fn<OperationBuild["submit"]>(),
    claim: vi.spyOn(operations, "claimSubmission"),
    transition: vi.spyOn(operations, "transition"),
    recordSigned: vi.spyOn(operations, "recordSignedAttempt"),
    recordBinding: vi.spyOn(operations, "recordProposalBinding"),
    dispatch: vi.spyOn(operations, "markDispatchStarted"),
    restrict: vi.spyOn(operations.repository, "restrictToObservation"),
    release: vi.spyOn(operations.repository, "release"),
    request: vi.spyOn(executionAudit, "acceptOperationExecution"),
    committed: vi.spyOn(idempotency, "markIdempotencyCommitted"),
    sign: vi.spyOn(strategyTransactions, "signPreparedStrategyTransaction"),
    sponsor: vi.spyOn(strategyTransactions, "sponsorPreparedStrategyTransaction"),
    proposer: vi.spyOn(signers, "createOrgTransactionProposerForCustodyWallet"),
    strategy: vi.mocked(vi.spyOn(strategies, "getStrategyById"), { partial: true }),
    shelf: vi.spyOn(catalogue, "isEarnStrategyInExecutionShelf"),
    depositAdmission: vi.spyOn(depositAdmission, "assertRecordedStrategyDepositAdmitted"),
    moneyAdmission: vi.spyOn(moneyAdmission, "assertMoneyStartAdmitted"),
    withdrawal: vi.mocked(vi.spyOn(requests, "getById"), { partial: true }),
    supersedingRelease: vi.spyOn(requests, "findSupersedingRedemptionRelease"),
    movement: vi.mocked(vi.spyOn(ledger, "getMovementById"), { partial: true }),
    position: vi.mocked(vi.spyOn(ledger, "getPositionById"), { partial: true }),
    prepareProposal: vi.fn<CustodyTransactionProposer["prepare"]>(),
    propose: vi.fn<CustodyTransactionProposer["propose"]>(),
    readProposal: vi.fn<CustodyTransactionProposer["read"]>(),
    admitProposal: vi.fn<CustodyTransactionProposer["admit"]>(),
    cancelProposal: vi.fn<CustodyTransactionProposer["cancel"]>(),
    height: vi.fn<OperationObservationRpc["confirmedHeight"]>(),
    signatureStatus: vi.fn<OperationObservationRpc["hasSignature"]>(),
    unsent: vi.fn<OperationObservationRpc["unsentVerdict"]>(),
  };
}

function observations(): OperationObservationRpc {
  return {
    confirmedHeight: mocks.height,
    hasSignature: mocks.signatureStatus,
    unsentVerdict: mocks.unsent,
  };
}

const advance = () => scoped(() => advanceEarnOperation(env, scope, claim, observations()));

/** Submit through a real route, so the handler gets the request context it runs with. */
async function submit(input: SubmitOperation): Promise<Operation> {
  let outcome: PromiseSettledResult<Operation> | undefined;
  const app = new Hono<{ Bindings: Env }>().post("/", async (c) => {
    [outcome] = await Promise.allSettled([submitEarnOperation(env, scope, "operation", input, c)]);
    return c.body(null, 204);
  });
  await scoped(() => app.request("/", { method: "POST" }, env));
  if (outcome === undefined) throw new Error("The submission route did not run");
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

const PROPOSAL_STATUS = {
  pending: "PENDING_SIGNATURE",
  signed: "SIGNED",
  failed: "REJECTED",
  cancelled: "CANCELLED",
} as const satisfies Record<TransactionProposalObservation["phase"], string>;

function proposal(
  phase: TransactionProposalObservation["phase"],
  signedTransaction: string | null
): TransactionProposalObservation {
  return {
    providerTransactionId: "proposal",
    status: PROPOSAL_STATUS[phase],
    phase,
    signedTransaction,
  };
}

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

function custodyBuild(currentRelease: boolean): OperationBuild {
  return {
    target,
    transactionScope: { ...scope, custodyWalletId: "wallet" },
    submit: mocks.submit,
    currentRelease,
  };
}

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
  mocks = spyOnCollaborators();
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
  mocks.build.mockImplementation(async () => custodyBuild(false));
  mocks.transition.mockImplementation(async (_scope, current, update) => ({
    ...current.operation,
    ...update,
  }));
  mocks.recordSigned.mockImplementation(async (_scope, current, record) => ({
    ...current.attempt,
    ...record,
  }));
  mocks.recordBinding.mockImplementation(async (_scope, current, proposalBinding) => ({
    ...current.attempt,
    proposalBinding,
  }));
  mocks.dispatch.mockResolvedValue(true);
  mocks.restrict.mockImplementation(async (_scope, current) => ({
    ...current.attempt,
    observationOnly: true,
  }));
  mocks.release.mockResolvedValue(true);
  mocks.request.mockResolvedValue(undefined);
  mocks.proposer.mockResolvedValue(null);
  mocks.height.mockResolvedValue(50n);
  mocks.signatureStatus.mockResolvedValue(false);
  mocks.unsent.mockResolvedValue("pending");
  mocks.strategy.mockResolvedValue({ id: "strategy", environment: "sandbox" });
  mocks.shelf.mockReturnValue(true);
  mocks.depositAdmission.mockResolvedValue(undefined);
  mocks.moneyAdmission.mockResolvedValue(undefined);
  mocks.sign.mockResolvedValue(signed);
  mocks.sponsor.mockImplementation(async (_env, _scope, _built, ownerSigned) => ownerSigned);
  mocks.submit.mockResolvedValue({ kind: "earn.movement", id: "movement" });
  mocks.withdrawal.mockResolvedValue(null);
  mocks.supersedingRelease.mockResolvedValue(null);
  mocks.movement.mockResolvedValue(null);
  mocks.position.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
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
    currentRelease: false,
  }));
}

describe("asynchronous operation execution", () => {
  it("acknowledges a custody action without resolving a signer, proposal or broadcast", async () => {
    expect(await submit(body())).toMatchObject({
      status: "queued",
      nextAction: { type: "wait" },
      result: null,
    });
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), scope, claim, undefined);
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
    expect(await advance()).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "DEPOSIT_REFUSED", message: "Vault deposits are paused for this strategy" },
    });
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it.each(["pending", "expired", "landed"] as const)(
    "observes a capped deposit until its signed bytes are %s without retrying admission",
    async (verdict) => {
      walletBuild();
      claim.attempt.signedTransaction = signed;
      claim.attempt.signature = transactionSignature;
      claim.attempt.lastValidBlockHeight = target.last_valid_block_height;
      mocks.submit.mockRejectedValueOnce(vaultExposureCapExceeded("Vault is exit-only"));

      claim.operation = await advance();
      expect(claim.operation).toMatchObject({
        status: "awaiting_signature",
        nextAction: { type: "wait" },
        error: { code: "DEPOSIT_REFUSED", message: "Vault is exit-only" },
      });
      expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
      expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, true);
      claim.attempt.observationOnly = true;
      mocks.signatureStatus.mockResolvedValue(verdict === "landed");
      mocks.unsent.mockResolvedValue(verdict === "expired" ? "expired" : "pending");

      const result = await advance();
      if (verdict === "landed") {
        expect(result).toMatchObject({
          status: "submitted",
          error: null,
          resourceRef: { kind: "earn.movement", id: "movement" },
        });
        expect(mocks.submit).toHaveBeenLastCalledWith(signed, false);
      } else {
        expect(result).toMatchObject({
          status: verdict === "expired" ? "failed" : "awaiting_signature",
          error: { code: "DEPOSIT_REFUSED", message: "Vault is exit-only" },
        });
        expect(mocks.submit).toHaveBeenCalledTimes(1);
      }
      expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps a custody deposit's withdrawn permission as SIGNING_REJECTED", async () => {
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    expect(await advance()).toMatchObject({
      status: "failed",
      error: { code: "SIGNING_REJECTED", message: "Permission was withdrawn before signing" },
    });
    expect(mocks.depositAdmission).not.toHaveBeenCalled();
  });

  it("verifies and durably records owner-signed bytes before acknowledging queued work", async () => {
    walletBuild();
    expect(await submit({ ...body(), signedTransaction: signed })).toMatchObject({
      status: "queued",
      result: null,
    });
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), scope, claim, {
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
    await expect(submit(body())).rejects.toThrow("Response transition unavailable");
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.committed).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(scope, claim);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects a genuine owner signature over forged bytes before requesting execution", async () => {
    walletBuild();
    const forged = await transaction("different unreviewed deposit");
    await expect(submit({ ...body(), signedTransaction: forged.signed })).rejects.toThrow(
      "does not match the built transaction"
    );
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
    await expect(submit({ ...body(), signedTransaction: forged.signed })).rejects.toThrow(
      "does not match the built transaction"
    );
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("passes a verified exact signed replay through atomic acceptance", async () => {
    walletBuild();
    claim.attempt.signedTransaction = signed;
    claim.recoveryRequired = true;
    await submit({ ...body(), signedTransaction: signed });
    expect(mocks.request).toHaveBeenCalledWith(expect.anything(), scope, claim, {
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
    await expect(submit({ ...body(), signedTransaction: signed })).rejects.toThrow(
      "Custody transactions are signed through their configured provider"
    );
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("lets the worker sign only after acceptance and persists its bytes before submission", async () => {
    expect(await advance()).toMatchObject({
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
      expect(await advance()).toMatchObject({
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
    mocks.readProposal.mockResolvedValue(proposal("signed", signed));
    expect(await advance()).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "TRANSACTION_EXPIRED" },
    });
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("waits for wallet-provider signing and broadcasts its signature without another submission", async () => {
    const binding = useExistingProposal();
    claim.operation.status = "queued";
    claim.attempt.executionRequestedAt = "2026-11-18T00:00:00.000Z";
    mocks.readProposal.mockResolvedValueOnce(proposal("pending", null));
    const pending = await advance();
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
    mocks.readProposal.mockResolvedValueOnce(proposal("signed", signed));
    const submitted = await advance();
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
      mocks.readProposal.mockResolvedValue(proposal(phase, null));
      expect(await advance()).toMatchObject({
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
    mocks.readProposal.mockResolvedValueOnce(proposal("pending", null));
    const pending = await advance();
    expect(pending).toMatchObject({
      status: "awaiting_signature",
      nextAction: { type: "wait" },
    });
    expect(mocks.cancelProposal).toHaveBeenCalledExactlyOnceWith(binding);
    claim.operation = pending;
    mocks.readProposal.mockResolvedValueOnce(proposal("cancelled", null));
    expect(await advance()).toMatchObject({
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
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const binding = useExistingProposal();
    claim.attempt.dispatchStartedAt = null;
    claim.attempt.proposalBinding = null;
    mocks.prepareProposal.mockImplementation(async () => {
      elapsed = 101_000;
      return binding;
    });
    await expect(advance()).rejects.toThrow("worker yielded");
    expect(mocks.recordBinding).toHaveBeenCalledTimes(1);
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("persists a completed signature before yielding an exhausted send budget", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    mocks.sign.mockImplementation(async () => {
      elapsed = 105_000;
      return signed;
    });
    await expect(advance()).rejects.toThrow("worker yielded");
    expect(mocks.recordSigned).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("ends a definitively unsent signing request without another provider POST", async () => {
    useExistingProposal();
    claim.attempt.dispatchStartedAt = null;
    claim.recoveryRequired = false;
    mocks.propose.mockRejectedValue(new ProposalNotSentError(forbidden("Revoked credential")));
    const result = await advance();
    expect(result).toMatchObject({
      status: "failed",
      resourceRef: { kind: "custody.proposal_not_sent", id: claim.attempt.id },
      error: { code: "SIGNING_REJECTED" },
      nextAction: null,
    });
    claim.operation = result;
    await advance();
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(mocks.readProposal).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not claim unsent evidence after an uncertain provider error", async () => {
    useExistingProposal();
    claim.attempt.dispatchStartedAt = null;
    mocks.propose.mockRejectedValue(serviceUnavailable("Provider timed out"));
    await expect(advance()).rejects.toThrow("Provider timed out");
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("withdraws authority durably before sponsoring a late signed proposal", async () => {
    useExistingProposal();
    target.fee_mode = "sponsored";
    mocks.readProposal.mockResolvedValue(proposal("signed", signed));
    mocks.admitProposal.mockRejectedValue(
      new ProposalAdmissionRefusedError("credential_revoked", forbidden("Revoked credential"))
    );
    await advance();
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("re-admits persisted custody bytes before their first broadcast", async () => {
    claim.attempt.signedTransaction = signed;
    claim.attempt.signature = transactionSignature;
    mocks.moneyAdmission.mockRejectedValue(forbidden("Signing authority revoked"));
    const result = await advance();
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
    expect(await advance()).toMatchObject({
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
    mocks.readProposal.mockResolvedValue(proposal("pending", null));
    mocks.admitProposal.mockRejectedValue(
      new ProposalAdmissionRefusedError("credential_revoked", forbidden("Revoked credential"))
    );
    expect(await advance()).toMatchObject({
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
    mocks.readProposal.mockResolvedValue(proposal("pending", null));
    mocks.admitProposal.mockRejectedValue(serviceUnavailable("Admission unavailable"));
    await expect(advance()).rejects.toThrow("Admission unavailable");
    expect(mocks.restrict).not.toHaveBeenCalled();
    expect(mocks.cancelProposal).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("observation reads", () => {
  const rpc = installClusterRpcStub();

  it("uses one confirmed-height read while preparing and observing a new custody proposal", async () => {
    rpc.answer("getBlockHeight", 50);
    const binding = useExistingProposal();
    mocks.prepareProposal.mockResolvedValue(binding);
    claim.attempt.proposalBinding = null;
    claim.attempt.dispatchStartedAt = null;
    mocks.propose.mockResolvedValue(proposal("pending", null));
    await scoped(() => advanceEarnOperation(env, scope, claim, createOperationObservationRpc()));
    expect(mocks.prepareProposal).toHaveBeenCalledTimes(1);
    expect(mocks.propose).toHaveBeenCalledTimes(1);
    expect(rpc.calls.filter((call) => call.method === "getBlockHeight")).toHaveLength(1);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("operation settlement projection", () => {
  let request: Partial<EarnVaultWithdrawalRequestRow>;

  function queue(
    status: EarnVaultWithdrawalRequestStatus,
    mechanism: EarnVaultWithdrawalRequestRow["mechanism"]
  ) {
    claim.operation.kind = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
    claim.operation.status = "settling";
    claim.operation.resourceRef = { kind: "earn.withdrawal_request", id: "request" };
    request = {
      project_id: scope.projectId,
      status,
      mechanism,
      position_id: "position",
      custody_wallet_id: "wallet",
      owner_address: owner,
      token_mint: "underlying",
      creation_signature: "escrow-signature",
      closing_signature: null,
      cancel_signature: null,
      assets_paid: null,
      failure_reason: null,
      updated_at: claim.operation.updatedAt,
    };
    mocks.withdrawal.mockImplementation(async () => request);
  }

  it.each(["solver_queue", "operator_redemption"] as const)(
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
    queue("creating", "solver_queue");
    claim.operation.status = "submitted";
    const creating = await scoped(() => projectEarnOperation(env, scope, claim.operation));
    const observedAt = "2026-11-18T00:00:10.000Z";
    request = { ...request, status: "pending", updated_at: observedAt };
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
    queue("pending", "solver_queue");
    request = { ...request, updated_at: "2026-11-18T00:00:10.000Z" };
    claim.operation.updatedAt = "2026-11-18T00:00:20.000Z";
    const projected = await scoped(() => projectEarnOperation(env, scope, claim.operation));
    expect(projected.updatedAt).toBe(claim.operation.updatedAt);
    expect(projected.status).toBe("settling");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not regress an older stored settling operation while creation remains unobserved", async () => {
    queue("creating", "solver_queue");
    expect(await advance()).toMatchObject({
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
    queue("pending", "solver_queue");
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

  it("ends superseded redemption activity without claiming payout or cancellation", async () => {
    queue("pending", "operator_redemption");
    const finalizedAt = "2026-11-18T00:01:00.000Z";
    mocks.supersedingRelease.mockResolvedValue({ id: "later-release", finalizedAt });
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "failed",
      updatedAt: finalizedAt,
      nextAction: null,
      error: { code: "REDEMPTION_SUPERSEDED" },
      result: {
        signature: "escrow-signature",
        settledAmount: null,
        settlementOutcome: null,
      },
    });
    expect(await advance()).toMatchObject({
      status: "failed",
      nextAction: null,
      error: { code: "REDEMPTION_SUPERSEDED" },
    });
    expect(mocks.transition).toHaveBeenCalledWith(
      scope,
      claim,
      expect.objectContaining({
        status: "failed",
        error: { code: "REDEMPTION_SUPERSEDED", message: expect.any(String) },
      })
    );
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps an existing terminal operation after a later release supersedes its request", async () => {
    queue("pending", "operator_redemption");
    claim.operation.status = "failed";
    claim.operation.error = { code: "ORIGINAL_FAILURE", message: "Original failure" };
    mocks.supersedingRelease.mockResolvedValue({
      id: "later-release",
      finalizedAt: "2026-11-18T00:01:00.000Z",
    });
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "failed",
      error: claim.operation.error,
      result: { settledAmount: null, settlementOutcome: null },
    });
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
    queue("pending", "solver_queue");
    mocks.position.mockResolvedValue({ strategy_id: "held-strategy" });
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      result: { strategyId: "held-strategy" },
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("shows the accepted cancellation signature while its outcome is pending", async () => {
    queue("cancelling", "solver_queue");
    request = { ...request, cancel_signature: "cancel-signature" };
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
    expect(await advance()).toMatchObject({
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
    expect(await advance()).toMatchObject({ status: "failed" });
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
    expect(await advance()).toMatchObject({
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
    expect(await advance()).toMatchObject({
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
      mocks.readProposal.mockResolvedValue(proposal("pending", null));
      expect(await advance()).toMatchObject({
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
      expect(await advance()).toMatchObject({
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
    mocks.signatureStatus.mockResolvedValue(true);
    await advance();
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, false);
    expect(mocks.unsent).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("adopts a revoked release for observation before its signature appears", async () => {
    target.movement = "earn.queued_withdraw_cancel";
    claim.attempt.signedTransaction = signed;
    mocks.build.mockImplementation(async () => custodyBuild(true));
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
    mocks.signatureStatus.mockResolvedValue(false);
    await advance();
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, false);
    // The release proves its own absence after adoption.
    expect(mocks.unsent).not.toHaveBeenCalled();
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
    mocks.readProposal.mockResolvedValue(proposal("signed", signed));
    await advance();
    expect(mocks.restrict).toHaveBeenCalledWith(scope, claim);
    expect(mocks.sponsor).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("unsent signed transactions", () => {
  beforeEach(() => {
    walletBuild();
    target.movement = "earn.withdraw";
    claim.operation.kind = "earn.withdraw";
    claim.operation.intent = {
      kind: "earn.withdraw",
      positionId: "position",
      amount: { kind: "all" },
    };
    claim.attempt.signedTransaction = signed;
    mocks.moneyAdmission.mockRejectedValue(
      new MoneyMovementRefusedError("action_not_held", "earn.execute")
    );
  });

  it("fails revoked bytes once retained history proves they expired unsent", async () => {
    mocks.unsent.mockResolvedValue("expired");
    expect(await advance()).toMatchObject({
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: { code: "TRANSACTION_EXPIRED" },
    });
    expect(mocks.unsent).toHaveBeenCalledExactlyOnceWith(scope, transactionSignature, 100n);
    expect(mocks.signatureStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.unsent.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("fails cancellation-pending bytes as expired once they provably never landed", async () => {
    // A terminal cancellation needs an authoritative resource reference; unsent bytes have none.
    claim.operation.cancelRequestedAt = "2026-11-18T00:00:05.000Z";
    mocks.unsent.mockResolvedValue("expired");
    expect(await advance()).toMatchObject({
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: { code: "TRANSACTION_EXPIRED" },
    });
    expect(mocks.moneyAdmission).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("keeps reconciling bytes that can still land, without sending them", async () => {
    expect(await advance()).toMatchObject({
      status: "awaiting_signature",
      nextAction: { type: "wait", reason: "Reconciling the signed transaction without sending it" },
      error: null,
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("observes bytes that every endpoint's history found after the pooled read missed them", async () => {
    mocks.unsent.mockResolvedValue("landed");
    expect(await advance()).toMatchObject({
      status: "submitted",
      resourceRef: { kind: "earn.movement", id: "movement" },
    });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(signed, false);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("custody policy refusal", () => {
  it("ends a signature its wallet policy refused instead of asking again", async () => {
    mocks.sign.mockRejectedValue(custodyPolicyRefused(new Error("Policy rule 4"), "fireblocks"));
    expect(await advance()).toMatchObject({
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: { code: "CUSTODY_POLICY_REFUSED" },
    });
    expect(mocks.recordSigned).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("leaves any other signing failure to recovery", async () => {
    mocks.sign.mockRejectedValue(serviceUnavailable("Custody provider unavailable"));
    await expect(advance()).rejects.toThrow("Custody provider unavailable");
    expect(mocks.transition).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("projected errors and statuses", () => {
  const recoveryError = {
    code: "SERVICE_UNAVAILABLE",
    message: "The operation could not advance; recovery will retry",
  };

  function movementOperation(status: "finalized" | "confirmed" | "failed") {
    claim.operation.status = "submitted";
    claim.operation.resourceRef = { kind: "earn.movement", id: "movement" };
    claim.operation.error = recoveryError;
    mocks.movement.mockResolvedValue({
      environment: scope.environment,
      project_id: scope.projectId,
      position_id: "position",
      status,
      signature: transactionSignature,
      token_amount_settled: "10",
      chain_finalized_at: null,
      failure_reason: null,
    });
    mocks.position.mockResolvedValue({
      id: "position",
      strategy_id: "strategy",
      custody_wallet_id: "wallet",
      owner_address: null,
      token_mint: "mint",
    });
  }

  it.each(["finalized", "confirmed"] as const)(
    "drops an earlier recovery error once a %s movement is observed",
    async (status) => {
      movementOperation(status);
      expect(await advance()).toMatchObject({ error: null });
      expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
        error: null,
      });
    }
  );

  it("reports a failed movement's own failure instead of a recovery error", async () => {
    movementOperation("failed");
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "failed",
      error: { code: "TRANSACTION_FAILED", message: "Strategy transaction failed" },
    });
  });

  it("keeps a terminal operation's error when later evidence arrives", async () => {
    movementOperation("finalized");
    claim.operation.status = "failed";
    const terminalError = { code: "TRANSACTION_EXPIRED", message: "The signing request expired" };
    claim.operation.error = terminalError;
    expect(await scoped(() => projectEarnOperation(env, scope, claim.operation))).toMatchObject({
      status: "failed",
      error: terminalError,
    });
  });

  it("refuses a custodial movement as an operation's evidence", async () => {
    movementOperation("finalized");
    mocks.movement.mockResolvedValue({
      environment: scope.environment,
      project_id: scope.projectId,
      position_id: "position",
      status: "cancelled",
      chain_finalized_at: null,
    });
    await expect(scoped(() => projectEarnOperation(env, scope, claim.operation))).rejects.toThrow(
      "Operation movement is not a vault transaction"
    );
  });

  it.each([
    ["creating", "submitted", "Waiting for transaction confirmation", null],
    ["pending", "settling", "Waiting for provider settlement", null],
    ["fulfillable", "settling", "Waiting for provider settlement", null],
    ["expired_cancelable", "settling", "Waiting for provider settlement", null],
    ["cancelling", "settling", "Waiting for provider settlement", null],
    ["closed_or_unknown", "settling", "Waiting for provider settlement", null],
    ["fulfilled", "completed", null, "delivered"],
    ["cancelled", "cancelled", null, "cancelled"],
    ["failed", "failed", null, null],
  ] as const)(
    "projects a %s withdrawal request as %s",
    async (requestStatus, status, waitingFor, outcome) => {
      claim.operation.kind = "earn.withdraw";
      claim.operation.intent = {
        kind: "earn.withdraw",
        positionId: "position",
        amount: { kind: "all" },
      };
      claim.operation.status = "submitted";
      claim.operation.resourceRef = { kind: "earn.withdrawal_request", id: "request" };
      claim.operation.error = recoveryError;
      mocks.withdrawal.mockResolvedValue({
        project_id: scope.projectId,
        status: requestStatus,
        position_id: "position",
        custody_wallet_id: "wallet",
        owner_address: owner,
        token_mint: "underlying",
        creation_signature: "escrow-signature",
        closing_signature: null,
        cancel_signature: null,
        assets_paid: null,
        failure_reason: null,
        updated_at: claim.operation.updatedAt,
      });
      const projected = await scoped(() => projectEarnOperation(env, scope, claim.operation));
      expect(projected).toMatchObject({
        status,
        nextAction: waitingFor === null ? null : { type: "wait", reason: waitingFor },
        error:
          status === "failed"
            ? { code: "TRANSACTION_FAILED", message: "Withdrawal request failed" }
            : null,
        result: { settlementOutcome: outcome },
      });
    }
  );
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
    expect(await advance()).toMatchObject({
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
    await expect(advance()).rejects.toBe(error);
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
