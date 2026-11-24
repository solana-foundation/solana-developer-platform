import { beforeEach, describe, expect, it } from "vitest";
import { asTransactionalClient, getDb } from "@/db/client";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import {
  type CreateSignedQueuedWithdrawalRequestInput,
  createPostgresEarnVaultWithdrawalRequestsRepository,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import {
  createOperationsRepository,
  type OperationScope,
} from "@/db/repositories/operations.repository";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const OWNER = "7YfHastraReleaseOwner11111111111111111111111";
const VAULT = "8VfHastraReleaseVault11111111111111111111111";
const TOKEN = "9VfHastraReleaseToken11111111111111111111111";
const SHARES = "AVfHastraReleaseShares1111111111111111111111";
const INTERMEDIATE = "BVfHastraReleaseWylds1111111111111111111111";
const PDA = "CVfHastraReleaseRequest111111111111111111111";
const USER = "user_redemption_release";
const scope: OperationScope = {
  organizationId: "org_release",
  projectId: "prj_org_release_sandbox",
  environment: "sandbox",
};
const foreign: OperationScope = {
  organizationId: "org_release_other",
  projectId: "prj_org_release_other_sandbox",
  environment: "sandbox",
};
const position = (s: OperationScope) => `position_${s.organizationId}`;
const queues = () => createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
const operations = () => createOperationsRepository(getDb(env));

async function prepare(id: string, s = scope) {
  await queues().createWalletTransaction({
    ...s,
    id,
    provider: "hastra",
    positionId: position(s),
    action: "cancel",
    operationOnly: true,
    ownerAddress: OWNER,
    vaultAddress: VAULT,
    tokenMint: TOKEN,
    shareMint: SHARES,
    requestAddress: PDA,
    mechanism: "operator_redemption",
    shareDecimals: 6,
    assetDecimals: 6,
    intermediateMint: INTERMEDIATE,
    unsignedTransaction: "AQ==",
    lastValidBlockHeight: "1000",
  });
  const { record } = await operations().createOrReplay({
    ...s,
    source: { ownerAddress: OWNER },
    intent: { kind: "earn.withdraw", positionId: position(s), amount: { kind: "all" } },
    principal: { kind: "member", userId: USER },
    requestKey: id,
    fingerprint: id,
    prepared: {
      nextAction: {
        type: "sign_transaction",
        transaction: "AQ==",
        lastValidBlockHeight: "1000",
        expiresAt: null,
      },
      buildRef: { kind: "earn.queued_transaction", id },
      terms: {
        expiresAt: null,
        estimate: null,
        minimum: null,
        fees: null,
        options: [
          {
            id: "release_current_redemption",
            mechanism: "release_current_redemption",
            label: "Release current redemption",
            settlement: "instant",
            estimatedSeconds: null,
          },
        ],
      },
    },
  });
  const claim = await operations().claimAction(s, record.operation.id, record.operation);
  const signed = {
    signedTransaction: `signed-${id}`,
    signature: `signature-${id}`,
    lastValidBlockHeight: "1000",
  };
  return { claim, signed, input: { ...s, transactionId: id, attemptId: claim.attempt.id } };
}
async function lease() {
  return getDb(env).queryOne<{ lease_token: string; occupied: boolean; expires_at: string }>(
    "SELECT lease_token, occupied, expires_at FROM earn_vault_withdrawal_request_pda_leases WHERE environment = 'sandbox' AND request_address = ?",
    [PDA]
  );
}
async function pendingRequest(id = "historical_A", repository = queues()) {
  const input = {
    ...scope,
    id: `reservation_${id}`,
    provider: "hastra",
    vaultAddress: VAULT,
    ownerAddress: OWNER,
    requestAddress: PDA,
    clientRequestId: id,
    idempotencyFingerprint: id,
    expiresAt: "2099-01-01T00:00:00.000Z",
    mechanism: "operator_redemption" as const,
  };
  await repository.acquireRequestReservation(input);
  await repository.createSignedRequest({
    ...input,
    requestId: id,
    actionId: `action_${id}`,
    positionId: position(scope),
    tokenMint: TOKEN,
    shareMint: SHARES,
    shares: "10",
    quotedAssets: "10",
    shareDecimals: 6,
    assetDecimals: 6,
    intermediateMint: INTERMEDIATE,
    intermediateAmount: "10",
    signature: `request_signature_${id}`,
    signedTransaction: "AQ==",
    lastValidBlockHeight: "900",
    pdaLeaseToken: input.id,
  });
  await repository.advanceRequest({
    organizationId: scope.organizationId,
    withdrawalRequestId: id,
    toStatus: "pending",
  });
  return id;
}
async function retainedParBuild(
  id: string,
  repository = queues(),
  discovered = false
): Promise<CreateSignedQueuedWithdrawalRequestInput> {
  const strategyId = "strategy_release_hastra";
  if (discovered)
    await getDb(env).execute(
      `INSERT INTO earn_strategies (id, provider, provider_reference, name, source_kind,
      deposit_mints, share_mint, apy_type, liquidity_term, environment, host_cluster)
     VALUES (?, 'hastra', ?, 'Hastra', 'vault', ?::jsonb, ?, 'variable', 'delayed', 'sandbox', 'devnet')
     ON CONFLICT DO NOTHING`,
      [strategyId, VAULT, JSON.stringify([TOKEN]), SHARES]
    );
  await repository.createWalletTransaction({
    ...scope,
    id,
    provider: "hastra",
    positionId: discovered ? null : position(scope),
    strategyId: discovered ? strategyId : undefined,
    action: "request",
    mechanism: "operator_redemption",
    ownerAddress: OWNER,
    vaultAddress: VAULT,
    tokenMint: TOKEN,
    shareMint: SHARES,
    requestAddress: PDA,
    shares: "10",
    quotedAssets: "10",
    shareDecimals: 6,
    assetDecimals: 6,
    intermediateMint: INTERMEDIATE,
    intermediateAmount: "10",
    unsignedTransaction: "AQ==",
    lastValidBlockHeight: "1000",
    currentBlockHeight: "100",
  });
  return {
    ...scope,
    provider: "hastra",
    requestId: `request_${id}`,
    actionId: `action_${id}`,
    positionId: discovered ? `discovered:${strategyId}` : position(scope),
    ...(discovered
      ? {
          discoveredPosition: {
            ...scope,
            provider: "hastra",
            strategyId,
            strategyReference: VAULT,
            tokenMint: TOKEN,
            shareMint: SHARES,
            label: "Hastra",
            source: { ownerAddress: OWNER },
          },
        }
      : {}),
    ownerAddress: OWNER,
    vaultAddress: VAULT,
    tokenMint: TOKEN,
    shareMint: SHARES,
    requestAddress: PDA,
    mechanism: "operator_redemption",
    shares: "10",
    quotedAssets: "10",
    shareDecimals: 6,
    assetDecimals: 6,
    intermediateMint: INTERMEDIATE,
    intermediateAmount: "10",
    signature: `signature_${id}`,
    signedTransaction: "AQ==",
    lastValidBlockHeight: "1000",
    clientRequestId: id,
    idempotencyFingerprint: id,
    pdaLeaseToken: id,
    walletTransactionId: id,
  };
}

async function fail(prepared: Awaited<ReturnType<typeof prepare>>) {
  return operations().transition(scope, prepared.claim, {
    status: "failed",
    nextAction: null,
    resourceRef: null,
    error: { code: "TRANSACTION_FAILED", message: "Definitive rejection" },
  });
}

describe("current redemption release storage", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'release@example.com', 1, 'active')",
      [USER]
    );
    for (const s of [scope, foreign]) {
      await db.execute(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')",
        [s.organizationId, s.organizationId, s.organizationId]
      );
      await seedDefaultProjects(db, {
        organizationId: s.organizationId,
        createdBy: USER,
        members: [],
      });
      await db.execute(
        `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider, kind,
        owner_address, vault_address, share_mint, token_mint, label, activated_at)
        VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, 'Hastra', sdp_iso_now())`,
        [position(s), s.organizationId, s.projectId, OWNER, VAULT, SHARES, TOKEN]
      );
    }
  });

  it("preparation leaves the PDA free; acceptance binds the exact attempt and signed bytes", async () => {
    const p = await prepare("release_1");
    expect(await lease()).toBeNull();
    await expect(
      queues().consumeCurrentRedemptionRelease({ ...p.input, ...p.signed })
    ).rejects.toThrow("accepted signed attempt");
    await operations().requestExecution(scope, p.claim, p.signed);
    expect(await lease()).toMatchObject({ lease_token: "release_1", occupied: true });
    await expect(
      queues().consumeCurrentRedemptionRelease({ ...p.input, ...p.signed })
    ).resolves.toMatchObject({ consumed_attempt_id: p.claim.attempt.id });
    await expect(
      queues().consumeCurrentRedemptionRelease({
        ...p.input,
        ...p.signed,
        signature: "another_signature",
      })
    ).rejects.toThrow("accepted signed attempt");
    await expect(
      queues().recordCurrentRedemptionReleaseFinalized({ ...p.input, projectId: foreign.projectId })
    ).rejects.toThrow("not found");
  });

  it("serializes concurrent releases across tenants and rolls back the losing acceptance", async () => {
    const first = await prepare("release_1");
    const second = await prepare("release_2", foreign);
    const results = await Promise.allSettled([
      runWithTenantDatabaseIdentity(scope, () =>
        operations().requestExecution(scope, first.claim, first.signed)
      ),
      runWithTenantDatabaseIdentity(foreign, () =>
        operations().requestExecution(foreign, second.claim, second.signed)
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const attempts = await getDb(env).queryMany<{ execution_requested_at: string | null }>(
      "SELECT execution_requested_at FROM operation_attempts ORDER BY id"
    );
    expect(attempts.filter((a) => a.execution_requested_at !== null)).toHaveLength(1);
    expect(await lease()).toMatchObject({ occupied: true, expires_at: "9999-12-31T23:59:59.999Z" });
  });

  it("keeps the lease occupied for uncertain work and blocks new requests", async () => {
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    await operations().release(scope, p.claim);
    await queues().cleanupExpiredWalletBuilds({
      environment: "sandbox",
      currentBlockHeight: "99999",
    });
    expect(await lease()).toMatchObject({ lease_token: "release_1", occupied: true });
    await expect(pendingRequest()).rejects.toThrow("redemption request");
  });

  it("restores the historical request fence after definitive failure without changing its financial row", async () => {
    await pendingRequest();
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    await fail(p);
    expect(await lease()).toMatchObject({ lease_token: "historical_A", occupied: true });
    expect(
      await getDb(env).queryOne(
        "SELECT status, cancel_signature FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
      )
    ).toEqual({ status: "pending", cancel_signature: null });
  });

  it.each([false, true])(
    "does not restore a previously released request after a later release fails (signed=%s)",
    async (signed) => {
      await pendingRequest();
      const first = await prepare("release_1");
      await operations().requestExecution(scope, first.claim, first.signed);
      await queues().recordCurrentRedemptionReleaseFinalized(first.input);
      await operations().transition(scope, first.claim, {
        status: "queued",
        nextAction: null,
        resourceRef: null,
        error: null,
      });
      await operations().transition(scope, first.claim, {
        status: "completed",
        nextAction: null,
        resourceRef: { kind: "earn.redemption_release", id: "release_1" },
        error: null,
      });
      await getDb(env).execute(
        "UPDATE earn_vault_withdrawal_request_pda_leases SET expires_at = '2000-01-01', reuse_not_before = '2000-01-01' WHERE lease_token = 'release_1'"
      );

      const second = await prepare("release_2");
      await operations().requestExecution(scope, second.claim, signed ? second.signed : undefined);
      await fail(second);

      expect(await lease()).toMatchObject({ lease_token: "release_2", occupied: false });
      await expect(
        queues().findCurrentRedemptionRequest({
          ...scope,
          positionId: position(scope),
          ownerAddress: OWNER,
          custodyWalletId: null,
        })
      ).resolves.toBeNull();
      await expect(
        queues().isRequestFencedByCurrentRedemptionRelease({
          ...scope,
          withdrawalRequestId: "historical_A",
        })
      ).resolves.toBe(true);
      expect(
        await getDb(env).queryOne(
          "SELECT status, closing_signature FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
        )
      ).toEqual({ status: "pending", closing_signature: null });

      await getDb(env).execute(
        "UPDATE earn_vault_withdrawal_request_pda_leases SET expires_at = '2000-01-01', reuse_not_before = '2000-01-01' WHERE lease_token = 'release_2'"
      );
      await expect(
        queues().acquireRequestReservation({
          ...scope,
          id: "fresh_redemption",
          provider: "hastra",
          vaultAddress: VAULT,
          ownerAddress: OWNER,
          requestAddress: PDA,
          clientRequestId: "fresh_redemption",
          idempotencyFingerprint: "fresh_redemption",
          expiresAt: "2099-01-01T00:00:00.000Z",
          mechanism: "operator_redemption",
        })
      ).resolves.toBeUndefined();
    }
  );

  it("keeps one immutable absence marker, and an expiry failure frees the address for a new release", async () => {
    await pendingRequest();
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    const first = await queues().recordCurrentRedemptionReleaseAbsent(p.input);
    expect(first.release_absence_observed_at).toEqual(expect.any(String));
    const again = await queues().recordCurrentRedemptionReleaseAbsent(p.input);
    expect(again.release_absence_observed_at).toBe(first.release_absence_observed_at);
    await expect(
      getDb(env).execute(
        "UPDATE earn_wallet_withdrawal_request_transactions SET release_absence_observed_at = '2000-01-01T00:00:00.000Z' WHERE id = 'release_1'"
      )
    ).rejects.toThrow("absence observation is immutable");
    await operations().transition(scope, p.claim, {
      status: "failed",
      nextAction: null,
      resourceRef: null,
      error: {
        code: "TRANSACTION_EXPIRED",
        message: "The current redemption release expired before it landed",
      },
    });
    expect(
      await queues().isRequestFencedByCurrentRedemptionRelease({
        organizationId: scope.organizationId,
        environment: scope.environment,
        withdrawalRequestId: "historical_A",
      })
    ).toBe(false);
    expect(await lease()).toMatchObject({ lease_token: "historical_A", occupied: true });
    const next = await prepare("release_2");
    await operations().requestExecution(scope, next.claim, next.signed);
    expect(await lease()).toMatchObject({ lease_token: "release_2", occupied: true });
  });

  it("rejects cross-scope consumption and restores occupancy after a pre-sign refusal", async () => {
    await pendingRequest();
    const p = await prepare("release_1");
    const other = await prepare("release_other", foreign);
    await expect(
      getDb(env).execute(
        `UPDATE earn_wallet_withdrawal_request_transactions SET consumed_attempt_id = ?, consumed_at = sdp_iso_now()
       WHERE id = 'release_1'`,
        [other.claim.attempt.id]
      )
    ).rejects.toThrow("accepted operation attempt");
    await operations().requestExecution(scope, p.claim);
    await expect(queues().recordCurrentRedemptionReleaseFinalized(p.input)).rejects.toThrow(
      "accepted signed attempt"
    );
    await fail(p);
    expect(await lease()).toMatchObject({ lease_token: "historical_A", occupied: true });
  });

  it("allows a terminal A before acceptance and fences its later cleanup", async () => {
    await pendingRequest();
    const p = await prepare("release_1");
    await queues().advanceRequest({
      organizationId: scope.organizationId,
      withdrawalRequestId: "historical_A",
      toStatus: "cancelled",
      closingSignature: "external_close_A",
    });
    await operations().requestExecution(scope, p.claim, p.signed);
    expect(await lease()).toMatchObject({ lease_token: "release_1", occupied: true });
  });

  it("ends active tracking from finalized release proof without changing financial history", async () => {
    await pendingRequest();
    await queues().advanceAction({
      actionId: "action_historical_A",
      organizationId: scope.organizationId,
      toStatus: "confirmed",
    });
    const requestScope = { ...scope, withdrawalRequestId: "historical_A" };
    const historical = await getDb(env).queryOne(
      "SELECT status, closing_signature, assets_paid, fulfilled_at, cancelled_at FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
    );
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    await expect(queues().findSupersedingRedemptionRelease(requestScope)).resolves.toBeNull();
    await expect(
      queues().claimUnsettledActions({ environment: "sandbox", limit: 10 })
    ).resolves.toHaveLength(1);
    await expect(
      queues().claimOpenRequests({ environment: "sandbox", limit: 10 })
    ).resolves.toHaveLength(1);
    expect((await queues().list({ ...scope, settled: false, limit: 10 })).rows).toHaveLength(1);

    const [, staleObservation] = await Promise.all([
      queues().recordCurrentRedemptionReleaseFinalized(p.input),
      queues().advanceRequest({
        ...requestScope,
        toStatus: "fulfilled",
        assetsPaid: "10",
        closingSignature: "replacement_B_signature",
      }),
    ]);
    expect(staleObservation).toBeNull();
    await expect(queues().findSupersedingRedemptionRelease(requestScope)).resolves.toEqual({
      id: "release_1",
      finalizedAt: expect.any(String),
    });
    for (const changed of [
      { organizationId: foreign.organizationId },
      { projectId: foreign.projectId },
      { environment: "production" as const },
      { withdrawalRequestId: "foreign_request" },
    ]) {
      await expect(
        queues().findSupersedingRedemptionRelease({ ...requestScope, ...changed })
      ).resolves.toBeNull();
    }
    await expect(
      queues().claimUnsettledActions({ environment: "sandbox", limit: 10 })
    ).resolves.toEqual([]);
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_requests SET next_check_at = '2000-01-01' WHERE id = 'historical_A'"
    );
    await expect(
      queues().claimOpenRequests({ environment: "sandbox", limit: 10 })
    ).resolves.toEqual([]);
    expect((await queues().list({ ...scope, settled: false, limit: 10 })).rows).toEqual([]);
    expect(
      await getDb(env).queryOne(
        "SELECT status, closing_signature, assets_paid, fulfilled_at, cancelled_at FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
      )
    ).toEqual(historical);
    expect(await getDb(env).queryOne("SELECT COUNT(*)::int AS count FROM earn_movements")).toEqual({
      count: 0,
    });
  });

  it("preserves an already terminal historical request despite a later release", async () => {
    await pendingRequest();
    await queues().advanceRequest({
      organizationId: scope.organizationId,
      withdrawalRequestId: "historical_A",
      toStatus: "cancelled",
      closingSignature: "historical_cancellation",
    });
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    await queues().recordCurrentRedemptionReleaseFinalized(p.input);
    await expect(
      queues().findSupersedingRedemptionRelease({ ...scope, withdrawalRequestId: "historical_A" })
    ).resolves.toBeNull();
    expect(
      await getDb(env).queryOne(
        "SELECT status, closing_signature FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
      )
    ).toEqual({ status: "cancelled", closing_signature: "historical_cancellation" });
  });

  it("fences stale financial observations after acceptance and lifts only after definite failure", async () => {
    await pendingRequest();
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    const oldRequest = {
      organizationId: scope.organizationId,
      environment: scope.environment,
      withdrawalRequestId: "historical_A",
    };
    expect(await queues().isRequestFencedByCurrentRedemptionRelease(oldRequest)).toBe(true);
    for (const toStatus of ["fulfilled", "cancelled", "pending"] as const) {
      await expect(
        queues().advanceRequest({
          ...oldRequest,
          toStatus,
          closingSignature: "replacement_B_signature",
          assetsPaid: "10",
        })
      ).resolves.toBeNull();
    }
    await expect(
      queues().createSignedCancel({
        ...scope,
        actionId: "old_cancel_A",
        withdrawalRequestId: "historical_A",
        signature: "old_cancel_signature",
        signedTransaction: "AQ==",
        lastValidBlockHeight: "1000",
        clientRequestId: "old_cancel_A",
        idempotencyFingerprint: "old_cancel_A",
      })
    ).rejects.toThrow("fenced by a current release");
    await expect(
      queues().failActionAndRecoverRequest({
        actionId: "action_historical_A",
        organizationId: scope.organizationId,
        failureReason: "Stale absence observation",
      })
    ).resolves.toBeNull();
    expect(await getDb(env).queryOne("SELECT COUNT(*)::int AS count FROM earn_movements")).toEqual({
      count: 0,
    });
    expect(
      await getDb(env).queryOne(
        "SELECT status, closing_signature FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
      )
    ).toEqual({ status: "pending", closing_signature: null });
    expect(await lease()).toMatchObject({ lease_token: "release_1", occupied: true });
    await fail(p);
    expect(await queues().isRequestFencedByCurrentRedemptionRelease(oldRequest)).toBe(false);
    expect(await lease()).toMatchObject({ lease_token: "historical_A", occupied: true });
  });

  it.each([false, true])(
    "fences late finalized adoption from an old build (discovered=%s)",
    async (discovered) => {
      // These bytes and finalized creation evidence were retained before the
      // release. The provider's earlier successful read cannot authorize a
      // fresh domain row after a later cycle was released.
      const old = await retainedParBuild("old_A", queues(), discovered);
      await queues().cleanupExpiredWalletBuilds({
        environment: "sandbox",
        currentBlockHeight: "2000",
      });
      const p = await prepare("release_1");
      await operations().requestExecution(scope, p.claim, p.signed);
      for (const recoverFinalizedWalletBuild of [false, true]) {
        await expect(
          queues().createSignedRequest({ ...old, recoverFinalizedWalletBuild })
        ).rejects.toThrow("predates a current redemption release");
      }
      await queues().recordCurrentRedemptionReleaseFinalized(p.input);
      await operations().transition(scope, p.claim, {
        status: "queued",
        nextAction: null,
        resourceRef: null,
        error: null,
      });
      await operations().transition(scope, p.claim, {
        status: "completed",
        nextAction: null,
        resourceRef: { kind: "earn.redemption_release", id: "release_1" },
        error: null,
      });
      await expect(
        queues().createSignedRequest({ ...old, recoverFinalizedWalletBuild: true })
      ).rejects.toThrow("predates a current redemption release");
      expect(
        await getDb(env).queryOne(
          "SELECT COUNT(*)::int AS count FROM earn_vault_withdrawal_requests"
        )
      ).toEqual({ count: 0 });
      expect(
        await getDb(env).queryOne(
          "SELECT COUNT(*)::int AS count FROM earn_vault_withdrawal_request_actions"
        )
      ).toEqual({ count: 0 });
    }
  );

  it("lifts the old-build fence only after definitive no-effects failure", async () => {
    const old = await retainedParBuild("old_A");
    await queues().cleanupExpiredWalletBuilds({
      environment: "sandbox",
      currentBlockHeight: "2000",
    });
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    await expect(
      queues().createSignedRequest({
        ...old,
        recoverFinalizedWalletBuild: true,
        ownerAddress: "DVfOtherHastraOwner1111111111111111111111111",
      })
    ).rejects.toThrow("does not match its canonical build");
    await fail(p);
    await expect(
      queues().createSignedRequest({ ...old, recoverFinalizedWalletBuild: true })
    ).resolves.toMatchObject({ request: { status: "creating" } });
  });

  it("does not backdate a new request whose transaction began before release acceptance", async () => {
    const p = await prepare("release_1");
    let signalBegun = () => {};
    let continueNewRequest = () => {};
    const begun = new Promise<void>((resolve) => {
      signalBegun = resolve;
    });
    const released = new Promise<void>((resolve) => {
      continueNewRequest = resolve;
    });
    const newRequest = getDb(env).transaction(async (tx) => {
      await tx.queryOne("SELECT now()");
      signalBegun();
      await released;
      const repository = createPostgresEarnVaultWithdrawalRequestsRepository(
        asTransactionalClient(tx)
      );
      const fresh = await retainedParBuild("replacement_B", repository);
      const result = await repository.createSignedRequest(fresh);
      await repository.advanceRequest({
        ...scope,
        withdrawalRequestId: result.request.id,
        toStatus: "pending",
      });
      return result.request.id;
    });
    await begun;
    try {
      await operations().requestExecution(scope, p.claim, p.signed);
      await queues().recordCurrentRedemptionReleaseFinalized(p.input);
      await operations().transition(scope, p.claim, {
        status: "queued",
        nextAction: null,
        resourceRef: null,
        error: null,
      });
      await operations().transition(scope, p.claim, {
        status: "completed",
        nextAction: null,
        resourceRef: { kind: "earn.redemption_release", id: "release_1" },
        error: null,
      });
      await getDb(env).execute(
        "UPDATE earn_vault_withdrawal_request_pda_leases SET expires_at = '2000-01-01', reuse_not_before = '2000-01-01' WHERE lease_token = 'release_1'"
      );
    } finally {
      continueNewRequest();
    }
    await newRequest;
    await expect(
      queues().isRequestFencedByCurrentRedemptionRelease({
        ...scope,
        withdrawalRequestId: "request_replacement_B",
      })
    ).resolves.toBe(false);
    expect(
      await getDb(env).queryOne(
        "SELECT status FROM earn_vault_withdrawal_requests WHERE id = 'request_replacement_B'"
      )
    ).toEqual({ status: "pending" });
  });

  it("retains immutable receipt replay and cools a successful release without cancelling old A", async () => {
    await pendingRequest();
    const p = await prepare("release_1");
    await operations().requestExecution(scope, p.claim, p.signed);
    const recorded = await queues().recordCurrentRedemptionReleaseFinalized(p.input);
    await queues().recordCurrentRedemptionReleaseFinalized(p.input);
    await operations().transition(scope, p.claim, {
      status: "queued",
      nextAction: null,
      resourceRef: null,
      error: null,
    });
    await operations().transition(scope, p.claim, {
      status: "completed",
      nextAction: null,
      resourceRef: { kind: "earn.redemption_release", id: "release_1" },
      error: null,
    });
    expect(await lease()).toMatchObject({ occupied: false });
    await expect(
      queues().advanceRequest({
        organizationId: scope.organizationId,
        withdrawalRequestId: "historical_A",
        toStatus: "fulfilled",
        closingSignature: "replacement_B_signature",
        assetsPaid: "10",
      })
    ).resolves.toBeNull();
    await expect(
      queues().consumeCurrentRedemptionRelease({ ...p.input, ...p.signed })
    ).resolves.toMatchObject({ release_finalized_at: recorded.release_finalized_at });
    expect(
      await getDb(env).queryOne(
        "SELECT status, cancel_signature FROM earn_vault_withdrawal_requests WHERE id = 'historical_A'"
      )
    ).toEqual({ status: "pending", cancel_signature: null });
    for (const [column, value] of [
      ["consumed_attempt_id", null],
      ["unsigned_transaction", "changed"],
      ["release_finalized_at", null],
    ]) {
      await expect(
        getDb(env).execute(
          `UPDATE earn_wallet_withdrawal_request_transactions SET ${column} = ? WHERE id = 'release_1'`,
          [value]
        )
      ).rejects.toThrow("immutable");
    }
    // Only occupancy changes. Historical A is still unknown; a live provider
    // check and the existing finality cooldown independently gate actual reuse.
    await getDb(env).execute(
      "UPDATE earn_vault_withdrawal_request_pda_leases SET expires_at = '2000-01-01', reuse_not_before = '2000-01-01' WHERE lease_token = 'release_1'"
    );
    // Parent rollout retains historical uniqueness. The schema-only cleanup
    // removes it after these guards serve; run this test against both schemas.
    const index = await getDb(env).queryOne<{ name: string | null }>(
      "SELECT to_regclass('idx_earn_vault_withdrawal_requests_operator_live_address')::text AS name"
    );
    if (index === null) throw new Error("Missing schema index observation");
    if (index.name !== null) {
      await expect(pendingRequest("replacement_B")).rejects.toThrow(
        "idx_earn_vault_withdrawal_requests_operator_live_address"
      );
    } else {
      await expect(pendingRequest("replacement_B")).resolves.toBe("replacement_B");
      await expect(pendingRequest("replacement_C")).rejects.toThrow("request address");
    }
  });
});
