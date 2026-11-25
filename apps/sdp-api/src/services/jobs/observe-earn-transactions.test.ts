import type { EarnVaultQueuedWithdrawProvider } from "@sdp/earn/types";
import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import * as solanaRpc from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import {
  claimSelectedEarnObservations,
  releaseEarnObservation,
} from "@/db/repositories/earn-observation-claims";
import { createPostgresEarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { logEvent } from "@/runtime/money-path-events";
import * as executionRegistry from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { reconcileEarnVaultMovementBatch } from "@/services/earn/vault-movement-reconciliation.service";
import {
  observeEarnWithdrawalActionStatus,
  reconcileEarnVaultQueuedWithdrawals,
} from "@/services/earn/vault-queued-withdrawal-reconciliation.service";
import {
  epochInfoResult,
  installClusterRpcResponder,
  signatureStatusesRead,
} from "@/test/helpers/cluster-rpc";
import { deferred } from "@/test/helpers/deferred";
import { env } from "@/test/helpers/env";
import { syntheticSignature } from "@/test/helpers/parsed-transactions";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { observeEarnTransactions } from "./observe-earn-transactions";

const decodeEvents =
  vi.fn<EarnVaultQueuedWithdrawProvider["decodeQueuedWithdrawalLifecycleEvents"]>();
const readQueuedRequest = vi.fn<EarnVaultQueuedWithdrawProvider["readQueuedWithdrawalRequest"]>();
const USDC_MINT = required(wellKnownMint("USDC", "mainnet-beta"));

const ORG = "org_recent_vault";
const USER = "user_recent_vault";
const PROJECT = "project_recent_vault";
const WALLET = "wallet_recent_vault";
const rpc = installClusterRpcResponder();
let sequence = 0;

function observe(environment: SdpEnvironment = "sandbox") {
  return runInClusterScope({ projectId: null, environment }, () => observeEarnTransactions(env));
}

function repository() {
  return createPostgresEarnMovementsRepository(getDb(env));
}

async function seedMovement(provider = "veda") {
  sequence += 1;
  return repository().createSignedVaultDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider,
    custodyWalletId: WALLET,
    vaultAddress: `vault_${sequence}`,
    shareMint: SOL_MINT,
    tokenMint: USDC_MINT,
    label: "Observed vault",
    requestedAmount: "1",
    sourceAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: syntheticSignature(sequence),
    signedTransaction: Buffer.from([1, 2, 3]).toString("base64"),
    lastValidBlockHeight: "100",
    requestId: `request_${sequence}`,
    idempotencyFingerprint: `fingerprint_${sequence}`,
  });
}

async function seedWithdrawal() {
  const deposit = await seedMovement();
  await repository().advanceVaultMovement({
    movementId: deposit.movement.id,
    organizationId: ORG,
    toStatus: "failed",
    failureReason: "withdrawal fixture",
  });
  sequence += 1;
  return repository().createSignedVaultWithdrawalIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "veda",
    positionId: deposit.position.id,
    vaultAddress: required(deposit.position.vault_address),
    custodyWalletId: WALLET,
    shareMint: SOL_MINT,
    requestedShares: "1",
    walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: syntheticSignature(sequence),
    signedTransaction: Buffer.from([1, 2, 3]).toString("base64"),
    lastValidBlockHeight: "100",
    requestId: `request_${sequence}`,
    idempotencyFingerprint: `fingerprint_${sequence}`,
  });
}

async function readMovement(id: string) {
  return repository().getMovementById({ organizationId: ORG, movementId: id });
}

