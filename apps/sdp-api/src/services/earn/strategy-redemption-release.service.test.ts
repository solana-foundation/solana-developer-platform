import { createHash } from "node:crypto";
import { runInClusterScope } from "@sdp/rpc/scope";
import { HASTRA_DEPLOYMENTS } from "@sdp/types/hastra-programs";
import { wellKnownMint } from "@sdp/types/well-known-tokens";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnWalletWithdrawalRequestTransactionRow } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import * as queueRepositories from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { conflict } from "@/lib/errors";
import * as operationServices from "@/services/operations.service";
import { env } from "@/test/helpers/env";
import {
  advanceCurrentRedemptionRelease,
  projectCurrentRedemptionRelease,
  submitCurrentRedemptionRelease,
} from "./strategy-redemption-release.service";
import * as execution from "./vault-execution.service";

const configuredDeployment = HASTRA_DEPLOYMENTS["mainnet-beta"];
const configuredUsdc = wellKnownMint("USDC", "mainnet-beta");
if (!configuredDeployment || !configuredUsdc) throw new Error("Missing Hastra test deployment");
const deployment = configuredDeployment;
const usdc = configuredUsdc;
const key = (value: string) => Buffer.from(getAddressEncoder().encode(address(value)));
const scope: OperationScope = {
  organizationId: "org",
  projectId: "project",
  environment: "production",
};
const scoped = <T>(work: () => T): T => runInClusterScope(scope, work);
const foreignProgram = "B8FDo5EGA2hZ7YMugcw8wPHUYDBQJfNkEYpduXFLHfdZ";
const timestamp = "2026-11-23T00:00:00.000Z";
const repository = queueRepositories.createPostgresEarnVaultWithdrawalRequestsRepository(env.db);
const operations = operationServices.createOperationsService(env);
let build: EarnWalletWithdrawalRequestTransactionRow;
let claim: OperationClaim;
let signed: string;

function projection() {
  return {
    position_id: build.position_id,
    strategy_id: build.strategy_id,
    custody_wallet_id: build.custody_wallet_id,
    owner_address: build.owner_address,
    source: { ownerAddress: build.owner_address },
    signature: claim.attempt.signature,
    release_finalized_at: build.release_finalized_at,
  };
}

function cancelledLogs(amount: bigint, program = deployment.vaultMintProgramAddress) {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(amount);
  const event = Buffer.concat([
    createHash("sha256").update("event:RedemptionCancelled").digest().subarray(0, 8),
    key(build.owner_address),
    data,
    key(deployment.wYldsMint),
    key(usdc),
  ]).toString("base64");
  return [`Program ${program} invoke [1]`, `Program data: ${event}`, `Program ${program} success`];
}

type Receipt = NonNullable<
  Awaited<ReturnType<NonNullable<Parameters<typeof advanceCurrentRedemptionRelease>[3]>>>
>;
function receiptWithLogs(logs = cancelledLogs(50_000_000n)): Receipt {
  return {
    signature: claim.attempt.signature,
    executionResultKnown: true,
    error: null,
    logs,
    blockTime: "1800000100",
  };
}

