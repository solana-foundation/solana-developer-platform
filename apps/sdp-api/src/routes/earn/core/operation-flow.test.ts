import { SigningError } from "@sdp/custody/signing";
import { currentClusterScope, runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { MovementId } from "@sdp/types/movements";
import type { Operation } from "@sdp/types/operations";
import { operationResponseSchema } from "@sdp/types/operations";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import { CLUSTER_BY_SDP_ENVIRONMENT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
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
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import {
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import {
  createPostgresEarnWalletTransactionsRepository,
  generateEarnWalletTransactionId,
} from "@/db/repositories/earn-wallet-transactions.repository";
import { app } from "@/index";
import { AppError } from "@/lib/errors";
import { decideMovement, readMoneyAdmissionFacts } from "@/lib/money-admission";
import * as meteredQuota from "@/middleware/metered-quota";
import * as admission from "@/routes/earn/handlers/admission";
import * as catalogue from "@/routes/earn/strategy-catalogue";
import { AuditService } from "@/services/audit.service";
import { admittedSigner } from "@/services/custody/signing/admitted-signer";
import * as executionRegistry from "@/services/earn/execution-registry";
import * as observationRpc from "@/services/earn/operation-observation-rpc";
import * as strategyMint from "@/services/earn/strategy-mint";
import type {
  prepareCurrentRedemptionRelease,
  prepareQueuedStrategyRecovery,
} from "@/services/earn/strategy-queued-operations.service";
import * as queuedOperations from "@/services/earn/strategy-queued-operations.service";
import * as vaultExecution from "@/services/earn/vault-execution.service";
import * as intentExecution from "@/services/earn/vault-intent-execution.service";
import type {
  WalletDepositBuildInput,
  WalletWithdrawalBuildInput,
} from "@/services/earn/vault-wallet.service";
import * as vaultWallet from "@/services/earn/vault-wallet.service";
import { reconcileOperations } from "@/services/jobs/reconcile-operations";
import * as signers from "@/services/solana/signer";
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

/** Switches a test flips, beside the collaborators it replaces. */
interface FlowSwitches {
  recoveryRequest: EarnVaultWithdrawalRequestRow | null;
  withdrawalEnabled: boolean;
  withdrawalChoices: boolean;
  directWithdrawalAvailable: boolean;
}
const mocks: FlowSwitches &
  Record<
    | "build"
    | "withdrawBuild"
    | "quoteWithdrawal"
    | "readPositions"
    | "choiceReads"
    | "recoveryBuild"
    | "releaseBuild"
    | "sign"
    | "proposer"
    | "broadcast",
    Mock
  > = {
  build: vi.fn(),
  withdrawBuild: vi.fn(),
  quoteWithdrawal: vi.fn(),
  readPositions: vi.fn(),
  choiceReads: vi.fn(),
  recoveryBuild: vi.fn(),
  releaseBuild: vi.fn(),
  recoveryRequest: null,
  withdrawalEnabled: false,
  withdrawalChoices: false,
  directWithdrawalAvailable: true,
  sign: vi.fn(),
  proposer: vi.fn(),
  broadcast: vi.fn(),
};
// Captured before any spy replaces them, so a fake can fall back to the real behavior.
const actualResolveClient = executionRegistry.resolveEarnExecutionClient;
const actualPrepareChoices = queuedOperations.prepareStrategyWithdrawalChoices;

/** The configured strategy's client, or a Kamino stand-in while a test enables withdrawals. */
function resolveFlowClient(...args: Parameters<typeof actualResolveClient>) {
  if (!mocks.withdrawalEnabled) return actualResolveClient(...args);
  const client = {
    provider: "kamino",
    buildVaultDeposit: vi.fn(),
    buildVaultWithdrawal: vi.fn(),
    readVaultPositions: mocks.readPositions,
    sponsoredPrograms: () => [],
    quoteVaultWithdrawal: mocks.quoteWithdrawal,
  };
  return client;
}

/** Withdrawal routes a test configures; anything else reads the real provider routes. */
function prepareFlowChoices(...args: Parameters<typeof actualPrepareChoices>) {
  mocks.choiceReads(...args);
  if (mocks.recoveryRequest !== null) {
    const request = mocks.recoveryRequest;
    if (request.mechanism === "operator_redemption") {
      const id = "release_current_redemption";
      const choice = {
        id,
        kind: "recovery" as const,
        currentRedemptionRelease: {
          request,
          plan: {
            cluster: "devnet" as const,
            instructions: [],
            lookupTables: [],
            assetIdentity: {
              depositTokenMint: request.token_mint,
              shareMint: request.share_mint,
            },
          },
        },
        option: {
          id,
          label: "Release current pending redemption",
          settlement: "instant" as const,
          estimatedSeconds: null,
          mechanism: id,
          minimum: null,
        },
      };
      return Promise.resolve({ choices: [choice], options: [choice.option] });
    }
    const id = `recover_expired_escrow:${request.id}`;
    const choice = {
      id,
      kind: "recovery" as const,
      recovery: request,
      option: {
        id,
        label: "Recover expired escrowed shares",
        settlement: "instant" as const,
        estimatedSeconds: null,
        mechanism: "recover_expired_escrow",
        amount: { mint: request.share_mint, value: request.shares },
        minimum: { mint: request.share_mint, value: request.shares },
      },
    };
    return Promise.resolve({ choices: [choice], options: [choice.option] });
  }
  if (!mocks.withdrawalChoices) return actualPrepareChoices(...args);
  const choices = [
    ...(mocks.directWithdrawalAvailable
      ? [
          {
            id: "direct",
            kind: "direct" as const,
            option: {
              id: "direct",
              label: "Direct withdrawal",
              settlement: "instant" as const,
              estimatedSeconds: null,
            },
          },
        ]
      : []),
    {
      id: "queued",
      kind: "queued" as const,
      option: {
        id: "queued",
        label: "Delayed withdrawal",
        settlement: "delayed" as const,
        estimatedSeconds: null,
      },
    },
  ];
  return Promise.resolve({ choices, options: choices.map((choice) => choice.option) });
}

/**
 * Real modules with spies on the boundaries this suite replaces: transaction builders, provider
 * routes and broadcasts, custody signers, deposit admission and the chain height.
 */
function spyOnFlowBoundaries() {
  vi.spyOn(vaultWallet, "buildWalletDepositTransaction").mockImplementation(mocks.build);
  vi.spyOn(vaultWallet, "buildWalletWithdrawalTransaction").mockImplementation(mocks.withdrawBuild);
  vi.mocked(vi.spyOn(executionRegistry, "resolveEarnExecutionClient"), {
    partial: true,
  }).mockImplementation(resolveFlowClient);
  vi.spyOn(vaultExecution, "broadcastVaultTransaction").mockImplementation(mocks.broadcast);
  vi.spyOn(queuedOperations, "prepareQueuedStrategyRecovery").mockImplementation(
    mocks.recoveryBuild
  );
  vi.spyOn(queuedOperations, "prepareCurrentRedemptionRelease").mockImplementation(
    mocks.releaseBuild
  );
  vi.mocked(vi.spyOn(queuedOperations, "prepareStrategyWithdrawalChoices"), {
    partial: true,
    deep: true,
  }).mockImplementation(prepareFlowChoices);
  vi.spyOn(signers, "createOrgSignerForCustodyWallet").mockImplementation(mocks.sign);
  vi.spyOn(signers, "createOrgTransactionProposerForCustodyWallet").mockImplementation(
    mocks.proposer
  );
  vi.spyOn(admission, "assertVaultDepositAdmissible").mockResolvedValue("kamino");
  vi.spyOn(admission, "assertRecordedStrategyDepositAdmitted").mockResolvedValue(undefined);
  vi.spyOn(catalogue, "isEarnStrategyInExecutionShelf").mockReturnValue(true);
  vi.spyOn(intentExecution, "readConfirmedBlockHeight").mockResolvedValue(50n);
}
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
let requestEnv: Env = env;

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

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  requestEnv = env;
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.resetAllMocks();
  spyOnFlowBoundaries();
  // Chain observations are this suite's boundary: nothing is seen landing or expiring.
  vi.spyOn(observationRpc, "createOperationObservationRpc").mockReturnValue({
    confirmedHeight: async () => 50n,
    hasSignature: async () => false,
    unsentVerdict: async () => "pending",
  });
  mocks.withdrawalEnabled = false;
  mocks.withdrawalChoices = false;
  mocks.directWithdrawalAvailable = true;
  mocks.recoveryRequest = null;
  mocks.readPositions.mockResolvedValue([]);
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
    requestEnv
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
  it.each(["true", "false"])(
    "blocks production deposit submissions and refreshes after entitlement loss with sandbox access %s",
    async (sandboxAllowed) => {
      requestEnv = { ...env, SDP_ALLOW_SANDBOX_PROJECTS: sandboxAllowed };
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
        `operations/${deposit.id}/submit`,
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
      const buildsBeforeRefusal = mocks.build.mock.calls.length;
      for (const route of ["submit", "refresh"]) {
        const response = await request(
          `operations/${cancellable.id}/${route}`,
          "POST",
          { actionId: cancellable.actionId, version: cancellable.version },
          `${route}-after-production-loss`
        );
        expect(response.status, await response.clone().text()).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { message: "Production is not enabled for this organization" },
        });
      }
      expect(mocks.build).toHaveBeenCalledTimes(buildsBeforeRefusal);
      expect(
        await getDb(env).queryOne(
          "SELECT count(*)::int AS count FROM operation_attempts WHERE operation_id = ?",
          [cancellable.id]
        )
      ).toEqual({ count: 0 });
      expect((await request("operations")).status).toBe(200);
      expect((await readOperation(await request(`operations/${deposit.id}`))).status).toBe(
        "queued"
      );
      const cancelled = await request(
        `operations/${cancellable.id}/cancel`,
        "POST",
        {},
        "cancel-after-production-loss"
      );
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
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
        `operations/${exit.id}/submit`,
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
            reconcileOperations(requestEnv)
          )
        )
      ).resolves.toBeUndefined();
      expect(await readOperation(await request(`operations/${deposit.id}`))).toMatchObject({
        status: "failed",
        error: { code: "SIGNING_REJECTED" },
      });
      expect(
        await getDb(env).queryOne(
          "SELECT signed_transaction, dispatch_started_at, observation_only FROM operation_attempts WHERE operation_id = ?",
          [deposit.id]
        )
      ).toEqual({ signed_transaction: null, dispatch_started_at: null, observation_only: true });
      expect((await readOperation(await request(`operations/${exit.id}`))).status).toBe(
        "submitted"
      );
      expect(providerSign).toHaveBeenCalledTimes(1);
      expect(mocks.broadcast).toHaveBeenCalledTimes(1);
      expect(
        await getDb(env).queryMany("SELECT direction FROM earn_movements WHERE project_id = ?", [
          tenant.project.id,
        ])
      ).toEqual([{ direction: "withdrawal" }]);
    }
  );

  it("meters deposit refreshes while withdrawal selection remains available", async () => {
    const walletId = await seedOperationCustodyWallet("refresh_quota");
    const deposit = await readOperation(
      await request(
        "earn/deposit",
        "POST",
        { strategyId, source: { walletId }, amount: { mint: TOKEN, value: "10" } },
        "prepare-metered-refresh"
      )
    );
    const quota = vi
      .spyOn(meteredQuota, "enforceMeteredQuota")
      .mockRejectedValue(new AppError("RATE_LIMITED", "Provider-read quota exceeded"));
    try {
      const response = await request(
        `operations/${deposit.id}/refresh`,
        "POST",
        { actionId: deposit.actionId, version: deposit.version },
        "metered-deposit-refresh"
      );
      expect(response.status, await response.clone().text()).toBe(429);
      expect(quota).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        name: "earn-provider-read",
        actorMax: 60,
        orgMax: 240,
      });
      expect(mocks.build).toHaveBeenCalledTimes(1);

      mocks.withdrawalChoices = true;
      const positionId = generateEarnPositionId();
      await getDb(env).execute(
        `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
         kind, custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at)
         VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Existing holding', sdp_iso_now())`,
        [positionId, tenant.org.id, tenant.project.id, walletId, VAULT, SHARE, TOKEN]
      );
      const withdrawal = await readOperation(
        await request(
          "earn/withdraw",
          "POST",
          { positionId, amount: { kind: "shares", value: "1" } },
          "prepare-exit-during-quota"
        )
      );
      expect(withdrawal.nextAction?.type).toBe("select_option");
      const selected = await request(
        `operations/${withdrawal.id}/refresh`,
        "POST",
        { actionId: withdrawal.actionId, version: withdrawal.version, optionId: "direct" },
        "select-exit-during-quota"
      );
      expect(selected.status, await selected.clone().text()).toBe(202);
      expect(mocks.withdrawBuild).toHaveBeenCalledTimes(1);
      expect(quota).toHaveBeenCalledTimes(1);
    } finally {
      quota.mockRestore();
    }
    const retry = await request(
      `operations/${deposit.id}/refresh`,
      "POST",
      { actionId: deposit.actionId, version: deposit.version },
      "metered-deposit-refresh"
    );
    expect(retry.status, await retry.clone().text()).toBe(202);
    expect(mocks.build).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "zero"])(
    "prepares a separate escrow recovery with a %s wallet balance and retains its custody source",
    async (walletBalance) => {
      const walletId = await seedOperationCustodyWallet(`escrow_recovery_${walletBalance}`);
      const positionId = generateEarnPositionId();
      const requestId = `request_expired_${walletBalance}`;
      await getDb(env).execute(
        `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
         kind, custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at)
         VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Escrow holding', sdp_iso_now())`,
        [positionId, tenant.org.id, tenant.project.id, walletId, VAULT, SHARE, TOKEN]
      );
      await getDb(env).execute(
        `INSERT INTO earn_vault_withdrawal_requests (
         id, organization_id, project_id, environment, provider, position_id,
         custody_wallet_id, owner_address, vault_address, token_mint, share_mint,
         request_address, status, shares, quoted_assets, share_decimals, asset_decimals,
         discount_bps, nonce, creation_timestamp, provider_state_observed,
         maturity_timestamp, deadline_timestamp, client_request_id, idempotency_fingerprint,
         creation_signature)
         VALUES (?, ?, ?, 'sandbox', 'kamino', ?, ?, ?, ?, ?, ?, ?, 'expired_cancelable',
                 '10', '9.9', 6, 6, 25, 7, 1700000000, TRUE, 1700000060, 1700000120,
                 'original-exit', 'original-fingerprint', 'original-signature')`,
        [
          requestId,
          tenant.org.id,
          tenant.project.id,
          positionId,
          walletId,
          owner,
          VAULT,
          TOKEN,
          SHARE,
          VAULT,
        ]
      );
      const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
      const originalRequest = await repository.getById({
        organizationId: tenant.org.id,
        environment: "sandbox",
        withdrawalRequestId: requestId,
      });
      if (originalRequest === null) throw new Error("Missing expired request fixture");
      mocks.recoveryRequest = originalRequest;
      mocks.withdrawalEnabled = true;
      mocks.readPositions.mockResolvedValue(
        walletBalance === "missing"
          ? []
          : [
              {
                providerReference: VAULT,
                owner,
                tokenMint: TOKEN,
                shareMint: SHARE,
                cluster: "devnet",
                shares: "0",
              },
            ]
      );
      mocks.recoveryBuild.mockImplementation(
        async (binding: Env, input: Parameters<typeof prepareQueuedStrategyRecovery>[1]) => {
          const build = await createPostgresEarnVaultWithdrawalRequestsRepository(
            getDb(binding)
          ).createWalletTransaction({
            id: `recovery_build_${walletBalance}`,
            organizationId: input.actor.organizationId,
            projectId: input.actor.projectId,
            environment: "sandbox",
            provider: input.position.provider,
            positionId: input.position.id,
            custodyWalletId: input.custodyWalletId,
            withdrawalRequestId: input.request.id,
            action: "cancel",
            mechanism: "solver_queue",
            ownerAddress: input.position.ownerAddress,
            vaultAddress: input.position.vaultAddress,
            tokenMint: input.position.tokenMint,
            shareMint: input.position.shareMint,
            requestAddress: input.request.request_address,
            unsignedTransaction: unsigned,
            lastValidBlockHeight: "100",
            operationOnly: true,
          });
          return {
            id: build.id,
            unsignedTransaction: unsigned,
            lastValidBlockHeight: "100",
            ownerAddress: build.owner_address,
            custodyWalletId: build.custody_wallet_id ?? null,
            feeMode: build.fee_mode ?? "wallet",
            feePayer: build.fee_payer,
            action: build.action,
            build,
          } satisfies Awaited<ReturnType<typeof prepareQueuedStrategyRecovery>>;
        }
      );

      const override = await request(
        "earn/withdraw",
        "POST",
        { positionId, amount: { kind: "all" }, source: { walletId: "another_wallet" } },
        "recovery-source-override"
      );
      expect(override.status).toBe(400);
      const response = await request(
        "earn/withdraw",
        "POST",
        { positionId, amount: { kind: "all" } },
        "prepare-escrow-recovery"
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const operation = await readOperation(response);
      const storedSource = () =>
        getDb(env).queryOne("SELECT source FROM operations WHERE id = ?", [operation.id]);
      expect(await storedSource()).toEqual({ source: { walletId } });
      expect(operation.nextAction).toEqual({ type: "select_option" });
      expect(operation.terms.options).toHaveLength(1);
      expect(operation.terms.options[0]).toMatchObject({
        id: `recover_expired_escrow:${requestId}`,
        mechanism: "recover_expired_escrow",
        minimum: { mint: SHARE, value: "10" },
      });
      expect(mocks.recoveryBuild).not.toHaveBeenCalled();
      expect(mocks.choiceReads).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          position: expect.objectContaining({
            id: positionId,
            custodyWalletId: walletId,
            ownerAddress: owner,
          }),
          shares: undefined,
          recovery: {
            actor: expect.objectContaining({
              organizationId: tenant.org.id,
              projectId: tenant.project.id,
            }),
          },
        })
      );

      const selected = await request(
        `operations/${operation.id}/refresh`,
        "POST",
        {
          actionId: operation.actionId,
          version: operation.version,
          optionId: `recover_expired_escrow:${requestId}`,
        },
        "select-escrow-recovery"
      );
      expect(selected.status, await selected.clone().text()).toBe(202);
      const reviewed = await readOperation(selected);
      expect(await storedSource()).toEqual({ source: { walletId } });
      expect(mocks.recoveryBuild.mock.calls[0]?.[1]).toMatchObject({
        custodyWalletId: walletId,
        position: { id: positionId, custodyWalletId: walletId, ownerAddress: owner },
        request: { id: requestId },
      });
      expect(reviewed.nextAction).toEqual({ type: "submit" });
      expect(reviewed.actionId).not.toBe(operation.actionId);
      expect(reviewed.version).toBe(operation.version + 1);
      const submitted = await request(
        `operations/${operation.id}/submit`,
        "POST",
        { actionId: reviewed.actionId, version: reviewed.version },
        "submit-escrow-recovery"
      );
      expect(submitted.status, await submitted.clone().text()).toBe(202);
      expect((await readOperation(submitted)).status).toBe("queued");
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalled();
      expect(
        await repository.getById({
          organizationId: tenant.org.id,
          environment: "sandbox",
          withdrawalRequestId: requestId,
        })
      ).toEqual(originalRequest);
    }
  );

  it.each(["owner", "custody"] as const)(
    "explicitly reviews a current Hastra release with all wYLDS delegated through %s signing",
    async (source) => {
      const primeMint = "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7";
      const wYldsMint = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
      const walletId =
        source === "custody" ? await seedOperationCustodyWallet("current_release") : null;
      const positionId = generateEarnPositionId();
      await getDb(env).execute(
        `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
         kind, custody_wallet_id, owner_address, vault_address, share_mint, token_mint,
         label, activated_at)
         VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, ?,
                 'Hastra holding', sdp_iso_now())`,
        [
          positionId,
          tenant.org.id,
          tenant.project.id,
          walletId,
          walletId ? null : owner,
          primeMint,
          primeMint,
          TOKEN,
        ]
      );
      const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
      const seedRequest = async (id: string) => {
        await getDb(env).execute(
          `INSERT INTO earn_vault_withdrawal_requests (
           id, organization_id, project_id, environment, provider, position_id,
           custody_wallet_id, owner_address, vault_address, token_mint, share_mint,
           request_address, status, mechanism, shares, quoted_assets, share_decimals,
           asset_decimals, intermediate_mint, intermediate_amount, provider_state_observed,
           client_request_id, idempotency_fingerprint, creation_signature)
           VALUES (?, ?, ?, 'sandbox', 'hastra', ?, ?, ?, ?, ?, ?, ?, 'pending',
                   'operator_redemption', '0', '2000', 6, 6, ?, '2000', TRUE, ?, ?, ?)`,
          [
            id,
            tenant.org.id,
            tenant.project.id,
            positionId,
            walletId,
            owner,
            primeMint,
            TOKEN,
            primeMint,
            VAULT,
            wYldsMint,
            id,
            `${id}_fingerprint`,
            `${id}_signature`,
          ]
        );
        const row = await repository.getById({
          organizationId: tenant.org.id,
          environment: "sandbox",
          withdrawalRequestId: id,
        });
        if (row === null) throw new Error("Missing pending redemption fixture");
        return row;
      };
      const requestA = await seedRequest("redemption_a");
      mocks.recoveryRequest = requestA;
      mocks.withdrawalEnabled = true;
      mocks.readPositions.mockResolvedValue([
        {
          providerReference: primeMint,
          owner,
          tokenMint: TOKEN,
          shareMint: primeMint,
          cluster: "devnet",
          shares: "0",
          parIntermediate: {
            mint: wYldsMint,
            amount: "2000",
            withdrawableAmount: "0",
            tokenValue: "2000",
          },
        },
      ]);
      mocks.releaseBuild.mockImplementation(
        async (binding: Env, input: Parameters<typeof prepareCurrentRedemptionRelease>[1]) => {
          const build = await createPostgresEarnVaultWithdrawalRequestsRepository(
            getDb(binding)
          ).createWalletTransaction({
            id: `release_build_${source}`,
            organizationId: input.actor.organizationId,
            projectId: input.actor.projectId,
            environment: "sandbox",
            provider: input.position.provider,
            positionId: input.position.id,
            custodyWalletId: input.custodyWalletId,
            action: "cancel",
            mechanism: "operator_redemption",
            shareDecimals: input.request.share_decimals,
            assetDecimals: input.request.asset_decimals,
            intermediateMint: wYldsMint,
            ownerAddress: input.position.ownerAddress,
            vaultAddress: input.position.vaultAddress,
            tokenMint: input.position.tokenMint,
            shareMint: input.position.shareMint,
            requestAddress: input.request.request_address,
            unsignedTransaction: unsigned,
            lastValidBlockHeight: "100",
            operationOnly: true,
          });
          return {
            id: build.id,
            unsignedTransaction: unsigned,
            lastValidBlockHeight: "100",
            ownerAddress: build.owner_address,
            custodyWalletId: build.custody_wallet_id ?? null,
            feeMode: build.fee_mode ?? "wallet",
            feePayer: build.fee_payer,
            action: build.action,
            build,
          } satisfies Awaited<ReturnType<typeof prepareCurrentRedemptionRelease>>;
        }
      );

      const override = await request(
        "earn/withdraw",
        "POST",
        { positionId, amount: { kind: "all" }, source: { ownerAddress: VAULT } },
        "release-source-override"
      );
      expect(override.status).toBe(400);
      const response = await request(
        "earn/withdraw",
        "POST",
        { positionId, amount: { kind: "all" } },
        "prepare-release"
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const operation = await readOperation(response);
      expect(operation.nextAction).toEqual({ type: "select_option" });
      expect(operation.terms.options).toEqual([
        expect.objectContaining({
          id: "release_current_redemption",
          mechanism: "release_current_redemption",
          minimum: null,
        }),
      ]);
      expect(operation.terms.options[0]).not.toHaveProperty("amount");
      expect(mocks.releaseBuild).not.toHaveBeenCalled();
      const premature = await request(
        `operations/${operation.id}/submit`,
        "POST",
        { actionId: operation.actionId, version: operation.version },
        "release-before-review"
      );
      expect(premature.status).toBe(409);

      // Hastra reuses this address. The reviewed option follows current state,
      // while each historical request retains its own settlement outcome.
      await getDb(env).execute(
        "UPDATE earn_vault_withdrawal_requests SET status = 'fulfilled', fulfilled_at = sdp_iso_now(), closing_signature = 'fulfilled_a' WHERE id = ?",
        [requestA.id]
      );
      const requestB = await seedRequest("redemption_b");
      mocks.recoveryRequest = requestB;
      const requestSnapshots = await getDb(env).queryMany(
        "SELECT * FROM earn_vault_withdrawal_requests ORDER BY id"
      );
      const selected = await request(
        `operations/${operation.id}/refresh`,
        "POST",
        {
          actionId: operation.actionId,
          version: operation.version,
          optionId: "release_current_redemption",
        },
        "select-release"
      );
      expect(selected.status, await selected.clone().text()).toBe(202);
      const reviewed = await readOperation(selected);
      expect(reviewed.terms).toMatchObject({ inputAmount: null, estimate: null, minimum: null });
      expect(reviewed.nextAction).toMatchObject({
        type: source === "custody" ? "submit" : "sign_transaction",
      });
      expect(mocks.releaseBuild.mock.calls[0]?.[1]).toMatchObject({
        actor: { organizationId: tenant.org.id, projectId: tenant.project.id },
        position: { id: positionId, ownerAddress: owner },
        request: { id: requestB.id },
      });
      const otherKey = await seedEarnApiKey(env, tenant, {
        id: "another-release-principal",
        grants: ["earn.read", "earn.execute"],
        environment: "sandbox",
      });
      const submitBody =
        source === "custody"
          ? { actionId: reviewed.actionId, version: reviewed.version }
          : action(reviewed);
      const wrongPrincipal = await request(
        `operations/${operation.id}/submit`,
        "POST",
        submitBody,
        "release-other-principal",
        otherKey
      );
      expect(wrongPrincipal.status, await wrongPrincipal.clone().text()).toBe(409);
      const submitted = await request(
        `operations/${operation.id}/submit`,
        "POST",
        submitBody,
        "submit-release"
      );
      expect(submitted.status, await submitted.clone().text()).toBe(202);
      expect(await readOperation(submitted)).toMatchObject({
        status: "queued",
        result: null,
        canCancel: false,
      });
      for (const mutation of ["refresh", "cancel"]) {
        const rejected = await request(
          `operations/${operation.id}/${mutation}`,
          "POST",
          mutation === "cancel"
            ? {}
            : {
                actionId: reviewed.actionId,
                version: reviewed.version,
                optionId: "release_current_redemption",
              },
          `release-reject-${mutation}`
        );
        expect(rejected.status, await rejected.clone().text()).toBe(409);
        expect(await rejected.json()).toMatchObject({
          error: { details: { reason: "operation_already_submitted" } },
        });
      }
      expect(
        await getDb(env).queryMany("SELECT * FROM earn_vault_withdrawal_requests ORDER BY id")
      ).toEqual(requestSnapshots);
      expect(
        await getDb(env).queryOne(
          "SELECT count(*) AS count FROM earn_vault_withdrawal_request_actions"
        )
      ).toEqual({ count: 0 });
      expect(await getDb(env).queryOne("SELECT count(*) AS count FROM earn_movements")).toEqual({
        count: 0,
      });
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.proposer).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalled();
    }
  );

  it("prepares and submits with only an API key and owner signature, without registering a wallet", async () => {
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
    expect(mocks.build.mock.calls[0]?.[1]?.swap).toBeUndefined();
    const accepted = await request(
      `operations/${operation.id}/submit`,
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
    expect(
      await getDb(env).queryOne("SELECT count(*)::int AS wallets FROM custody_wallets")
    ).toEqual({ wallets: 0 });
  });

  it("infers an atomic swap from the funding mint and returns one signable deposit action", async () => {
    const amount = { mint: WELL_KNOWN_TOKENS.USDC.mints.devnet.address, value: "10" };
    const response = await request(
      "earn/deposit",
      "POST",
      { strategyId, source: { ownerAddress: owner }, amount },
      "automatic-swap-deposit"
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const operation = await readOperation(response);
    expect(operation).toMatchObject({
      kind: "earn.deposit",
      status: "prepared",
      version: 1,
      intent: { amount },
      terms: { inputAmount: amount },
      nextAction: { type: "sign_transaction", transaction: unsigned },
      buildRef: { kind: "earn.strategy_transaction" },
    });
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        tokenMint: TOKEN,
        swap: { sourceTokenMint: amount.mint, slippageBps: 2 },
      })
    );
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("withdraws an owner-address position using its signature without an SDP wallet", async () => {
    mocks.withdrawalEnabled = true;
    const positionId = generateEarnPositionId();
    await getDb(env).execute(
      `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
       kind, owner_address, vault_address, share_mint, token_mint, label, activated_at)
       VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Holding', sdp_iso_now())`,
      [positionId, tenant.org.id, tenant.project.id, owner, VAULT, SHARE, TOKEN]
    );
    const response = await request(
      "earn/withdraw",
      "POST",
      { positionId, amount: { kind: "shares", value: "10" } },
      "owner-withdrawal"
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const operation = await readOperation(response);
    expect(operation.nextAction).toMatchObject({ type: "sign_transaction", transaction: unsigned });
    expect(mocks.withdrawBuild).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ positionId, ownerAddress: owner })
    );
    expect(mocks.withdrawBuild.mock.calls[0]?.[1]).not.toHaveProperty("custodyWalletId");
    const unsignedSubmission = await request(
      `operations/${operation.id}/submit`,
      "POST",
      { actionId: operation.actionId, version: operation.version },
      "owner-signature-required"
    );
    expect(unsignedSubmission.status).toBe(400);
    const accepted = await request(
      `operations/${operation.id}/submit`,
      "POST",
      action(operation),
      "submit-owner-withdrawal"
    );
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    expect((await readOperation(accepted)).status).toBe("queued");
    await runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () => reconcileOperations(env))
    );
    expect((await readOperation(await request(`operations/${operation.id}`))).status).toBe(
      "submitted"
    );
    expect(mocks.broadcast).toHaveBeenCalledOnce();
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(
      await getDb(env).queryOne("SELECT count(*)::int AS wallets FROM custody_wallets")
    ).toEqual({ wallets: 0 });
  });

  it.each(["9".repeat(80), `0.${"0".repeat(77)}1`])(
    "rejects unsupported token withdrawal amounts before preparing an action: %s",
    async (value) => {
      mocks.withdrawalEnabled = true;
      vi.spyOn(strategyMint, "strategyShareDecimals").mockResolvedValue(6);
      mocks.readPositions.mockResolvedValue([
        {
          providerReference: VAULT,
          owner,
          tokenMint: TOKEN,
          shareMint: SHARE,
          cluster: "devnet",
          shares: "10",
          tokenValue: "30",
        },
      ]);
      const positionId = generateEarnPositionId();
      await getDb(env).execute(
        `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
         kind, owner_address, vault_address, share_mint, token_mint, label, activated_at)
         VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Holding', sdp_iso_now())`,
        [positionId, tenant.org.id, tenant.project.id, owner, VAULT, SHARE, TOKEN]
      );
      const response = await request(
        "earn/withdraw",
        "POST",
        { positionId, amount: { kind: "token", mint: TOKEN, value } },
        "unsupported-token-withdrawal"
      );
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "BAD_REQUEST",
          message: "Withdrawal token amount is out of range or has unsupported precision",
        },
      });
      expect(mocks.choiceReads).not.toHaveBeenCalled();
      expect(mocks.withdrawBuild).not.toHaveBeenCalled();
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalled();
    }
  );

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
      nextAction: { type: "submit" },
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
      `operations/${operation.id}/submit`,
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

  it("selects and refreshes a withdrawal route without submitting or changing its authority", async () => {
    mocks.withdrawalEnabled = true;
    mocks.withdrawalChoices = true;
    const walletId = await seedOperationCustodyWallet("withdrawal_choices");
    const positionId = generateEarnPositionId();
    await getDb(env).execute(
      `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider,
       kind, custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at)
       VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Holding', sdp_iso_now())`,
      [positionId, tenant.org.id, tenant.project.id, walletId, VAULT, SHARE, TOKEN]
    );
    const initial = await request(
      "earn/withdraw",
      "POST",
      { positionId, amount: { kind: "shares", value: "10" } },
      "prepare-withdrawal-choices"
    );
    expect(initial.status, await initial.clone().text()).toBe(202);
    const operation = await readOperation(initial);
    expect(operation.nextAction).toEqual({ type: "select_option" });
    expect(operation.terms.options.map((option) => option.id)).toEqual(["direct", "queued"]);
    expect(mocks.withdrawBuild).not.toHaveBeenCalled();
    const reviewed = { actionId: operation.actionId, version: operation.version };
    const refreshPath = `operations/${operation.id}/refresh`;
    const submitted = await request(
      `operations/${operation.id}/submit`,
      "POST",
      reviewed,
      "cannot-submit-choice"
    );
    expect(submitted.status).toBe(409);
    for (const [tag, body, status] of [
      ["missing", reviewed, 400],
      ["unknown", { ...reviewed, optionId: "unknown" }, 400],
      ["stale", { ...reviewed, version: reviewed.version + 1, optionId: "direct" }, 409],
    ] as const) {
      const response = await request(refreshPath, "POST", body, `choice-${tag}`);
      expect(response.status, await response.clone().text()).toBe(status);
    }
    const otherKey = await seedEarnApiKey(env, tenant, {
      id: "other-choice-principal",
      grants: ["earn.read", "earn.execute"],
      environment: "sandbox",
    });
    const otherPrincipal = await request(
      refreshPath,
      "POST",
      { ...reviewed, optionId: "direct" },
      "choice-other-principal",
      otherKey
    );
    expect(otherPrincipal.status, await otherPrincipal.clone().text()).toBe(409);
    expect(mocks.withdrawBuild).not.toHaveBeenCalled();

    const selected = await request(
      refreshPath,
      "POST",
      { ...reviewed, optionId: "direct" },
      "select-direct"
    );
    expect(selected.status, await selected.clone().text()).toBe(202);
    const prepared = await readOperation(selected);
    expect(prepared).toMatchObject({
      id: operation.id,
      version: operation.version + 1,
      status: "prepared",
      intent: operation.intent,
      nextAction: { type: "submit" },
      terms: { options: [{ id: "direct" }] },
    });
    expect(prepared.actionId).not.toBe(operation.actionId);
    expect(mocks.withdrawBuild).toHaveBeenCalledTimes(1);
    const replay = await request(
      refreshPath,
      "POST",
      { ...reviewed, optionId: "direct" },
      "select-direct"
    );
    expect((await readOperation(replay)).actionId).toBe(prepared.actionId);
    expect(mocks.withdrawBuild).toHaveBeenCalledTimes(1);

    const refreshedResponse = await request(
      refreshPath,
      "POST",
      { actionId: prepared.actionId, version: prepared.version },
      "refresh-selected-direct"
    );
    expect(refreshedResponse.status, await refreshedResponse.clone().text()).toBe(202);
    const refreshed = await readOperation(refreshedResponse);
    expect(refreshed.nextAction).toEqual({ type: "submit" });
    expect(refreshed.terms.options.map((option) => option.id)).toEqual(["direct"]);
    expect(mocks.withdrawBuild).toHaveBeenCalledTimes(2);
    mocks.directWithdrawalAvailable = false;
    const unavailable = await request(
      refreshPath,
      "POST",
      { actionId: refreshed.actionId, version: refreshed.version },
      "no-route-fallback"
    );
    expect(unavailable.status, await unavailable.clone().text()).toBe(400);
    expect(mocks.withdrawBuild).toHaveBeenCalledTimes(2);
    expect(
      await getDb(env).queryOne(
        `SELECT (SELECT count(*)::int FROM operation_attempts WHERE operation_id = ?) AS attempts,
         (SELECT count(*)::int FROM audit_logs WHERE resource_type = 'earn_operation'
           AND resource_id = ? AND action = 'submit') AS submissions`,
        [operation.id, operation.id]
      )
    ).toEqual({ attempts: 0, submissions: 0 });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    const accepted = await request(
      `operations/${refreshed.id}/submit`,
      "POST",
      { actionId: refreshed.actionId, version: refreshed.version },
      "submit-selected-withdrawal"
    );
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const snapshot = await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [
      operation.id,
    ]);
    const cached = await request(
      refreshPath,
      "POST",
      { ...reviewed, optionId: "direct" },
      "select-direct"
    );
    expect(cached.status, await cached.clone().text()).toBe(202);
    expect(cached.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await readOperation(cached)).actionId).toBe(prepared.actionId);
    const current = await readOperation(await request(`operations/${operation.id}`));
    expect(current).toMatchObject({
      actionId: refreshed.actionId,
      status: "queued",
      canCancel: false,
    });
    const refusedRefresh = await request(
      refreshPath,
      "POST",
      { actionId: refreshed.actionId, version: refreshed.version },
      "fresh-refresh-after-submit"
    );
    expect(refusedRefresh.status, await refusedRefresh.clone().text()).toBe(409);
    expect(await refusedRefresh.json()).toMatchObject({
      error: { details: { reason: "operation_already_submitted" } },
    });
    expect(
      await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [operation.id])
    ).toEqual(snapshot);
    expect(mocks.withdrawBuild).toHaveBeenCalledTimes(2);
    expect(
      await getDb(env).queryOne(
        "SELECT count(*)::int AS attempts FROM operation_attempts WHERE operation_id = ?",
        [operation.id]
      )
    ).toEqual({ attempts: 1 });
  });

  it("leaves failed signing outcomes terminal while fresh accepted work advances", async () => {
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
      `operations/${refused.id}/submit`,
      "POST",
      { actionId: refused.actionId, version: refused.version },
      "refused-accepted"
    );
    expect(acceptedRefusal.status, await acceptedRefusal.clone().text()).toBe(202);
    await getDb(env).execute(
      `UPDATE operations SET status = 'failed', next_action = NULL,
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
          `operations/${fresh.id}/submit`,
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
    expect((await readOperation(await request(`operations/${refused.id}`))).status).toBe("failed");
    expect(
      await getDb(env).queryOne("SELECT fence FROM operations WHERE id = ?", [refused.id])
    ).toEqual(before);
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
  });

  describe("unsent and refused submissions in the real operation store", () => {
    const reconcile = () =>
      runWithSystemDatabaseIdentity("cron:reconcile-operations", () =>
        runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
          reconcileOperations(env)
        )
      );
    const stored = (id: string) =>
      getDb(env).queryOne<{ status: string; fence: number }>(
        "SELECT status, fence FROM operations WHERE id = ?",
        [id]
      );
    function proveUnsent(verdict: "expired" | "pending") {
      const unsentVerdict = vi
        .fn<observationRpc.OperationObservationRpc["unsentVerdict"]>()
        .mockResolvedValue(verdict);
      vi.spyOn(observationRpc, "createOperationObservationRpc").mockReturnValue({
        confirmedHeight: async () => 50n,
        hasSignature: async () => false,
        unsentVerdict,
      });
      return unsentVerdict;
    }
    async function acceptOwnerDeposit(key: string) {
      const operation = await prepare();
      const accepted = await request(
        `operations/${operation.id}/submit`,
        "POST",
        action(operation),
        key
      );
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      return operation;
    }

    it("fails revoked owner bytes once history proves they expired unsent, and keeps them failed", async () => {
      const operation = await acceptOwnerDeposit("execute-then-revoke");
      await getDb(env).execute("UPDATE api_keys SET grants = '{earn.read}' WHERE id = ?", [
        apiKey.id,
      ]);
      const unsentVerdict = proveUnsent("expired");
      await reconcile();
      expect(await readOperation(await request(`operations/${operation.id}`))).toMatchObject({
        status: "failed",
        nextAction: null,
        resourceRef: null,
        error: { code: "TRANSACTION_EXPIRED" },
      });
      const ended = await stored(operation.id);
      await reconcile();
      expect(await stored(operation.id)).toEqual(ended);
      expect(unsentVerdict).toHaveBeenCalledTimes(1);
      expect(mocks.broadcast).not.toHaveBeenCalled();
      expect(await unfinishedCounts()).toEqual({ movements: 0, positions: 0 });
    });

    it("keeps revoked owner bytes waiting while they can still land", async () => {
      const operation = await acceptOwnerDeposit("execute-then-revoke-pending");
      await getDb(env).execute("UPDATE api_keys SET grants = '{earn.read}' WHERE id = ?", [
        apiKey.id,
      ]);
      proveUnsent("pending");
      await reconcile();
      expect(await readOperation(await request(`operations/${operation.id}`))).toMatchObject({
        status: "awaiting_signature",
        nextAction: { type: "wait" },
        error: null,
      });
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });

    it("fails bytes whose cancellation was recorded beside an accepted submit once they provably never landed", async () => {
      const operation = await acceptOwnerDeposit("execute-then-cancel");
      await getDb(env).execute(
        "UPDATE operations SET cancel_requested_at = sdp_iso_now() WHERE id = ?",
        [operation.id]
      );
      proveUnsent("expired");
      await reconcile();
      expect(await readOperation(await request(`operations/${operation.id}`))).toMatchObject({
        status: "failed",
        nextAction: null,
        error: { code: "TRANSACTION_EXPIRED" },
      });
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });

    it("ends a custody deposit its wallet policy refused without asking the provider again", async () => {
      const walletId = await seedOperationCustodyWallet("policy_refused");
      mocks.proposer.mockResolvedValue(null);
      const rawSigner = await createSignerFromKeyPair(keyPair);
      const providerSign = vi.fn<typeof rawSigner.signTransactions>(async () => {
        throw new SigningError("Blocked by wallet policy", "POLICY_REFUSED");
      });
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
      const prepared = await request(
        "earn/deposit",
        "POST",
        { strategyId, source: { walletId }, amount: { mint: TOKEN, value: "10" } },
        "prepare-policy-refused"
      );
      expect(prepared.status, await prepared.clone().text()).toBe(202);
      const deposit = await readOperation(prepared);
      const accepted = await request(
        `operations/${deposit.id}/submit`,
        "POST",
        { actionId: deposit.actionId, version: deposit.version },
        "submit-policy-refused"
      );
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      await reconcile();
      expect(await readOperation(await request(`operations/${deposit.id}`))).toMatchObject({
        status: "failed",
        nextAction: null,
        error: { code: "CUSTODY_POLICY_REFUSED" },
      });
      await reconcile();
      expect(providerSign).toHaveBeenCalledTimes(1);
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });
  });

  it("fails closed when deposit audit admission cannot persist", async () => {
    const operation = await prepare();
    const audit = vi
      .spyOn(AuditService.prototype, "beginCriticalWithin")
      .mockRejectedValueOnce(new Error("audit ledger unavailable"));
    const rejected = await request(
      `operations/${operation.id}/submit`,
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
      `operations/${operation.id}/submit`,
      "POST",
      action(operation),
      "audit-recovered"
    );
    expect(retry.status, await retry.clone().text()).toBe(202);
    expect((await readOperation(retry)).status).toBe("queued");
  });

  it("replays accepted queued bytes after HTTP key loss without another attempt or audit", async () => {
    const operation = await prepare();
    const path = `operations/${operation.id}/submit`;
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
      { actionId: operation.actionId, version: operation.version },
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

  it("refuses to revoke exposed owner bytes without recording cancellation intent", async () => {
    const operation = await prepare();
    expect(operation.canCancel).toBe(false);
    const before = await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [
      operation.id,
    ]);
    const response = await request(
      `operations/${operation.id}/cancel`,
      "POST",
      {},
      "cancel-exposed-owner"
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { details: { reason: "wallet_transaction_outcome_unknown" } },
    });
    expect(
      await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [operation.id])
    ).toEqual(before);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(mocks.proposer).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it.each(["queued", "awaiting_signature", "submitted", "settling", "completed", "failed"])(
    "rejects fresh cancellation and refresh of accepted %s operations without changing anything",
    async (status) => {
      const walletId = await seedOperationCustodyWallet(`accepted_${status}`);
      const prepared = await readOperation(
        await request(
          "earn/deposit",
          "POST",
          { strategyId, source: { walletId }, amount: { mint: TOKEN, value: "10" } },
          "prepare-accepted-state"
        )
      );
      expect(prepared.canCancel).toBe(true);
      const accepted = await request(
        `operations/${prepared.id}/submit`,
        "POST",
        { actionId: prepared.actionId, version: prepared.version },
        "submit-accepted-state"
      );
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      expect((await readOperation(accepted)).canCancel).toBe(false);
      await getDb(env).execute(
        "UPDATE operations SET status = ?, next_action = ?::jsonb WHERE id = ?",
        [
          status,
          status === "completed" || status === "failed"
            ? null
            : JSON.stringify({ type: "wait", reason: "Tracking the accepted transaction" }),
          prepared.id,
        ]
      );
      const before = await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [
        prepared.id,
      ]);
      const attempts = await getDb(env).queryMany(
        "SELECT * FROM operation_attempts WHERE operation_id = ?",
        [prepared.id]
      );
      for (const mutation of ["cancel", "refresh"]) {
        const response = await request(
          `operations/${prepared.id}/${mutation}`,
          "POST",
          mutation === "cancel" ? {} : { actionId: prepared.actionId, version: prepared.version },
          `refuse-${mutation}`
        );
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { details: { reason: "operation_already_submitted" } },
        });
      }
      expect(
        await getDb(env).queryOne("SELECT * FROM operations WHERE id = ?", [prepared.id])
      ).toEqual(before);
      expect(
        await getDb(env).queryMany("SELECT * FROM operation_attempts WHERE operation_id = ?", [
          prepared.id,
        ])
      ).toEqual(attempts);
      expect(mocks.build).toHaveBeenCalledOnce();
      expect(mocks.sign).not.toHaveBeenCalled();
      expect(mocks.proposer).not.toHaveBeenCalled();
      expect(mocks.broadcast).not.toHaveBeenCalled();
    }
  );

  it("rejects a different signed message and stale action without queueing money work", async () => {
    const operation = await prepare();
    const forged = await transaction("different financial instructions");
    const rejected = await request(
      `operations/${operation.id}/submit`,
      "POST",
      action(operation, forged.signed),
      "forged-one"
    );
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    const stale = await request(
      `operations/${operation.id}/submit`,
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
    const active = await request(`operations?ownerAddress=${owner}&status=active&limit=1`);
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({
      data: { operations: [{ id: operation.id, status: "prepared" }], nextCursor: null },
    });
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
          `operations/${operation.id}/submit`,
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