beforeEach(async () => {
  await seedTestDatabase(env);
  sequence = 0;
  decodeEvents.mockReset();
  readQueuedRequest.mockReset();
  const client = required(
    runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      executionRegistry.resolveVaultQueuedWithdrawClient(env, "veda", createVaultDeadline())
    )
  );
  vi.spyOn(client, "decodeQueuedWithdrawalLifecycleEvents").mockImplementation(decodeEvents);
  vi.spyOn(client, "readQueuedWithdrawalRequest").mockImplementation(readQueuedRequest);
  vi.spyOn(executionRegistry, "resolveVaultQueuedWithdrawClient").mockReturnValue(client);
  const db = getDb(env);
  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')"
    )
    .bind(ORG, "Recent vault", "recent-vault")
    .run();
  await db
    .prepare(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'recent-vault@example.com', 1, 'active')"
    )
    .bind(USER)
    .run();
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  await db
    .prepare(
      "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status) VALUES ('config_recent_vault', ?, ?, 'privy', 'test', 'active')"
    )
    .bind(ORG, PROJECT)
    .run();
  await db
    .prepare(
      "INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status) VALUES (?, 'config_recent_vault', 'wallet', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'active')"
    )
    .bind(WALLET)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function seedQueuedAction() {
  const deposited = await seedMovement();
  await repository().advanceVaultMovement({
    movementId: deposited.movement.id,
    organizationId: ORG,
    toStatus: "failed",
    failureReason: "queued fixture",
  });
  sequence += 1;
  const queue = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
  const input = {
    requestId: `queued_${sequence}`,
    actionId: `action_${sequence}`,
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox" as const,
    provider: "veda",
    positionId: deposited.position.id,
    custodyWalletId: WALLET,
    ownerAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    vaultAddress: required(deposited.position.vault_address),
    tokenMint: USDC_MINT,
    shareMint: SOL_MINT,
    requestAddress: `queue_address_${sequence}`,
    mechanism: "solver_queue" as const,
    shares: "1",
    quotedAssets: "1",
    shareDecimals: 6,
    assetDecimals: 6,
    discountBps: 0,
    maturityTimestamp: "4000000000",
    deadlineTimestamp: "4000000060",
    signature: syntheticSignature(sequence),
    signedTransaction: "AQ==",
    lastValidBlockHeight: "100",
    clientRequestId: `queue_key_${sequence}`,
    idempotencyFingerprint: `queue_fingerprint_${sequence}`,
    pdaLeaseToken: `queue_lease_${sequence}`,
  };
  await queue.acquireRequestReservation({
    id: input.pdaLeaseToken,
    ...input,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return queue.createSignedRequest(input);
}

function finalized() {
  rpc.respondSignatureStatuses(() => ({
    slot: 50,
    confirmations: null,
    confirmationStatus: "finalized",
    err: null,
  }));
}

function queuedEvents(
  request: Awaited<ReturnType<typeof seedQueuedAction>>["request"]
): Awaited<ReturnType<EarnVaultQueuedWithdrawProvider["decodeQueuedWithdrawalLifecycleEvents"]>> {
  return [
    {
      kind: "withdrawalRequested",
      requestAddress: request.request_address,
      owner: request.owner_address,
      assetMint: request.token_mint,
      nonce: "7",
      shares: "1",
      assets: "1",
      creationTimestamp: "1700000000",
      maturityTimestamp: "4000000000",
      deadlineTimestamp: "4000000060",
    },
  ];
}

function answerQueuedTransaction() {
  rpc.answer("getTransaction", {
    slot: 50,
    blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
    meta: {
      err: null,
      logMessages: ["provider-authenticated-event"],
      fee: 5_000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  });
}

describe("shared Earn transaction observation", () => {
  it("batches direct and queued signatures in one RPC and never sends or reads expiry heights", async () => {
    const direct = await seedMovement();
    const queued = await seedQueuedAction();
    rpc.respondSignatureStatuses(() => ({
      slot: 50,
      confirmations: 1,
      confirmationStatus: "confirmed",
      err: null,
    }));
    expect(await observe()).toEqual({ claimed: 2, saturated: false });
    const reads = rpc.requests.filter(({ method }) => method === "getSignatureStatuses");
    expect(reads).toHaveLength(1);
    expect(signatureStatusesRead(reads[0]).signatures).toHaveLength(2);
    expect((await readMovement(direct.movement.id))?.status).toBe("confirmed");
    expect(
      await getDb(env).queryOne(
        "SELECT status FROM earn_vault_withdrawal_request_actions WHERE id = ?",
        [queued.action.id]
      )
    ).toEqual({ status: "confirmed" });
    expect(
      rpc.calls.filter(({ method }) => method !== "getGenesisHash").map(({ method }) => method)
    ).toEqual(["getSignatureStatuses"]);
  });

  it("drains a burst across competing observers without a minute-batch ceiling", async () => {
    await Promise.all(Array.from({ length: 129 }, () => seedMovement()));
    finalized();
    const startedAt = performance.now();
    const first = await Promise.all([observe(), observe()]);
    expect(first.map((result) => result.claimed)).toEqual([64, 64]);
    expect(await observe()).toEqual({ claimed: 1, saturated: false });
    const reads = rpc.requests.filter(({ method }) => method === "getSignatureStatuses");
    expect(reads).toHaveLength(3);
    expect(
      reads.map((read) => signatureStatusesRead(read).signatures.length).sort((a, b) => a - b)
    ).toEqual([1, 64, 64]);
    expect(
      await getDb(env).queryOne(
        "SELECT COUNT(*)::integer AS settled FROM earn_movements WHERE organization_id = ? AND status = 'finalized'",
        [ORG]
      )
    ).toEqual({ settled: 129 });
    logEvent("info", {
      event: "earn_observer_local_burst_probe",
      movements: 129,
      statusReads: reads.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  });

  it("partitions due work across replicas and fences stale releases after takeover", async () => {
    await Promise.all(Array.from({ length: 8 }, () => seedMovement()));
    const [one, two] = await Promise.all([
      repository().claimDueObservations("sandbox", 4),
      repository().claimDueObservations("sandbox", 4),
    ]);
    expect(one.rows).toHaveLength(4);
    expect(two.rows).toHaveLength(4);
    expect(new Set([...one.rows, ...two.rows].map((row) => row.id)).size).toBe(8);
    expect((await repository().claimDueObservations("sandbox", 4)).rows).toHaveLength(0);
    const row = one.rows[0];
    if (row === undefined) throw new Error("Missing claimed fixture");
    expect((await claimSelectedEarnObservations(getDb(env), "movement", [row])).ids.size).toBe(0);
    await getDb(env).execute(
      "UPDATE earn_movements SET observation_claim_until = now() - interval '1 second', observation_due_at = now() - interval '1 second' WHERE id = ?",
      [row.id]
    );
    const takeover = await repository().claimDueObservations("sandbox", 1);
    expect(takeover.rows.map((item) => item.id)).toEqual([row.id]);
    await releaseEarnObservation(getDb(env), "movement", row, one.token, 0);
    expect((await repository().claimDueObservations("sandbox", 1)).rows).toHaveLength(0);
    await releaseEarnObservation(getDb(env), "movement", row, takeover.token, 0);
    expect((await repository().claimDueObservations("sandbox", 1)).rows).toHaveLength(1);
  });

  it("prevents the recovery sweep from spending RPC on a fast-observer claim", async () => {
    const seeded = await seedMovement();
    finalized();
    const claim = await repository().claimDueObservations("sandbox", 1);
    const result = await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      reconcileEarnVaultMovementBatch(env, [seeded.movement])
    );
    expect(result.claimed).toBe(0);
    expect(rpc.calls).toHaveLength(0);
    await releaseEarnObservation(getDb(env), "movement", seeded.movement, claim.token, 0);
    await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      reconcileEarnVaultMovementBatch(env, [seeded.movement])
    );
    expect((await readMovement(seeded.movement.id))?.status).toBe("finalized");
  });

  it("uses the fresh claimed state when a fast observer confirms a minute-sweep candidate", async () => {
    const stale = await seedMovement();
    await repository().advanceVaultMovement({
      movementId: stale.movement.id,
      organizationId: ORG,
      toStatus: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    rpc.respondSignatureStatuses(() => null);
    rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: 500, blockHeight: 200 }));
    const result = await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      reconcileEarnVaultMovementBatch(env, [stale.movement])
    );
    expect(result).toMatchObject({ claimed: 1, unchanged: 1, failed: 0, resubmitted: 0 });
    expect((await readMovement(stale.movement.id))?.status).toBe("confirmed");
    expect(
      rpc.calls.some(({ method }) => method === "getEpochInfo" || method === "sendTransaction")
    ).toBe(false);
  });

  it("retires obsolete queued hints in bounded pages without changing financial history", async () => {
    const queue = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
    const historical: Array<Awaited<ReturnType<typeof seedQueuedAction>>> = [];
    for (let index = 0; index < 6; index += 1) historical.push(await seedQueuedAction());
    for (const [index, item] of historical.entries()) {
      await queue.advanceAction({
        actionId: item.action.id,
        organizationId: ORG,
        toStatus: index < 3 ? "submitted" : "finalized",
      });
      await queue.advanceRequest({
        withdrawalRequestId: item.request.id,
        organizationId: ORG,
        toStatus: index < 3 ? "fulfilled" : "pending",
      });
    }
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_request_actions SET observation_due_at = '2000-01-01' WHERE organization_id = ?",
      [ORG]
    );
    const fresh = await seedQueuedAction();
    const first = await queue.claimDueObservations("sandbox", 4);
    expect(first).toMatchObject({ rows: [], scanned: 4 });
    const next = await queue.claimDueObservations("sandbox", 4);
    expect(next.scanned).toBe(3);
    expect(next.rows.map(({ id }) => id)).toEqual([fresh.action.id]);
    expect(await queue.claimDueObservations("sandbox", 4)).toMatchObject({ rows: [], scanned: 0 });
    expect(
      await getDb(env).queryMany(
        `SELECT action.status, request.status AS request_status,
              action.observation_due_at AS due_at
       FROM earn_vault_withdrawal_request_actions action
       JOIN earn_vault_withdrawal_requests request ON request.id = action.withdrawal_request_id
       WHERE action.id = ANY (?::text[]) ORDER BY action.status, action.id`,
        [historical.map(({ action }) => action.id)]
      )
    ).toEqual([
      ...Array.from({ length: 3 }, () => ({
        status: "finalized",
        request_status: "pending",
        due_at: null,
      })),
      ...Array.from({ length: 3 }, () => ({
        status: "submitted",
        request_status: "fulfilled",
        due_at: null,
      })),
    ]);
    expect(rpc.calls).toHaveLength(0);
  });

  it("leaves legacy NULL queued hints available to recovery without scanning history in the fast lane", async () => {
    const queued = await seedQueuedAction();
    const queue = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_request_actions SET observation_due_at = NULL WHERE id = ?",
      [queued.action.id]
    );
    expect(await queue.claimDueObservations("sandbox", 64)).toMatchObject({ rows: [], scanned: 0 });
    expect(
      (await queue.claimRecoveryObservations([queued.action])).rows.map(({ id }) => id)
    ).toEqual([queued.action.id]);
  });

  it("observes pending work without a notification and excludes the other environment", async () => {
    const seeded = await seedMovement();
    finalized();
    expect(await observe("production")).toEqual({ claimed: 0, saturated: false });
    expect(rpc.calls).toHaveLength(0);
    await observe();
    expect((await readMovement(seeded.movement.id))?.status).toBe("finalized");
    expect((await repository().claimDueObservations("sandbox", 64)).rows).toHaveLength(0);
  });

  it("projects authenticated queued creation promptly without claiming a payout", async () => {
    const queued = await seedQueuedAction();
    finalized();
    answerQueuedTransaction();
    decodeEvents.mockResolvedValue(queuedEvents(queued.request));
    await observe();
    expect(
      await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: queued.request.id,
      })
    ).toMatchObject({ status: "pending", assets_paid: null, fulfilled_at: null });
    expect(
      (
        await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).claimDueObservations(
          "sandbox",
          64
        )
      ).rows
    ).toHaveLength(0);
  });

  it("bounds a slow provider projection and ignores its late result", async () => {
    const queued = await seedQueuedAction();
    finalized();
    answerQueuedTransaction();
    const started = deferred<void>();
    const events = deferred<ReturnType<typeof queuedEvents>>();
    decodeEvents.mockImplementation(() => {
      started.resolve();
      return events.promise;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = observe();
      const rejected = expect(pending).rejects.toThrow("could not be observed");
      await started.promise;
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      events.resolve(queuedEvents(queued.request));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        (
          await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).getById({
            organizationId: ORG,
            environment: "sandbox",
            withdrawalRequestId: queued.request.id,
          })
        )?.status
      ).toBe("creating");
    } finally {
      events.resolve(queuedEvents(queued.request));
      vi.useRealTimers();
    }
  });

  it("keeps a finalized action due when its lifecycle projection fails", async () => {
    const queued = await seedQueuedAction();
    finalized();
    answerQueuedTransaction();
    decodeEvents.mockResolvedValue([
      { ...queuedEvents(queued.request)[0], owner: "foreign-owner" },
    ]);
    await expect(observe()).rejects.toThrow("could not be observed");
    expect(
      await getDb(env).queryOne(
        "SELECT status FROM earn_vault_withdrawal_request_actions WHERE id = ?",
        [queued.action.id]
      )
    ).toEqual({ status: "finalized" });
    expect(
      (
        await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).getById({
          organizationId: ORG,
          environment: "sandbox",
          withdrawalRequestId: queued.request.id,
        })
      )?.status
    ).toBe("creating");
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_request_actions SET observation_due_at = now() WHERE id = ?",
      [queued.action.id]
    );
    decodeEvents.mockResolvedValue(queuedEvents(queued.request));
    await observe();
    expect(
      (
        await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).getById({
          organizationId: ORG,
          environment: "sandbox",
          withdrawalRequestId: queued.request.id,
        })
      )?.status
    ).toBe("pending");
  });

  it("does not expire unknown bytes and lets recovery acquire the released row", async () => {
    const seeded = await seedMovement();
    rpc.respondSignatureStatuses(() => null);
    await observe();
    expect(await readMovement(seeded.movement.id)).toMatchObject({
      status: "requested",
      signed_transaction: seeded.movement.signed_transaction,
    });
    expect(
      (await claimSelectedEarnObservations(getDb(env), "movement", [seeded.movement])).ids.size
    ).toBe(1);
    expect(
      rpc.calls.some(({ method }) => method === "sendTransaction" || method === "getEpochInfo")
    ).toBe(false);
  });

  it("releases claims with backoff after a broken status response", async () => {
    const seeded = await seedMovement();
    rpc.answer("getSignatureStatuses", { context: { slot: 50 }, value: [] });
    await expect(observe()).rejects.toThrow();
    expect(
      await getDb(env).queryOne(
        "SELECT observation_claim_token, observation_due_at > now() AS backed_off FROM earn_movements WHERE id = ?",
        [seeded.movement.id]
      )
    ).toEqual({ observation_claim_token: null, backed_off: true });
  });

  it("reserves queued action capacity when slow direct receipts exhaust a pass", async () => {
    await Promise.all(Array.from({ length: 6 }, () => seedWithdrawal()));
    const queued = await seedQueuedAction();
    finalized();
    decodeEvents.mockResolvedValue(queuedEvents(queued.request));
    const startedAt = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    rpc.respond("getTransaction", () => {
      vi.setSystemTime(startedAt + 4_001);
      return {
        result: {
          slot: 50,
          blockTime: 1_700_000_000,
          transaction: { message: { accountKeys: [], instructions: [] }, signatures: [] },
          meta: {
            err: null,
            logMessages: ["provider-authenticated-event"],
            fee: 5_000,
            preBalances: [],
            postBalances: [],
            preTokenBalances: [],
            postTokenBalances: [],
          },
        },
      };
    });
    await observe();
    expect(
      (
        await createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env)).getById({
          organizationId: ORG,
          environment: "sandbox",
          withdrawalRequestId: queued.request.id,
        })
      )?.status
    ).toBe("pending");
    expect((await repository().claimDueObservations("sandbox", 64)).rows.length).toBeGreaterThan(0);
  });

  it("keeps provider-order economic settlement pending after chain finality", async () => {
    const seeded = await seedMovement("wisdomtree");
    finalized();
    await observe();
    expect(await readMovement(seeded.movement.id)).toMatchObject({
      status: "confirmed",
      settled_at: null,
    });
    expect((await readMovement(seeded.movement.id))?.chain_finalized_at).not.toBeNull();
    expect((await repository().claimDueObservations("sandbox", 64)).rows).toHaveLength(0);
  });
});