beforeEach(async () => {
  vi.spyOn(
    queueRepositories,
    "createPostgresEarnVaultWithdrawalRequestsRepository"
  ).mockReturnValue(repository);
  vi.spyOn(operationServices, "createOperationsService").mockReturnValue(operations);
  const keyPair = await generateKeyPair();
  const owner = await getAddressFromPublicKey(keyPair.publicKey);
  const [requestAddress] = await getProgramDerivedAddress({
    programAddress: address(deployment.vaultMintProgramAddress),
    seeds: [new TextEncoder().encode("redemption_request"), key(owner)],
  });
  const transaction = compileTransaction(
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
            programAddress: address(deployment.vaultMintProgramAddress),
            accounts: [],
            data: new Uint8Array([1]),
          },
          value
        )
    )
  );
  const authorized = await partiallySignTransaction([keyPair], transaction);
  signed = Buffer.from(getTransactionEncoder().encode(authorized)).toString("base64");
  build = {
    id: "release-build",
    organization_id: scope.organizationId,
    project_id: scope.projectId,
    environment: "production",
    provider: "hastra",
    custody_wallet_id: null,
    fee_mode: "wallet",
    operation_only: true,
    strategy_id: "strategy",
    position_id: "position",
    withdrawal_request_id: null,
    action: "cancel",
    mechanism: "operator_redemption",
    owner_address: owner,
    vault_address: deployment.primeMint,
    token_mint: usdc,
    share_mint: deployment.primeMint,
    request_address: requestAddress,
    shares: null,
    quoted_assets: null,
    share_decimals: 6,
    asset_decimals: 6,
    intermediate_mint: deployment.wYldsMint,
    intermediate_amount: null,
    discount_bps: null,
    maturity_timestamp: null,
    deadline_timestamp: null,
    fee_payer: owner,
    unsigned_transaction: Buffer.from(getTransactionEncoder().encode(transaction)).toString(
      "base64"
    ),
    last_valid_block_height: "100",
    consumed_action_id: null,
    consumed_attempt_id: "attempt",
    release_finalized_at: null,
    consumed_at: timestamp,
    created_by: null,
    initiated_by_key_id: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  claim = {
    operation: {
      id: "operation",
      kind: "earn.withdraw",
      status: "submitted",
      environment: "production",
      intent: { kind: "earn.withdraw", positionId: "position", amount: { kind: "all" } },
      actionId: "action",
      version: 1,
      nextAction: { type: "wait", reason: "Pending" },
      terms: { expiresAt: null, estimate: null, minimum: null, fees: null, options: [] },
      buildRef: { kind: "earn.queued_transaction", id: build.id },
      resourceRef: { kind: "earn.redemption_release", id: build.id },
      canCancel: false,
      cancelRequestedAt: null,
      error: null,
      result: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    attempt: {
      id: "attempt",
      operationId: "operation",
      actionId: "action",
      version: 1,
      principal: { kind: "member", userId: "member" },
      buildRef: { kind: "earn.queued_transaction", id: build.id },
      signedTransaction: signed,
      signature: getSignatureFromTransaction(authorized),
      lastValidBlockHeight: "100",
      dispatchStartedAt: null,
      executionRequestedAt: timestamp,
      auditIntentId: "audit",
      observationOnly: false,
      proposalBinding: null,
      resourceRef: { kind: "earn.redemption_release", id: build.id },
    },
    token: "lease",
    fence: 1,
    recoveryRequired: false,
    purpose: "execute",
  };
  vi.spyOn(repository, "getWalletTransaction").mockImplementation(async () => build);
  vi.spyOn(repository, "consumeCurrentRedemptionRelease").mockImplementation(async () => build);
  vi.spyOn(repository, "recordCurrentRedemptionReleaseFinalized").mockImplementation(async () => {
    build.release_finalized_at = timestamp;
    vi.mocked(env.db.queryOne).mockResolvedValue(projection());
    return build;
  });
  vi.spyOn(env.db, "queryOne").mockResolvedValue(projection());
  vi.spyOn(operations, "transition").mockImplementation(async (_scope, current, update) => ({
    ...current.operation,
    ...update,
  }));
  vi.spyOn(execution, "broadcastVaultTransaction").mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());

describe("current Hastra redemption release", () => {
  it.each([50_000_000n, 80_000_000n])(
    "releases replacement B after historical A closes, including amount %s",
    async (amount) => {
      // Neither the build nor finality path binds historical A or its amount.
      // The provider cancellation affects whichever owner request exists now.
      const read = vi.fn(async () => receiptWithLogs(cancelledLogs(amount)));
      const result = await scoped(() => advanceCurrentRedemptionRelease(env, scope, claim, read));
      expect(result).toMatchObject({
        status: "completed",
        result: {
          settledAmount: null,
          settlementOutcome: "recovered",
          signature: claim.attempt.signature,
        },
      });
      expect(repository.recordCurrentRedemptionReleaseFinalized).toHaveBeenCalledOnce();
      expect(env.db.queryOne).toHaveBeenCalledWith(
        expect.not.stringMatching(
          /JOIN earn_vault_withdrawal_requests|earn_movements|earn_vault_withdrawal_request_actions/
        ),
        [build.id, claim.operation.id, scope.organizationId, scope.projectId, scope.environment]
      );
    }
  );

  it("never treats a cancellation event amount as a payout", async () => {
    const result = await scoped(() =>
      advanceCurrentRedemptionRelease(env, scope, claim, async () =>
        receiptWithLogs(cancelledLogs(9_000_000_000n))
      )
    );
    expect(result.result?.settledAmount).toBeNull();
    expect(result.result?.settlementOutcome).toBe("recovered");
  });

  it.each(["foreign program", "wrong owner", "duplicate event"])(
    "keeps %s evidence pending",
    async (scenario) => {
      let logs = cancelledLogs(50_000_000n);
      if (scenario === "foreign program") logs = cancelledLogs(50_000_000n, foreignProgram);
      if (scenario === "wrong owner") {
        const owner = build.owner_address;
        build.owner_address = foreignProgram;
        logs = cancelledLogs(50_000_000n);
        build.owner_address = owner;
      }
      if (scenario === "duplicate event")
        logs = [...logs.slice(0, 2), logs[1] ?? "", ...logs.slice(2)];
      const result = await scoped(() =>
        advanceCurrentRedemptionRelease(env, scope, claim, async () => receiptWithLogs(logs))
      );
      expect(result).toMatchObject({
        status: "settling",
        result: { settlementOutcome: null, settledAmount: null },
      });
      expect(repository.recordCurrentRedemptionReleaseFinalized).not.toHaveBeenCalled();
    }
  );

  it("keeps a malformed authenticated mint unresolved", async () => {
    const logs = cancelledLogs(50_000_000n).map((line) => {
      if (!line.startsWith("Program data: ")) return line;
      const data = Buffer.from(line.slice(14), "base64");
      key(usdc).copy(data, 48);
      return `Program data: ${data.toString("base64")}`;
    });
    await expect(
      scoped(() =>
        advanceCurrentRedemptionRelease(env, scope, claim, async () => receiptWithLogs(logs))
      )
    ).rejects.toMatchObject({ code: "REQUEST_UNREADABLE" });
    expect(operations.transition).not.toHaveBeenCalled();
    expect(repository.recordCurrentRedemptionReleaseFinalized).not.toHaveBeenCalled();
  });

  it.each([
    "unknown signature",
    "missing metadata",
    "missing logs",
    "missing block time",
    "different signature",
  ])("keeps %s unresolved", async (scenario) => {
    const base = receiptWithLogs();
    const transaction: Receipt | null =
      scenario === "unknown signature"
        ? null
        : {
            ...base,
            executionResultKnown: scenario !== "missing metadata",
            logs: scenario === "missing logs" ? null : base.logs,
            blockTime: scenario === "missing block time" ? null : base.blockTime,
            signature: scenario === "different signature" ? "different-signature" : base.signature,
          };
    const result = await scoped(() =>
      advanceCurrentRedemptionRelease(env, scope, claim, async () => transaction)
    );
    expect(result.status).toBe("settling");
    expect(repository.recordCurrentRedemptionReleaseFinalized).not.toHaveBeenCalled();
  });

  it("keeps an RPC error unresolved", async () => {
    await expect(
      scoped(() =>
        advanceCurrentRedemptionRelease(env, scope, claim, async () => {
          throw new Error("RPC unavailable");
        })
      )
    ).rejects.toThrow("RPC unavailable");
    expect(operations.transition).not.toHaveBeenCalled();
    expect(repository.recordCurrentRedemptionReleaseFinalized).not.toHaveBeenCalled();
  });

  it("fails only the exact finalized signature with a known chain error", async () => {
    const transaction = receiptWithLogs();
    const result = await scoped(() =>
      advanceCurrentRedemptionRelease(env, scope, claim, async () => ({
        ...transaction,
        error: { InstructionError: [0, { Custom: 1 }] },
      }))
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "TRANSACTION_FAILED" },
      result: { settlementOutcome: null, settledAmount: null },
    });
    expect(repository.recordCurrentRedemptionReleaseFinalized).not.toHaveBeenCalled();
  });

  it("retries a persisted finality receipt without another RPC read", async () => {
    build.release_finalized_at = timestamp;
    vi.mocked(env.db.queryOne).mockResolvedValue(projection());
    const read = vi.fn(async () => null);
    const result = await scoped(() => advanceCurrentRedemptionRelease(env, scope, claim, read));
    expect(result.status).toBe("completed");
    expect(read).not.toHaveBeenCalled();
    expect(repository.recordCurrentRedemptionReleaseFinalized).not.toHaveBeenCalled();
  });

  it("projects a completed replay without reacquiring its released PDA fence", async () => {
    build.release_finalized_at = timestamp;
    claim.operation.status = "completed";
    vi.mocked(env.db.queryOne).mockResolvedValue(projection());
    const read = vi.fn(async () => null);
    expect(
      (await scoped(() => advanceCurrentRedemptionRelease(env, scope, claim, read))).status
    ).toBe("completed");
    expect(repository.consumeCurrentRedemptionRelease).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("does not reopen a terminal failed operation from a receipt", async () => {
    claim.operation.status = "failed";
    build.release_finalized_at = timestamp;
    vi.mocked(env.db.queryOne).mockResolvedValue(projection());
    const result = await projectCurrentRedemptionRelease(env, scope, claim.operation, build.id);
    expect(result.status).toBe("failed");
    expect(result.result?.settlementOutcome).toBeNull();
  });

  it("checks canonical projection source", async () => {
    vi.mocked(env.db.queryOne).mockResolvedValue({
      ...projection(),
      source: { ownerAddress: foreignProgram },
    });
    await expect(
      projectCurrentRedemptionRelease(env, scope, claim.operation, build.id)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("consumes exact accepted signed bytes before broadcasting", async () => {
    expect(
      await scoped(() =>
        submitCurrentRedemptionRelease(env, {
          scope,
          buildId: build.id,
          attemptId: claim.attempt.id,
          signedTransaction: signed,
          broadcast: true,
        })
      )
    ).toEqual({ kind: "earn.redemption_release", id: build.id });
    expect(repository.consumeCurrentRedemptionRelease).toHaveBeenCalledWith({
      ...scope,
      transactionId: build.id,
      attemptId: claim.attempt.id,
      signature: claim.attempt.signature,
      signedTransaction: signed,
    });
    expect(
      vi.mocked(repository.consumeCurrentRedemptionRelease).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(execution.broadcastVaultTransaction).mock.invocationCallOrder[0] ?? 0);
  });

  it("does not broadcast an unowned attempt", async () => {
    vi.mocked(repository.consumeCurrentRedemptionRelease).mockRejectedValue(
      conflict("Different accepted attempt")
    );
    await expect(
      scoped(() =>
        submitCurrentRedemptionRelease(env, {
          scope,
          buildId: build.id,
          attemptId: "other-attempt",
          signedTransaction: signed,
          broadcast: true,
        })
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(execution.broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("does not broadcast during observation-only adoption", async () => {
    await scoped(() =>
      submitCurrentRedemptionRelease(env, {
        scope,
        buildId: build.id,
        attemptId: claim.attempt.id,
        signedTransaction: signed,
        broadcast: false,
      })
    );
    expect(execution.broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("leaves a broadcast timeout unresolved with the consumed signed attempt", async () => {
    vi.mocked(execution.broadcastVaultTransaction).mockRejectedValue(
      new Error("Broadcast timed out")
    );
    await expect(
      scoped(() =>
        submitCurrentRedemptionRelease(env, {
          scope,
          buildId: build.id,
          attemptId: claim.attempt.id,
          signedTransaction: signed,
          broadcast: true,
        })
      )
    ).rejects.toThrow("Broadcast timed out");
    expect(repository.consumeCurrentRedemptionRelease).toHaveBeenCalledOnce();
    expect(operations.transition).not.toHaveBeenCalled();
  });
});
