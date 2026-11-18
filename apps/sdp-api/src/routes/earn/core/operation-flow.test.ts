import { currentClusterScope, runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { MovementId } from "@sdp/types/movements";
import type { Operation } from "@sdp/types/operations";
import { operationResponseSchema } from "@sdp/types/operations";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createSignerFromKeyPair,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionEncoder,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnWalletTransactionsRepository,
  generateEarnWalletTransactionId,
} from "@/db/repositories/earn-wallet-transactions.repository";
import { app } from "@/index";
import { decideMovement, readMoneyAdmissionFacts } from "@/lib/money-admission";
import { AuditService } from "@/services/audit.service";
import { admittedSigner } from "@/services/domain/signing/admitted-signer";
import type {
  WalletDepositBuildInput,
  WalletWithdrawalBuildInput,
} from "@/services/earn/vault-wallet.service";
import { reconcileOperations } from "@/services/jobs/reconcile-operations";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
import {
  type EarnAuthzTenant,
  type EarnTestApiKey,
  seedEarnApiKey,
  seedEarnAuthzTenant,
} from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  withdrawBuild: vi.fn(),
  quoteWithdrawal: vi.fn(),
  withdrawalEnabled: false,
  sign: vi.fn(),
  proposer: vi.fn(),
  broadcast: vi.fn(),
  projectionFails: false,
}));
vi.mock("@/services/earn/vault-wallet.service", async (original) => ({
  ...(await original<typeof import("@/services/earn/vault-wallet.service")>()),
  buildWalletDepositTransaction: mocks.build,
  buildWalletWithdrawalTransaction: mocks.withdrawBuild,
}));
vi.mock("@/services/earn/execution-registry", async (original) => {
  const actual = await original<typeof import("@/services/earn/execution-registry")>();
  return {
    ...actual,
    resolveEarnExecutionClient: (...args: Parameters<typeof actual.resolveEarnExecutionClient>) =>
      mocks.withdrawalEnabled
        ? {
            provider: "kamino",
            buildVaultDeposit: vi.fn(),
            buildVaultWithdrawal: vi.fn(),
            readVaultPositions: vi.fn(),
            sponsoredPrograms: () => [],
            quoteVaultWithdrawal: mocks.quoteWithdrawal,
          }
        : actual.resolveEarnExecutionClient(...args),
  };
});
vi.mock("@/services/earn/vault-execution.service", async (original) => ({
  ...(await original<typeof import("@/services/earn/vault-execution.service")>()),
  broadcastVaultTransaction: mocks.broadcast,
}));
vi.mock("@/services/solana/signer", async (original) => ({
  ...(await original<typeof import("@/services/solana/signer")>()),
  createOrgSignerForCustodyWallet: mocks.sign,
  createOrgTransactionProposerForCustodyWallet: mocks.proposer,
}));
vi.mock("@/routes/earn/handlers/admission", async (original) => ({
  ...(await original<typeof import("@/routes/earn/handlers/admission")>()),
  assertVaultDepositAdmissible: async () => "kamino",
  assertRecordedStrategyDepositAdmitted: async () => undefined,
}));
vi.mock("@/routes/earn/strategy-catalogue", async (original) => ({
  ...(await original<typeof import("@/routes/earn/strategy-catalogue")>()),
  isEarnStrategyInExecutionShelf: () => true,
}));
vi.mock("@/services/earn/vault-intent-execution.service", async (original) => ({
  ...(await original<typeof import("@/services/earn/vault-intent-execution.service")>()),
  readConfirmedBlockHeight: async () => 50n,
}));
vi.mock("@/services/earn/strategy-operations.service", async (original) => {
  const actual = await original<typeof import("@/services/earn/strategy-operations.service")>();
  return {
    ...actual,
    projectEarnOperation: (...args: Parameters<typeof actual.projectEarnOperation>) => {
      if (mocks.projectionFails) throw new Error("Projection unavailable");
      return actual.projectEarnOperation(...args);
    },
  };
});

const TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
let tenant: EarnAuthzTenant;
let apiKey: EarnTestApiKey;
let strategyId: string;
let owner: string;
let keyPair: CryptoKeyPair;
let unsigned: string;
let signed: string;

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
  };
}

async function seedOperationScope(environment: SdpEnvironment) {
  const tag = `core_operation_flow_${environment}`;
  tenant = await seedEarnAuthzTenant(env, tag, { environment });
  apiKey = await seedEarnApiKey(env, tenant, {
    id: tag,
    grants: ["earn.read", "earn.execute", "earn.manage"],
    environment,
  });
  const strategy = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "kamino",
    providerReference: VAULT,
    name: "Test strategy",
    sourceKind: "defi",
    underlyingSource: null,
    depositMints: [TOKEN],
    shareMint: SHARE,
    apyType: "variable",
    currentApy: "0.04",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: {},
    status: "active",
    hostCluster: CLUSTER_BY_SDP_ENVIRONMENT[environment],
    environment,
  });
  if (strategy === null) throw new Error("Strategy fixture was not created");
  strategyId = strategy.id;
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.resetAllMocks();
  mocks.withdrawalEnabled = false;
  mocks.projectionFails = false;
  mocks.quoteWithdrawal.mockResolvedValue({
    assetsOut: "9.9",
    assetDecimals: 6,
    blockingIssues: [],
  });
  await seedOperationScope("sandbox");
  keyPair = await generateKeyPair();
  owner = await getAddressFromPublicKey(keyPair.publicKey);
  const bytes = await transaction("reviewed strategy deposit");
  unsigned = bytes.unsigned;
  signed = bytes.signed;
  mocks.broadcast.mockResolvedValue(undefined);
  mocks.build.mockImplementation(async (binding: Env, input: WalletDepositBuildInput) => ({
    kind: "built",
    built: await createPostgresEarnWalletTransactionsRepository(getDb(binding)).create({
      id: generateEarnWalletTransactionId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: currentClusterScope().environment,
      provider: input.provider,
      custodyWalletId: input.custodyWalletId,
      strategyId: input.strategyId,
      direction: "deposit",
      ownerAddress: input.ownerAddress,
      vaultAddress: input.providerReference,
      tokenMint: input.tokenMint,
      shareMint: input.shareMint,
      label: input.label,
      denomination: input.tokenMint,
      amountRequested: input.amount,
      minSharesOut: "1",
      createsShareAccount: false,
      unsignedTransaction: unsigned,
      lastValidBlockHeight: "100",
      createdBy: input.userId,
      initiatedByKeyId: input.apiKeyId,
    }),
  }));
  mocks.withdrawBuild.mockImplementation(async (binding: Env, input: WalletWithdrawalBuildInput) =>
    createPostgresEarnWalletTransactionsRepository(getDb(binding)).create({
      id: generateEarnWalletTransactionId(),
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: currentClusterScope().environment,
      provider: input.provider,
      direction: "withdrawal",
      positionId: input.positionId,
      custodyWalletId: input.custodyWalletId,
      ownerAddress: input.ownerAddress,
      vaultAddress: input.vaultAddress,
      tokenMint: input.tokenMint,
      shareMint: input.shareMint,
      label: input.label,
      denomination: input.shareMint,
      amountRequested: input.shares,
      createsShareAccount: false,
      unsignedTransaction: unsigned,
      lastValidBlockHeight: "100",
      createdBy: input.userId,
      initiatedByKeyId: input.apiKeyId,
    })
  );
});