/** Keep provider polling independent from the action-evidence budget under test. */
async function postponeQueuedProviderReads() {
  await getDb(env).execute(
    "UPDATE earn_vault_withdrawal_requests SET next_check_at = '2099-01-01T00:00:00.000Z' WHERE organization_id = ?",
    [ORG]
  );
}

function queueRecovery() {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    reconcileEarnVaultQueuedWithdrawals(env)
  );
}

function liveQueuedRequest(
  request: Awaited<ReturnType<typeof seedQueuedAction>>["request"]
): Awaited<ReturnType<EarnVaultQueuedWithdrawProvider["readQueuedWithdrawalRequest"]>> {
  return {
    status: "pending",
    requestAddress: request.request_address,
    request: {
      status: "pending",
      requestAddress: request.request_address,
      providerReference: request.vault_address,
      assetMint: request.token_mint,
      shares: request.shares,
      owner: request.owner_address,
      nonce: "7",
      assets: request.quoted_assets,
      creationTimestamp: "1700000000",
      maturityTimestamp: required(request.maturity_timestamp),
      deadlineTimestamp: required(request.deadline_timestamp),
    },
  };
}

describe("queued recovery shared evidence", () => {
  it("reads one status batch for 128 actions while acquiring only active chunks", async () => {
    const seeded = await Promise.all(Array.from({ length: 128 }, () => seedQueuedAction()));
    await postponeQueuedProviderReads();
    rpc.respondSignatureStatuses(() => ({
      slot: 50,
      confirmations: 1,
      confirmationStatus: "confirmed",
      err: null,
    }));
    await queueRecovery();
    const reads = rpc.requests.filter(({ method }) => method === "getSignatureStatuses");
    expect(reads).toHaveLength(1);
    const firstRead = reads[0];
    if (firstRead === undefined) throw new Error("Missing queued status batch");
    expect(new Set(signatureStatusesRead(firstRead).signatures)).toEqual(
      new Set(seeded.map(({ action }) => action.signature))
    );
    expect(
      rpc.calls.some(({ method }) => method === "getEpochInfo" || method === "sendTransaction")
    ).toBe(false);
    expect(
      await getDb(env).queryOne(
        "SELECT COUNT(*)::integer AS confirmed FROM earn_vault_withdrawal_request_actions WHERE organization_id = ? AND status = 'confirmed'",
        [ORG]
      )
    ).toEqual({ confirmed: 128 });
    expect(readQueuedRequest).not.toHaveBeenCalled();
  });

  it("shares one height and one corroborating status read across expired action chunks", async () => {
    const seeded = await Promise.all(Array.from({ length: 12 }, () => seedQueuedAction()));
    const requests = new Map(seeded.map(({ request }) => [request.request_address, request]));
    readQueuedRequest.mockImplementation(async (_scope, input) => {
      const request = requests.get(input.requestAddress);
      if (!request) throw new Error("Unknown queued fixture");
      return liveQueuedRequest(request);
    });
    rpc.respondSignatureStatusesAt(5_000, () => null);
    rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: 5_000, blockHeight: 101 }));
    await queueRecovery();
    const reads = rpc.requests.filter(({ method }) => method === "getSignatureStatuses");
    expect(reads).toHaveLength(2);
    expect(reads.map((read) => signatureStatusesRead(read).signatures.length)).toEqual([12, 12]);
    expect(reads[1]?.params[1]).toEqual({ searchTransactionHistory: true, minContextSlot: 5_000 });
    expect(rpc.calls.filter(({ method }) => method === "getEpochInfo")).toHaveLength(1);
    expect(readQueuedRequest).toHaveBeenCalledTimes(12);
    expect(rpc.calls.some(({ method }) => method === "sendTransaction")).toBe(false);
    expect(
      await getDb(env).queryOne(
        "SELECT COUNT(*)::integer AS pending FROM earn_vault_withdrawal_requests WHERE organization_id = ? AND status = 'pending' AND assets_paid IS NULL",
        [ORG]
      )
    ).toEqual({ pending: 12 });
  });

  it("leaves every action unleased while its shared RPC waits", async () => {
    const seeded = await Promise.all(Array.from({ length: 9 }, () => seedQueuedAction()));
    const statuses = deferred<Array<solanaRpc.SignatureStatusInfo | null>>();
    const read = vi.spyOn(solanaRpc, "getSignatureStatuses").mockReturnValueOnce(statuses.promise);
    const recovery = queueRecovery();
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(
        await getDb(env).queryOne(
          "SELECT COUNT(*)::integer AS claimed FROM earn_vault_withdrawal_request_actions WHERE organization_id = ? AND observation_claim_token IS NOT NULL",
          [ORG]
        )
      ).toEqual({ claimed: 0 });
      const fast = await createPostgresEarnVaultWithdrawalRequestsRepository(
        getDb(env)
      ).claimDueObservations("sandbox", 64);
      expect(new Set(fast.rows.map(({ id }) => id))).toEqual(
        new Set(seeded.map(({ action }) => action.id))
      );
    } finally {
      statuses.resolve(
        seeded.map(() => ({
          slot: 50n,
          confirmations: 1n,
          confirmationStatus: "confirmed",
          err: null,
        }))
      );
      await recovery;
    }
  });

  it("keeps later and new actions fast-claimable while four provider reads wait", async () => {
    const seeded = await Promise.all(Array.from({ length: 16 }, () => seedQueuedAction()));
    const requests = new Map(seeded.map(({ request }) => [request.request_address, request]));
    const providerRead = deferred<void>();
    readQueuedRequest.mockImplementation(async (_scope, input) => {
      await providerRead.promise;
      const request = requests.get(input.requestAddress);
      if (!request) throw new Error("Unknown queued fixture");
      return liveQueuedRequest(request);
    });
    rpc.respondSignatureStatusesAt(5_000, () => null);
    rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: 5_000, blockHeight: 101 }));
    const recovery = queueRecovery();
    try {
      await vi.waitFor(() => expect(readQueuedRequest).toHaveBeenCalledTimes(4));
      const newcomer = await seedQueuedAction();
      await postponeQueuedProviderReads();
      const fast = await createPostgresEarnVaultWithdrawalRequestsRepository(
        getDb(env)
      ).claimDueObservations("sandbox", 64);
      expect(fast.rows).toHaveLength(13);
      const fresh = fast.rows.find(({ id }) => id === newcomer.action.id);
      if (!fresh) throw new Error("New action was blocked behind recovery");
      await runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        observeEarnWithdrawalActionStatus(
          env,
          fresh,
          { slot: 50n, confirmations: 1n, confirmationStatus: "confirmed", err: null },
          createClusterRpc()
        )
      );
      expect(
        await getDb(env).queryOne(
          "SELECT status FROM earn_vault_withdrawal_request_actions WHERE id = ?",
          [fresh.id]
        )
      ).toEqual({ status: "confirmed" });
      expect(readQueuedRequest).toHaveBeenCalledTimes(4);
    } finally {
      providerRead.resolve();
      await recovery;
    }
  });

  it.each(["absence marker", "signed bytes"] as const)(
    "refuses cached absence after %s changes",
    async (changed) => {
      const seeded = await seedQueuedAction();
      const statuses = deferred<Array<solanaRpc.SignatureStatusInfo | null>>();
      const read = vi
        .spyOn(solanaRpc, "getSignatureStatuses")
        .mockReturnValueOnce(statuses.promise);
      rpc.respondSignatureStatusesAt(5_000, () => null);
      rpc.answer("getEpochInfo", epochInfoResult({ absoluteSlot: 5_000, blockHeight: 101 }));
      const recovery = queueRecovery();
      const outcome =
        changed === "signed bytes"
          ? expect(recovery).rejects.toThrow("reconciliation had 1 errors")
          : expect(recovery).resolves.toBeUndefined();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      if (changed === "absence marker") {
        await getDb(env).execute(
          "UPDATE earn_vault_withdrawal_request_actions SET absent_creation_observed_at = sdp_iso_now() WHERE id = ?",
          [seeded.action.id]
        );
      } else {
        await getDb(env).execute(
          "UPDATE earn_vault_withdrawal_request_actions SET signed_transaction = 'Ag==' WHERE id = ?",
          [seeded.action.id]
        );
      }
      statuses.resolve([null]);
      await outcome;
      expect(readQueuedRequest).not.toHaveBeenCalled();
      expect(
        rpc.calls.some(({ method }) => method === "sendTransaction" || method === "getTransaction")
      ).toBe(false);
      expect(
        await getDb(env).queryOne(
          "SELECT status FROM earn_vault_withdrawal_request_actions WHERE id = ?",
          [seeded.action.id]
        )
      ).toEqual({ status: "requested" });
    }
  );
});
