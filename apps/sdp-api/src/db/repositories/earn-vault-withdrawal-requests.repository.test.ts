import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  type CreateSignedQueuedWithdrawalRequestInput,
  createPostgresEarnVaultWithdrawalRequestsRepository,
  type EarnVaultWithdrawalRequestsRepository,
} from "./earn-vault-withdrawal-requests.repository";

const ORG = "org_queued_withdrawal_repo";
const OTHER_ORG = "org_queued_withdrawal_repo_other";
const USER = "usr_queued_withdrawal_repo";
const PROJECT = "prj_queued_withdrawal_repo";
const OTHER_PROJECT = "prj_queued_withdrawal_repo_other";
const CONFIG = "cfg_queued_withdrawal_repo";
const WALLET = "cwlt_queued_withdrawal_repo";
const OWNER = "7YfVedaQueueOwner111111111111111111111111111";
const VAULT = "8VfVedaQueueVault111111111111111111111111111";
const TOKEN_MINT = "9VfVedaQueueToken111111111111111111111111111";
const SHARE_MINT = "AVfVedaQueueShare111111111111111111111111111";
const POSITION = "earn_position_queued_withdrawal_repo";
const EXTERNAL_POSITION = "earn_position_queued_withdrawal_repo_external";
const OTHER_EXTERNAL_POSITION = "earn_position_queued_withdrawal_repo_other_external";
const EXTERNAL_OWNER = "CVfExternalQueueOwner11111111111111111111111";