function request(
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey?: string,
  authKey = apiKey
) {
  return app.request(
    `/v1/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${authKey.raw}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

async function readOperation(response: Response): Promise<Operation> {
  const body: unknown = await response.json();
  return z.object({ data: operationResponseSchema }).parse(body).data.operation;
}

async function prepare() {
  const response = await request(
    "earn/deposit",
    "POST",
    { strategyId, source: { ownerAddress: owner }, amount: { mint: TOKEN, value: "10" } },
    "prepare-one"
  );
  expect(response.status, await response.clone().text()).toBe(202);
  return readOperation(response);
}

const action = (operation: Operation, signedTransaction = signed) => ({
  actionId: operation.actionId,
  version: operation.version,
  signedTransaction,
});

async function unfinishedCounts() {
  return getDb(env).queryOne<{ movements: number; positions: number }>(
    "SELECT (SELECT count(*) FROM earn_movements) AS movements, (SELECT count(*) FROM earn_positions) AS positions"
  );
}

async function seedOperationCustodyWallet(tag: string, environment: SdpEnvironment = "sandbox") {
  const walletId = `cwlt_${tag}`;
  if (environment === "production") {
    await seedUnreadPrivyWallet(getDb(env), {
      organizationId: tenant.org.id,
      projectId: tenant.project.id,
      createdBy: tenant.user.id,
      custodyWalletId: walletId,
      walletId: `privy_${tag}`,
      publicKey: owner,
    });
    return walletId;
  }
  const configId = `cfg_${tag}`;
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: configId,
        organizationId: tenant.org.id,
        projectId: tenant.project.id,
        provider: "privy",
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: walletId,
        owner: { kind: "config", custodyConfigId: configId },
        walletId: `privy_${tag}`,
        publicKey: owner,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
  return walletId;
}

describe("Earn core operation HTTP flow", () => {
  it("blocks queued production deposits after entitlement loss while reads, cancellation and exits remain available", async () => {
    await seedOperationScope("production");
    const walletId = await seedOperationCustodyWallet("production_entitlement", "production");
    mocks.withdrawalEnabled = true;
    mocks.proposer.mockResolvedValue(null);
    const rawSigner = await createSignerFromKeyPair(keyPair);
    const providerSign = vi.fn(rawSigner.signTransactions);
    // Keep the actual custody admission wrapper and live database decision;
    // only the provider's signing port uses the generated test key.
    mocks.sign.mockImplementation(
      async (
        binding: Env,
        organizationId: string,
        projectId: string,
        custodyWalletId: string,
        movement: MovementId
      ) => {
        const scope = { organizationId, projectId };
        const subject = { custodyWalletId };
        return admittedSigner(
          { address: rawSigner.address, signTransactions: providerSign },
          async () =>
            decideMovement(
              movement,
              await readMoneyAdmissionFacts(binding, scope, movement, subject),
              subject
            ),
          { ...scope, ...subject, movement, provider: "privy", credential: null }
        );
      }
    );
    const depositBody = {
      strategyId,
      source: { walletId },
      amount: { mint: TOKEN, value: "10" },
    };
    const prepared = await request("earn/deposit", "POST", depositBody, "production-deposit");
    expect(prepared.status, await prepared.clone().text()).toBe(202);
    const deposit = await readOperation(prepared);
    const accepted = await request(
      `operations/${deposit.id}/execute`,
      "POST",
      { actionId: deposit.actionId, version: deposit.version },
      "queue-production-deposit"
    );
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect((await readOperation(accepted)).status).toBe("queued");
    const cancellable = await readOperation(
      await request("earn/deposit", "POST", depositBody, "cancel-production-deposit")
    );
    await getDb(env).execute("UPDATE organizations SET settings = ? WHERE id = ?", [
      JSON.stringify({ enableProductionProject: false }),
      tenant.org.id,
    ]);

    const refused = await request("earn/deposit", "POST", depositBody, "production-after-loss");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { message: "Production is not enabled for this organization" },
    });
    expect((await request("operations")).status).toBe(200);
    expect((await readOperation(await request(`operations/${deposit.id}`))).status).toBe("queued");
    const cancelled = await request(
      `operations/${cancellable.id}/cancel`,
      "POST",
      {},
      "cancel-after-production-loss"
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(202);
    expect((await readOperation(cancelled)).status).toBe("cancelled");

    const positionId = generateEarnPositionId();
    await getDb(env).execute(
      `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
      kind, custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at)
      VALUES (?, ?, ?, 'production', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Existing holding', sdp_iso_now())`,
      [positionId, tenant.org.id, tenant.project.id, walletId, VAULT, SHARE, TOKEN]
    );
    const exitResponse = await request(
      "earn/withdraw",
      "POST",
      { positionId, amount: { kind: "shares", value: "10" } },
      "exit-after-production-loss"
    );
    expect(exitResponse.status, await exitResponse.clone().text()).toBe(202);
    const exit = await readOperation(exitResponse);
    const exitAccepted = await request(
      `operations/${exit.id}/execute`,
      "POST",
      { actionId: exit.actionId, version: exit.version },
      "queue-exit-after-production-loss"
    );
    expect(exitAccepted.status, await exitAccepted.clone().text()).toBe(202);
    expect(providerSign).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();

    await expect(
      runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
        runInClusterScope({ projectId: null, environment: "production" }, () =>
          reconcileOperations(env)
        )
      )
    ).rejects.toThrow("1 operation recovery attempts failed");
    expect(await readOperation(await request(`operations/${deposit.id}`))).toMatchObject({
      status: "queued",
      error: { code: "FORBIDDEN", message: "Production is not enabled for this organization" },
    });
    expect(
      await getDb(env).queryOne(
        "SELECT signed_transaction, dispatch_started_at FROM operation_attempts WHERE operation_id = ?",
        [deposit.id]
      )
    ).toEqual({ signed_transaction: null, dispatch_started_at: null });
    expect((await readOperation(await request(`operations/${exit.id}`))).status).toBe("submitted");
    expect(providerSign).toHaveBeenCalledTimes(1);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(
      await getDb(env).queryMany("SELECT direction FROM earn_movements WHERE project_id = ?", [
        tenant.project.id,
      ])
    ).toEqual([{ direction: "withdrawal" }]);
  });

  it("prepares once, accepts exact owner-signed bytes asynchronously, then advances only in the worker", async () => {
    const operation = await prepare();
    expect(operation.status).toBe("prepared");
    expect(operation.nextAction).toMatchObject({ type: "sign_transaction", transaction: unsigned });
    const replay = await request(
      "earn/deposit",
      "POST",
      { strategyId, source: { ownerAddress: owner }, amount: { mint: TOKEN, value: "10" } },
      "prepare-one"
    );
    expect((await readOperation(replay)).id).toBe(operation.id);
    expect(mocks.build).toHaveBeenCalledTimes(1);
    const accepted = await request(
      `operations/${operation.id}/execute`,
      "POST",
      action(operation),
      "execute-one"
    );
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect(await readOperation(accepted)).toMatchObject({
      status: "queued",
      result: null,
      nextAction: { type: "wait" },
    });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(await unfinishedCounts()).toEqual({ movements: 0, positions: 0 });
    const stored = await getDb(env).queryOne<{
      signed_transaction: string;
      execution_requested_at: string | null;
    }>(
      "SELECT signed_transaction, execution_requested_at FROM operation_attempts WHERE operation_id = ?",
      [operation.id]
    );
    expect(stored?.signed_transaction).toBe(signed);
    expect(stored?.execution_requested_at).toBeTypeOf("string");
    const acceptedAudit = await getDb(env).queryOne<{ metadata: string; api_key_id: string }>(
      "SELECT metadata, api_key_id FROM audit_logs WHERE action = 'submit' AND resource_type = 'earn_operation' AND resource_id = ?",
      [operation.id]
    );
    expect(acceptedAudit?.api_key_id).toBe(apiKey.id);
    expect(JSON.parse(acceptedAudit?.metadata ?? "null")).toMatchObject({
      executionStage: "accepted",
      operationStatus: "queued",
      settlementObserved: false,
      sideEffectsPerformedByRequest: false,
      actionId: operation.actionId,
      version: operation.version,
    });
    const detail = await request(`operations/${operation.id}`);
    expect((await readOperation(detail)).status).toBe("queued");
    expect(mocks.broadcast).not.toHaveBeenCalled();

    await runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () => reconcileOperations(env))
    );
    const progressed = await readOperation(await request(`operations/${operation.id}`));
    expect(progressed.status).toBe("submitted");
    expect(progressed.resourceRef?.kind).toBe("earn.movement");
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(await unfinishedCounts()).toEqual({ movements: 1, positions: 1 });
  });

  it("prepares an existing legacy custody position withdrawal and queues it without any inline signer", async () => {
    mocks.withdrawalEnabled = true;
    const walletId = await seedOperationCustodyWallet("core_operation_existing");
    const positionId = generateEarnPositionId();
    // Legacy rows have the original vault identity and no canonical strategy id.
    await getDb(env).execute(
      `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
      kind, custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at)
      VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Existing holding', sdp_iso_now())`,
      [positionId, tenant.org.id, tenant.project.id, walletId, VAULT, SHARE, TOKEN]
    );
    const prepared = await request(
      "earn/withdraw",
      "POST",
      { positionId, amount: { kind: "shares", value: "10" } },
      "legacy-exit"
    );
    expect(prepared.status, await prepared.clone().text()).toBe(202);
    const operation = await readOperation(prepared);
    expect(operation).toMatchObject({
      kind: "earn.withdraw",
      status: "prepared",
      nextAction: { type: "execute" },
      intent: { positionId },
      terms: { estimate: { mint: TOKEN, value: "9.9" } },
    });
    expect(mocks.quoteWithdrawal).toHaveBeenCalledTimes(1);
    expect(mocks.withdrawBuild).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        positionId,
        custodyWalletId: walletId,
        ownerAddress: owner,
        shares: "10",
      })
    );
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    const accepted = await request(
      `operations/${operation.id}/execute`,
      "POST",
      {
        actionId: operation.actionId,
        version: operation.version,
      },
      "execute-legacy-exit"
    );
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect(await readOperation(accepted)).toMatchObject({ status: "queued", result: null });
    expect(await unfinishedCounts()).toEqual({ positions: 1, movements: 0 });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("leaves resolved proposal refusals for explicit review while fresh accepted work advances", async () => {
    const walletId = await seedOperationCustodyWallet("refused_operation");
    const refusedResponse = await request(
      "earn/deposit",
      "POST",
      { strategyId, source: { walletId }, amount: { mint: TOKEN, value: "10" } },
      "prepare-refused"
    );
    expect(refusedResponse.status, await refusedResponse.clone().text()).toBe(202);
    const refused = await readOperation(refusedResponse);
    const acceptedRefusal = await request(
      `operations/${refused.id}/execute`,
      "POST",
      { actionId: refused.actionId, version: refused.version },
      "refused-accepted"
    );
    expect(acceptedRefusal.status, await acceptedRefusal.clone().text()).toBe(202);
    await getDb(env).execute(
      `UPDATE operations SET status = 'awaiting_approval',
      resource_ref = ?::jsonb, error = ?::jsonb, updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`,
      [
        JSON.stringify({ kind: "custody.proposal_not_sent", id: "resolved-refusal" }),
        JSON.stringify({
          code: "SIGNING_REJECTED",
          message: "Proposal was not dispatched; review again",
        }),
        refused.id,
      ]
    );
    const before = await getDb(env).queryOne<{ fence: number }>(
      "SELECT fence FROM operations WHERE id = ?",
      [refused.id]
    );
    const freshResponse = await request(
      "earn/deposit",
      "POST",
      {
        strategyId,
        source: { ownerAddress: owner },
        amount: { mint: TOKEN, value: "10" },
      },
      "prepare-after-refusal"
    );
    expect(freshResponse.status, await freshResponse.clone().text()).toBe(202);
    const fresh = await readOperation(freshResponse);
    expect(
      (
        await request(
          `operations/${fresh.id}/execute`,
          "POST",
          action(fresh),
          "execute-after-refusal"
        )
      ).status
    ).toBe(202);
    await runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () => reconcileOperations(env))
    );
    expect((await readOperation(await request(`operations/${fresh.id}`))).status).toBe("submitted");
    expect((await readOperation(await request(`operations/${refused.id}`))).status).toBe(
      "awaiting_approval"
    );
    expect(
      await getDb(env).queryOne("SELECT fence FROM operations WHERE id = ?", [refused.id])
    ).toEqual(before);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
  });

  it("fails closed when deposit audit admission cannot persist", async () => {
    const operation = await prepare();
    const audit = vi
      .spyOn(AuditService.prototype, "beginCriticalWithin")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));
    const rejected = await request(
      `operations/${operation.id}/execute`,
      "POST",
      action(operation),
      "audit-down"
    );
    expect(rejected.status, await rejected.clone().text()).toBe(500);
    expect(audit).toHaveBeenCalledTimes(1);
    const attempt = await getDb(env).queryOne<{
      signed_transaction: string | null;
      execution_requested_at: string | null;
      audit_intent_id: string | null;
    }>(
      "SELECT signed_transaction, execution_requested_at, audit_intent_id FROM operation_attempts WHERE operation_id = ?",
      [operation.id]
    );
    expect(attempt).toEqual({
      signed_transaction: null,
      execution_requested_at: null,
      audit_intent_id: null,
    });
    expect((await readOperation(await request(`operations/${operation.id}`))).status).toBe(
      "prepared"
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
    audit.mockRestore();
    await runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () => reconcileOperations(env))
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(await unfinishedCounts()).toEqual({ positions: 0, movements: 0 });
    const retry = await request(
      `operations/${operation.id}/execute`,
      "POST",
      action(operation),
      "audit-recovered"
    );
    expect(retry.status, await retry.clone().text()).toBe(202);
    expect((await readOperation(retry)).status).toBe("queued");
  });

  it("replays accepted queued bytes after HTTP key loss without another attempt or audit", async () => {
    const operation = await prepare();
    const path = `operations/${operation.id}/execute`;
    const first = await request(path, "POST", action(operation), "accepted-first");
    expect(first.status, await first.clone().text()).toBe(202);
    const before = await getDb(env).queryOne(
      "SELECT id, signed_transaction, signature, execution_requested_at, audit_intent_id FROM operation_attempts WHERE operation_id = ?",
      [operation.id]
    );
    await getDb(env).execute("DELETE FROM idempotency_keys WHERE idempotency_key = ?", [
      "accepted-first",
    ]);
    for (const key of ["accepted-first", "accepted-new-key"]) {
      const replay = await request(path, "POST", action(operation), key);
      expect(replay.status, await replay.clone().text()).toBe(202);
      expect(await readOperation(replay)).toMatchObject({ id: operation.id, status: "queued" });
    }
    const different = await transaction("different signed financial instruction");
    const refused = await request(
      path,
      "POST",
      action(operation, different.signed),
      "accepted-wrong-body"
    );
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect(
      await getDb(env).queryOne(
        "SELECT id, signed_transaction, signature, execution_requested_at, audit_intent_id FROM operation_attempts WHERE operation_id = ?",
        [operation.id]
      )
    ).toEqual(before);
    expect(
      await getDb(env).queryOne(
        "SELECT count(*)::int AS count FROM operation_attempts WHERE operation_id = ?",
        [operation.id]
      )
    ).toEqual({ count: 1 });
    expect(
      await getDb(env).queryOne(
        "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'submit' AND resource_type = 'earn_operation' AND resource_id = ?",
        [operation.id]
      )
    ).toEqual({ count: 1 });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    expect(await unfinishedCounts()).toEqual({ positions: 0, movements: 0 });
  });

  it("does not replace an exposed address transaction after expiry without outcome evidence", async () => {
    const operation = await prepare();
    await getDb(env).execute(
      `UPDATE operations SET terms = jsonb_set(terms, '{expiresAt}', '"2020-01-01T00:00:00.000Z"') WHERE id = ?`,
      [operation.id]
    );
    const before = await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [
      operation.id,
    ]);
    const response = await request(
      `operations/${operation.id}/refresh`,
      "POST",
      {},
      "unsafe-address-refresh"
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "wallet_transaction_outcome_unknown" } },
    });
    expect(mocks.build).toHaveBeenCalledTimes(1);
    expect(
      await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [operation.id])
    ).toEqual(before);
    expect(
      await getDb(env).queryOne(
        "SELECT count(*)::int AS count FROM operation_attempts WHERE operation_id = ?",
        [operation.id]
      )
    ).toEqual({ count: 0 });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("keeps a committed cancellation response stable when its status projection fails", async () => {
    const operation = await prepare();
    mocks.projectionFails = true;
    const path = `operations/${operation.id}/cancel`;
    const response = await request(path, "POST", {}, "cancel-projection-failure");
    expect(response.status).toBe(500);
    const stored = await getDb(env).queryOne<{ cancel_requested_at: string | null }>(
      "SELECT cancel_requested_at FROM operations WHERE id = ?",
      [operation.id]
    );
    expect(stored?.cancel_requested_at).toBeTypeOf("string");
    mocks.projectionFails = false;
    const replay = await request(path, "POST", {}, "cancel-projection-failure");
    expect(replay.status).toBe(500);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a different signed message and stale action without queueing money work", async () => {
    const operation = await prepare();
    const forged = await transaction("different financial instructions");
    const rejected = await request(
      `operations/${operation.id}/execute`,
      "POST",
      action(operation, forged.signed),
      "forged-one"
    );
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    const stale = await request(
      `operations/${operation.id}/execute`,
      "POST",
      { ...action(operation), version: operation.version + 1 },
      "stale-one"
    );
    expect(stale.status, await stale.clone().text()).toBe(409);
    const stored = await getDb(env).queryOne<{
      signed_transaction: string | null;
      execution_requested_at: string | null;
    }>(
      "SELECT signed_transaction, execution_requested_at FROM operation_attempts WHERE operation_id = ?",
      [operation.id]
    );
    expect(stored).toEqual({ signed_transaction: null, execution_requested_at: null });
    expect((await readOperation(await request(`operations/${operation.id}`))).status).toBe(
      "prepared"
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("keeps address history owner-filtered and refuses another tenant's operation", async () => {
    const operation = await prepare();
    const unfiltered = await request("operations");
    expect(await unfiltered.json()).toMatchObject({ data: { operations: [] } });
    const scoped = await request(`operations?ownerAddress=${owner}`);
    expect(await scoped.json()).toMatchObject({ data: { operations: [{ id: operation.id }] } });
    const other = await seedEarnAuthzTenant(env, "core_operation_other", {
      environment: "sandbox",
    });
    const otherKey = await seedEarnApiKey(env, other, {
      id: "core_operation_other",
      grants: ["earn.read", "earn.execute"],
      environment: "sandbox",
    });
    expect(
      (await request(`operations/${operation.id}`, "GET", undefined, undefined, otherKey)).status
    ).toBe(404);
    expect(
      (
        await request(
          `operations/${operation.id}/execute`,
          "POST",
          action(operation),
          "other-one",
          otherKey
        )
      ).status
    ).toBe(404);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