describe("Earn queued withdrawal repository", () => {
  let repository: EarnVaultWithdrawalRequestsRepository;
  let sequence = 0;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    for (const table of [
      "earn_external_wallet_withdrawal_request_transactions",
      "earn_vault_withdrawal_request_actions",
      "earn_vault_withdrawal_request_reservations",
      "earn_vault_withdrawal_request_pda_leases",
      "earn_vault_withdrawal_requests",
      "earn_movements",
      "earn_positions",
      "custody_wallets",
      "custody_configs",
      "projects",
      "organizations",
      "users",
    ]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'queued-withdrawal-repo@example.com', 1, 'active')`
      )
      .bind(USER)
      .run();
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status) VALUES
          (?, 'Queued Withdrawal Repo', 'queued-withdrawal-repo', 'enterprise', 'active'),
          (?, 'Queued Withdrawal Other', 'queued-withdrawal-other', 'enterprise', 'active')`
      )
      .bind(ORG, OTHER_ORG)
      .run();
    await seedDefaultProjects(db, {
      organizationId: ORG,
      createdBy: USER,
      members: [],
      ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
    });
    await seedDefaultProjects(db, {
      organizationId: OTHER_ORG,
      createdBy: USER,
      members: [],
      ids: { sandbox: OTHER_PROJECT, production: `${OTHER_PROJECT}_production` },
    });
    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, NULL, 'local', 'encrypted', 'active')`
      )
      .bind(CONFIG, ORG)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, 'queued-wallet', ?, 'active')`
      )
      .bind(WALLET, CONFIG, OWNER)
      .run();
    await db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           custody_wallet_id, vault_address, share_mint, token_mint, label,
           activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'veda', 'vault_direct', ?, ?, ?, ?,
                   'Veda queued vault', sdp_iso_now())`
      )
      .bind(POSITION, ORG, PROJECT, WALLET, VAULT, SHARE_MINT, TOKEN_MINT)
      .run();
    await db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           owner_address, vault_address, share_mint, token_mint, label,
           activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'veda', 'vault_direct', ?, ?, ?, ?,
                   'External Veda queued vault', sdp_iso_now())`
      )
      .bind(EXTERNAL_POSITION, ORG, PROJECT, EXTERNAL_OWNER, VAULT, SHARE_MINT, TOKEN_MINT)
      .run();
    await db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           owner_address, vault_address, share_mint, token_mint, label,
           activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'veda', 'vault_direct', ?, ?, ?, ?,
                   'Other external Veda queued vault', sdp_iso_now())`
      )
      .bind(
        OTHER_EXTERNAL_POSITION,
        OTHER_ORG,
        OTHER_PROJECT,
        EXTERNAL_OWNER,
        VAULT,
        SHARE_MINT,
        TOKEN_MINT
      )
      .run();
    repository = createPostgresEarnVaultWithdrawalRequestsRepository(db);
    sequence = 0;
  });

  function requestInput(
    overrides: Partial<CreateSignedQueuedWithdrawalRequestInput> = {}
  ): CreateSignedQueuedWithdrawalRequestInput {
    sequence += 1;
    return {
      requestId: `earn_vault_withdrawal_request_${sequence}`,
      actionId: `earn_vault_withdrawal_action_${sequence}`,
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "veda",
      positionId: POSITION,
      custodyWalletId: WALLET,
      ownerAddress: OWNER,
      vaultAddress: VAULT,
      tokenMint: TOKEN_MINT,
      shareMint: SHARE_MINT,
      requestAddress: `QueueRequestAddress${String(sequence).padStart(20, "1")}`,
      shares: "10",
      quotedAssets: "9.9",
      shareDecimals: 6,
      assetDecimals: 6,
      discountBps: 25,
      maturityTimestamp: "1700000060",
      deadlineTimestamp: "1700000120",
      signature: `queued-request-signature-${sequence}`,
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      clientRequestId: `queued-request-key-${sequence}`,
      idempotencyFingerprint: `queued-request-fingerprint-${sequence}`,
      pdaLeaseToken: `earn_vault_withdrawal_reservation_test_${sequence}`,
      createdBy: USER,
      ...overrides,
    };
  }

  async function reserveInput(
    input: CreateSignedQueuedWithdrawalRequestInput
  ): Promise<CreateSignedQueuedWithdrawalRequestInput> {
    await repository.acquireRequestReservation({
      id: input.pdaLeaseToken,
      organizationId: input.organizationId,
      projectId: input.projectId,
      environment: input.environment,
      provider: input.provider,
      vaultAddress: input.vaultAddress,
      ownerAddress: input.ownerAddress,
      requestAddress: input.requestAddress,
      clientRequestId: input.clientRequestId,
      idempotencyFingerprint: input.idempotencyFingerprint,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    return input;
  }

  async function createRequest(overrides: Partial<CreateSignedQueuedWithdrawalRequestInput> = {}) {
    const input = await reserveInput(requestInput(overrides));
    return repository.createSignedRequest(input);
  }

  it("replays an identical create and rejects a divergent use of the same key", async () => {
    const input = await reserveInput(requestInput());
    const first = await repository.createSignedRequest(input);
    const replay = await repository.createSignedRequest({
      ...input,
      requestId: "earn_vault_withdrawal_request_loser",
      actionId: "earn_vault_withdrawal_action_loser",
    });
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({
      replayed: true,
      request: { id: first.request.id },
      action: { id: first.action.id },
    });
    await expect(
      repository.createSignedRequest({ ...input, idempotencyFingerprint: "different" })
    ).rejects.toThrow(/different request payload/i);
    await expect(
      repository.createSignedRequest({
        ...input,
        projectId: `${PROJECT}_production`,
      })
    ).rejects.toThrow(/different request payload/i);
  });

  it("returns the winner to concurrent identical request submissions", async () => {
    const winnerInput = requestInput();
    const loserInput = {
      ...winnerInput,
      requestId: "earn_vault_withdrawal_request_concurrent_loser",
      actionId: "earn_vault_withdrawal_action_concurrent_loser",
      signature: "queued-request-signature-concurrent-loser",
    };
    await reserveInput(winnerInput);
    const results = await Promise.all([
      repository.createSignedRequest(winnerInput),
      repository.createSignedRequest(loserInput),
    ]);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
    expect(new Set(results.map(({ request }) => request.id))).toEqual(
      new Set([results[0]?.request.id])
    );
    expect(new Set(results.map(({ action }) => action.id))).toEqual(
      new Set([results[0]?.action.id])
    );
  });

  it("lets a definitively failed create reuse its provider PDA", async () => {
    const first = await createRequest();
    const failed = await repository.failActionAndRecoverRequest({
      actionId: first.action.id,
      organizationId: ORG,
      failureReason: "simulation rejected",
    });
    expect(failed).toMatchObject({
      action: { status: "failed", failure_reason: "simulation rejected" },
      request: { status: "failed", failure_reason: "simulation rejected" },
    });

    const retryInput = requestInput({ requestAddress: first.request.request_address });
    await reserveInput(retryInput);
    const retry = await repository.createSignedRequest(retryInput);
    expect(retry.request.id).not.toBe(first.request.id);
    await expect(
      repository.getByAddress({
        environment: "sandbox",
        provider: "veda",
        requestAddress: first.request.request_address,
      })
    ).resolves.toMatchObject({ id: retry.request.id });
  });

  it("rolls back the action when failed-create request recovery cannot commit", async () => {
    const created = await createRequest();
    const db = getDb(env);
    await db
      .prepare(
        `ALTER TABLE earn_vault_withdrawal_requests
           DROP CONSTRAINT IF EXISTS test_queued_atomic_create_failure`
      )
      .run();
    await db
      .prepare(
        `ALTER TABLE earn_vault_withdrawal_requests
           ADD CONSTRAINT test_queued_atomic_create_failure
           CHECK (status <> 'failed') NOT VALID`
      )
      .run();
    try {
      await expect(
        repository.failActionAndRecoverRequest({
          actionId: created.action.id,
          organizationId: ORG,
          failureReason: "injected request update failure",
        })
      ).rejects.toThrow(/test_queued_atomic_create_failure/i);
    } finally {
      await db
        .prepare(
          `ALTER TABLE earn_vault_withdrawal_requests
             DROP CONSTRAINT IF EXISTS test_queued_atomic_create_failure`
        )
        .run();
    }
    const state = await db
      .prepare(
        `SELECT action.status AS action_status, request.status AS request_status
           FROM earn_vault_withdrawal_request_actions action
           JOIN earn_vault_withdrawal_requests request
             ON request.id = action.withdrawal_request_id
          WHERE action.id = ?`
      )
      .bind(created.action.id)
      .first<{ action_status: string; request_status: string }>();
    expect(state).toEqual({ action_status: "requested", request_status: "creating" });
    const lease = await db
      .prepare(
        `SELECT occupied FROM earn_vault_withdrawal_request_pda_leases
          WHERE environment = 'sandbox' AND request_address = ?`
      )
      .bind(created.request.request_address)
      .first<{ occupied: boolean }>();
    expect(lease?.occupied).toBe(true);
  });

  it("retains a cross-tenant PDA occupancy claim after the request is recorded", async () => {
    const requestAddress = "SharedQueueRequestAddress111111111111111";
    await repository.acquireRequestReservation({
      id: "earn_vault_withdrawal_reservation_custody",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "veda",
      vaultAddress: VAULT,
      ownerAddress: OWNER,
      requestAddress,
      clientRequestId: "custody-reservation-key",
      idempotencyFingerprint: "custody-reservation-fingerprint",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const recorded = await repository.createSignedRequest(
      requestInput({
        requestAddress,
        pdaLeaseToken: "earn_vault_withdrawal_reservation_custody",
      })
    );
    await repository.releaseRequestReservation({
      id: "earn_vault_withdrawal_reservation_custody",
      organizationId: ORG,
    });
    const occupancy = await getDb(env)
      .prepare(
        `SELECT lease_token, occupied
           FROM earn_vault_withdrawal_request_pda_leases
          WHERE environment = 'sandbox' AND request_address = ?`
      )
      .bind(requestAddress)
      .first<{ lease_token: string; occupied: boolean }>();
    expect(occupancy).toEqual({ lease_token: recorded.request.id, occupied: true });

    await expect(
      runWithTenantDatabaseIdentity({ organizationId: OTHER_ORG }, () =>
        repository.createExternalWalletTransaction({
          id: "earn_external_wallet_withdrawal_request_transaction_collision",
          organizationId: OTHER_ORG,
          projectId: OTHER_PROJECT,
          environment: "sandbox",
          provider: "veda",
          positionId: "unused-before-lease-conflict",
          action: "request",
          ownerAddress: "BVfOtherQueueOwner11111111111111111111111111",
          vaultAddress: VAULT,
          tokenMint: TOKEN_MINT,
          shareMint: SHARE_MINT,
          requestAddress,
          shares: "1",
          quotedAssets: "0.99",
          shareDecimals: 6,
          assetDecimals: 6,
          discountBps: 25,
          maturityTimestamp: "1700000060",
          deadlineTimestamp: "1700000120",
          unsignedTransaction: "AQ==",
          lastValidBlockHeight: "20000",
          currentBlockHeight: "10000",
        })
      )
    ).rejects.toThrow(/reserves this provider nonce/i);
  });

  it("closes the consume-versus-build race by atomically promoting the shared lease", async () => {
    const requestAddress = "ConcurrentQueueRequestAddress111111111111";
    const build = await repository.createExternalWalletTransaction({
      id: "earn_external_wallet_withdrawal_request_transaction_winner",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "veda",
      positionId: EXTERNAL_POSITION,
      action: "request",
      ownerAddress: EXTERNAL_OWNER,
      vaultAddress: VAULT,
      tokenMint: TOKEN_MINT,
      shareMint: SHARE_MINT,
      requestAddress,
      shares: "1",
      quotedAssets: "0.99",
      shareDecimals: 6,
      assetDecimals: 6,
      discountBps: 25,
      maturityTimestamp: "1700000060",
      deadlineTimestamp: "1700000120",
      unsignedTransaction: "AQ==",
      lastValidBlockHeight: "20000",
      currentBlockHeight: "10000",
    });
    const signed = requestInput({
      requestAddress,
      positionId: EXTERNAL_POSITION,
      custodyWalletId: null,
      ownerAddress: EXTERNAL_OWNER,
      pdaLeaseToken: build.id,
      externalWalletTransactionId: build.id,
    });
    const [winner, contender] = await Promise.allSettled([
      repository.createSignedRequest(signed),
      repository.acquireRequestReservation({
        id: "earn_vault_withdrawal_reservation_contender",
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        provider: "veda",
        vaultAddress: VAULT,
        ownerAddress: EXTERNAL_OWNER,
        requestAddress,
        clientRequestId: "contender-key",
        idempotencyFingerprint: "contender-fingerprint",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ]);
    expect(winner.status).toBe("fulfilled");
    expect(contender.status).toBe("rejected");
    if (contender.status === "rejected") {
      // Which duplicate guard rejects first depends on statement interleaving:
      // the provider-nonce check or the request-address uniqueness check. Both
      // mean the contender lost the race to the promoted lease.
      expect(String(contender.reason)).toMatch(/provider nonce|provider request address/i);
    }
    const occupancy = await getDb(env)
      .prepare(
        `SELECT lease_token, occupied
           FROM earn_vault_withdrawal_request_pda_leases
          WHERE environment = 'sandbox' AND request_address = ?`
      )
      .bind(requestAddress)
      .first<{ lease_token: string; occupied: boolean }>();
    expect(occupancy).toEqual({ lease_token: signed.requestId, occupied: true });
  });

  it("lets another tenant take over an expired build through the shared PDA lease", async () => {
    const requestAddress = "ExpiredCrossTenantQueueRequest111111111111";
    await repository.createExternalWalletTransaction({
      id: "earn_external_wallet_withdrawal_request_transaction_expired",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "veda",
      positionId: EXTERNAL_POSITION,
      action: "request",
      ownerAddress: EXTERNAL_OWNER,
      vaultAddress: VAULT,
      tokenMint: TOKEN_MINT,
      shareMint: SHARE_MINT,
      requestAddress,
      shares: "1",
      quotedAssets: "0.99",
      shareDecimals: 6,
      assetDecimals: 6,
      discountBps: 25,
      maturityTimestamp: "1700000060",
      deadlineTimestamp: "1700000120",
      unsignedTransaction: "AQ==",
      lastValidBlockHeight: "100",
      currentBlockHeight: "50",
    });

    const successor = await runWithTenantDatabaseIdentity({ organizationId: OTHER_ORG }, () =>
      repository.createExternalWalletTransaction({
        id: "earn_external_wallet_withdrawal_request_transaction_successor",
        organizationId: OTHER_ORG,
        projectId: OTHER_PROJECT,
        environment: "sandbox",
        provider: "veda",
        positionId: OTHER_EXTERNAL_POSITION,
        action: "request",
        ownerAddress: EXTERNAL_OWNER,
        vaultAddress: VAULT,
        tokenMint: TOKEN_MINT,
        shareMint: SHARE_MINT,
        requestAddress,
        shares: "1",
        quotedAssets: "0.99",
        shareDecimals: 6,
        assetDecimals: 6,
        discountBps: 25,
        maturityTimestamp: "1700000060",
        deadlineTimestamp: "1700000120",
        unsignedTransaction: "Ag==",
        lastValidBlockHeight: "200",
        currentBlockHeight: "101",
      })
    );

    expect(successor).toMatchObject({
      id: "earn_external_wallet_withdrawal_request_transaction_successor",
      organization_id: OTHER_ORG,
    });
    const rows = await getDb(env)
      .prepare(
        `SELECT organization_id
           FROM earn_external_wallet_withdrawal_request_transactions
          WHERE environment = 'sandbox' AND request_address = ?
          ORDER BY organization_id`
      )
      .bind(requestAddress)
      .all<{ organization_id: string }>();
    expect(rows.results.map((row) => row.organization_id)).toEqual([ORG, OTHER_ORG].sort());
    const lease = await getDb(env)
      .prepare(
        `SELECT lease_token, occupied
           FROM earn_vault_withdrawal_request_pda_leases
          WHERE environment = 'sandbox' AND request_address = ?`
      )
      .bind(requestAddress)
      .first<{ lease_token: string; occupied: boolean }>();
    expect(lease).toEqual({
      lease_token: "earn_external_wallet_withdrawal_request_transaction_successor",
      occupied: false,
    });

    const stale = requestInput({
      requestAddress,
      positionId: EXTERNAL_POSITION,
      custodyWalletId: null,
      ownerAddress: EXTERNAL_OWNER,
      pdaLeaseToken: "earn_external_wallet_withdrawal_request_transaction_expired",
      externalWalletTransactionId: "earn_external_wallet_withdrawal_request_transaction_expired",
    });
    await expect(
      runWithTenantDatabaseIdentity({ organizationId: ORG }, () =>
        repository.createSignedRequest(stale)
      )
    ).rejects.toThrow(/no longer owns its provider nonce/i);
    const staleState = await getDb(env)
      .prepare(
        `SELECT consumed_action_id
           FROM earn_external_wallet_withdrawal_request_transactions
          WHERE id = 'earn_external_wallet_withdrawal_request_transaction_expired'`
      )
      .first<{ consumed_action_id: string | null }>();
    expect(staleState?.consumed_action_id).toBeNull();
    await expect(
      repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: stale.requestId,
      })
    ).resolves.toBeNull();
  });

  it("rejects custody signing after its expired lease was replaced", async () => {
    const stale = await reserveInput(requestInput());
    await getDb(env)
      .prepare(
        `UPDATE earn_vault_withdrawal_request_pda_leases
            SET expires_at = '2000-01-01T00:00:00.000Z'
          WHERE environment = ? AND request_address = ?`
      )
      .bind(stale.environment, stale.requestAddress)
      .run();
    await repository.acquireRequestReservation({
      id: "earn_vault_withdrawal_reservation_replacement",
      organizationId: ORG,
      projectId: PROJECT,
      environment: stale.environment,
      provider: stale.provider,
      vaultAddress: stale.vaultAddress,
      ownerAddress: stale.ownerAddress,
      requestAddress: stale.requestAddress,
      clientRequestId: "custody-replacement-key",
      idempotencyFingerprint: "custody-replacement-fingerprint",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(repository.createSignedRequest(stale)).rejects.toThrow(
      /no longer owns its provider nonce/i
    );
    const lease = await getDb(env)
      .prepare(
        `SELECT lease_token, occupied
           FROM earn_vault_withdrawal_request_pda_leases
          WHERE environment = ? AND request_address = ?`
      )
      .bind(stale.environment, stale.requestAddress)
      .first<{ lease_token: string; occupied: boolean }>();
    expect(lease).toEqual({
      lease_token: "earn_vault_withdrawal_reservation_replacement",
      occupied: false,
    });
  });

  it("keeps open obligations ahead of terminal history with settled=false", async () => {
    const terminal = await createRequest();
    await repository.advanceAction({
      actionId: terminal.action.id,
      organizationId: ORG,
      toStatus: "failed",
      failureReason: "never landed",
    });
    await repository.advanceRequest({
      withdrawalRequestId: terminal.request.id,
      organizationId: ORG,
      toStatus: "failed",
      failureReason: "never landed",
    });
    const open = await createRequest();
    await repository.advanceAction({
      actionId: open.action.id,
      organizationId: ORG,
      toStatus: "submitted",
    });
    await repository.advanceRequest({
      withdrawalRequestId: open.request.id,
      organizationId: ORG,
      toStatus: "pending",
      nonce: "7",
      creationTimestamp: "1700000000",
    });

    const page = await repository.list({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      custodyWalletIds: [WALLET],
      settled: false,
      limit: 1,
    });
    expect(page.rows.map(({ id }) => id)).toEqual([open.request.id]);
    expect(page.hasMore).toBe(false);
  });

  it("makes failed cancellation retryable and cancellation reopens the holding", async () => {
    const created = await createRequest();
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "expired_cancelable",
      nonce: "8",
      creationTimestamp: "1700000000",
    });
    const cancelInput = {
      actionId: "earn_vault_withdrawal_action_cancel",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox" as const,
      withdrawalRequestId: created.request.id,
      signature: "queued-cancel-signature",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12346",
      clientRequestId: "queued-cancel-key",
      idempotencyFingerprint: "queued-cancel-fingerprint",
      createdBy: USER,
    };
    const cancelling = await repository.createSignedCancel(cancelInput);
    expect((await repository.createSignedCancel(cancelInput)).replayed).toBe(true);
    const retryable = await repository.failActionAndRecoverRequest({
      actionId: cancelling.action.id,
      organizationId: ORG,
      failureReason: "blockhash expired",
      nonce: "8",
      creationTimestamp: "1700000000",
      quotedAssets: "9.8",
      maturityTimestamp: "1700000061",
      deadlineTimestamp: "1700000121",
    });
    expect(retryable).toMatchObject({
      action: { status: "failed", failure_reason: "blockhash expired" },
      request: {
        status: "expired_cancelable",
        nonce: "8",
        quoted_assets: "9.8",
        maturity_timestamp: "1700000061",
        deadline_timestamp: "1700000121",
      },
    });

    await getDb(env)
      .prepare(
        `UPDATE earn_positions
            SET closed_at = '2026-09-18T00:00:00.000Z',
                updated_at = '2026-09-18T00:00:00.000Z'
          WHERE id = ?`
      )
      .bind(POSITION)
      .run();
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "cancelled",
      closingSignature: "queued-cancel-signature",
      nonce: "8",
      cancelledAt: "2026-09-18T01:00:00.000Z",
    });
    const position = await getDb(env)
      .prepare("SELECT closed_at, updated_at FROM earn_positions WHERE id = ?")
      .bind(POSITION)
      .first<{ closed_at: string | null; updated_at: string }>();
    expect(position?.closed_at).toBeNull();
    expect(position?.updated_at).not.toBe("2026-09-18T00:00:00.000Z");
  });

  it("rolls back the action when failed-cancel request recovery cannot commit", async () => {
    const created = await createRequest();
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "expired_cancelable",
      nonce: "8",
      creationTimestamp: "1700000000",
    });
    const cancelling = await repository.createSignedCancel({
      actionId: "earn_vault_withdrawal_action_cancel_rollback",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      withdrawalRequestId: created.request.id,
      signature: "queued-cancel-signature-rollback",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12346",
      clientRequestId: "queued-cancel-key-rollback",
      idempotencyFingerprint: "queued-cancel-fingerprint-rollback",
      createdBy: USER,
    });
    const db = getDb(env);
    await db
      .prepare(
        `ALTER TABLE earn_vault_withdrawal_requests
           DROP CONSTRAINT IF EXISTS test_queued_atomic_cancel_failure`
      )
      .run();
    await db
      .prepare(
        `ALTER TABLE earn_vault_withdrawal_requests
           ADD CONSTRAINT test_queued_atomic_cancel_failure
           CHECK (status <> 'expired_cancelable') NOT VALID`
      )
      .run();
    try {
      await expect(
        repository.failActionAndRecoverRequest({
          actionId: cancelling.action.id,
          organizationId: ORG,
          failureReason: "injected request update failure",
          nonce: "8",
        })
      ).rejects.toThrow(/test_queued_atomic_cancel_failure/i);
    } finally {
      await db
        .prepare(
          `ALTER TABLE earn_vault_withdrawal_requests
             DROP CONSTRAINT IF EXISTS test_queued_atomic_cancel_failure`
        )
        .run();
    }
    const state = await db
      .prepare(
        `SELECT action.status AS action_status, request.status AS request_status
           FROM earn_vault_withdrawal_request_actions action
           JOIN earn_vault_withdrawal_requests request
             ON request.id = action.withdrawal_request_id
          WHERE action.id = ?`
      )
      .bind(cancelling.action.id)
      .first<{ action_status: string; request_status: string }>();
    expect(state).toEqual({ action_status: "requested", request_status: "cancelling" });
  });

  it.each(["fulfilled", "cancelled"] as const)(
    "fails a stale cancel action without regressing an already %s request",
    async (terminalStatus) => {
      const created = await createRequest();
      await repository.advanceRequest({
        withdrawalRequestId: created.request.id,
        organizationId: ORG,
        toStatus: "expired_cancelable",
        nonce: "8",
        creationTimestamp: "1700000000",
      });
      const cancelling = await repository.createSignedCancel({
        actionId: "earn_vault_withdrawal_action_cancel_terminal_race",
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        withdrawalRequestId: created.request.id,
        signature: "queued-cancel-signature-terminal-race",
        signedTransaction: "AQ==",
        lastValidBlockHeight: "12346",
        clientRequestId: "queued-cancel-key-terminal-race",
        idempotencyFingerprint: "queued-cancel-fingerprint-terminal-race",
        createdBy: USER,
      });
      await repository.advanceRequest({
        withdrawalRequestId: created.request.id,
        organizationId: ORG,
        toStatus: terminalStatus,
        nonce: "8",
        closingSignature: `queued-${terminalStatus}-signature`,
        ...(terminalStatus === "fulfilled"
          ? { assetsPaid: "9.9", fulfilledAt: "2026-09-18T01:00:00.000Z" }
          : { cancelledAt: "2026-09-18T01:00:00.000Z" }),
      });

      const result = await repository.failActionAndRecoverRequest({
        actionId: cancelling.action.id,
        organizationId: ORG,
        failureReason: "cancel signature lost a terminal race",
      });
      expect(result).toMatchObject({
        action: { status: "failed" },
        request: { status: terminalStatus },
      });
    }
  );

  it("persists the fulfilled payout movement for custody and external wallets", async () => {
    const custody = await createRequest();
    await repository.advanceRequest({
      withdrawalRequestId: custody.request.id,
      organizationId: ORG,
      toStatus: "fulfilled",
      nonce: "8",
      closingSignature: "queued-fulfilled-custody-signature",
      assetsPaid: "9.9",
      fulfilledAt: "2026-09-18T01:00:00.000Z",
    });

    const external = await createRequest({
      positionId: EXTERNAL_POSITION,
      custodyWalletId: null,
      ownerAddress: EXTERNAL_OWNER,
    });
    await repository.advanceRequest({
      withdrawalRequestId: external.request.id,
      organizationId: ORG,
      toStatus: "fulfilled",
      nonce: "9",
      closingSignature: "queued-fulfilled-external-signature",
      assetsPaid: "9.8",
      fulfilledAt: "2026-09-18T01:00:00.000Z",
    });

    // A custody fulfillment claims the custody wallet and keeps owner_address
    // NULL: binding both would activate the external-wallet claim foreign key
    // against a custody position that has no owner address.
    const custodyMovement = await getDb(env)
      .prepare(
        `SELECT custody_wallet_id, owner_address, vault_address, destination_address,
                signature, status
           FROM earn_movements WHERE id = ?`
      )
      .bind(`earn_queue_fulfillment_${custody.request.id}`)
      .first<Record<string, unknown>>();
    expect(custodyMovement).toMatchObject({
      custody_wallet_id: WALLET,
      owner_address: null,
      vault_address: VAULT,
      destination_address: OWNER,
      signature: "queued-fulfilled-custody-signature",
      status: "finalized",
    });

    const externalMovement = await getDb(env)
      .prepare(
        `SELECT custody_wallet_id, owner_address, vault_address, destination_address,
                signature, status
           FROM earn_movements WHERE id = ?`
      )
      .bind(`earn_queue_fulfillment_${external.request.id}`)
      .first<Record<string, unknown>>();
    expect(externalMovement).toMatchObject({
      custody_wallet_id: null,
      owner_address: EXTERNAL_OWNER,
      vault_address: VAULT,
      destination_address: EXTERNAL_OWNER,
      signature: "queued-fulfilled-external-signature",
      status: "finalized",
    });

    // The fulfilled request now exists BOTH as a persisted movement and as a
    // queue row; the owner's earned totals must count the payout once.
    const totals = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).aggregateExternalWalletMovements({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      ownerAddress: EXTERNAL_OWNER,
    });
    expect(totals.get(EXTERNAL_POSITION)).toMatchObject({
      finalizedDeposits: "0",
      finalizedWithdrawals: "9.8",
      finalizedWithdrawalCount: 1,
      unvaluedWithdrawalCount: 0,
    });
  });

  it("returns the winner to concurrent identical cancellation submissions", async () => {
    const created = await createRequest();
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "expired_cancelable",
      nonce: "8",
      creationTimestamp: "1700000000",
    });
    const common = {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox" as const,
      withdrawalRequestId: created.request.id,
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12346",
      clientRequestId: "queued-concurrent-cancel-key",
      idempotencyFingerprint: "queued-concurrent-cancel-fingerprint",
      createdBy: USER,
    };
    const results = await Promise.all([
      repository.createSignedCancel({
        ...common,
        actionId: "earn_vault_withdrawal_action_concurrent_cancel_winner",
        signature: "queued-concurrent-cancel-signature-winner",
      }),
      repository.createSignedCancel({
        ...common,
        actionId: "earn_vault_withdrawal_action_concurrent_cancel_loser",
        signature: "queued-concurrent-cancel-signature-loser",
      }),
    ]);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(1);
    expect(new Set(results.map(({ action }) => action.id))).toEqual(
      new Set([results[0]?.action.id])
    );
    expect(results.every(({ request }) => request.status === "cancelling")).toBe(true);
  });

  it("keeps provider-proven submitted requests in the reconciliation claim", async () => {
    const created = await createRequest();
    await repository.advanceAction({
      actionId: created.action.id,
      organizationId: ORG,
      toStatus: "submitted",
    });
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "pending",
      nonce: "9",
      creationTimestamp: "1700000000",
    });
    const claimed = await repository.claimOpenRequests(16);
    expect(claimed.map(({ id }) => id)).toContain(created.request.id);
  });
});
