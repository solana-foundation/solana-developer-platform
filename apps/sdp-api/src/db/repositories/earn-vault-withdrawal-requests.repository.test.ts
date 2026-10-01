import { readFileSync } from "node:fs";
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
const INTERMEDIATE_MINT = "BVfHastraWylds1111111111111111111111111111";
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
      "earn_movements",
      "earn_vault_withdrawal_requests",
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
      mechanism: "solver_queue",
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
      mechanism: input.mechanism,
    });
    return input;
  }

  async function createRequest(overrides: Partial<CreateSignedQueuedWithdrawalRequestInput> = {}) {
    const input = await reserveInput(requestInput(overrides));
    return repository.createSignedRequest(input);
  }

  it("rejects null mechanism-required terms at the database boundary", async () => {
    const db = getDb(env);
    const solverRequest = await createRequest();
    for (const column of ["discount_bps", "maturity_timestamp", "deadline_timestamp"] as const) {
      await expect(
        db
          .prepare(`UPDATE earn_vault_withdrawal_requests SET ${column} = NULL WHERE id = ?`)
          .bind(solverRequest.request.id)
          .run()
      ).rejects.toThrow(/earn_vault_withdrawal_requests_mechanism_terms_check/);
    }

    const operatorRequest = await createRequest({
      mechanism: "operator_redemption",
      intermediateMint: INTERMEDIATE_MINT,
      intermediateAmount: "10.25",
      quotedAssets: "10.25",
      discountBps: null,
      maturityTimestamp: null,
      deadlineTimestamp: null,
    });
    for (const column of ["intermediate_mint", "intermediate_amount"] as const) {
      await expect(
        db
          .prepare(`UPDATE earn_vault_withdrawal_requests SET ${column} = NULL WHERE id = ?`)
          .bind(operatorRequest.request.id)
          .run()
      ).rejects.toThrow(/earn_vault_withdrawal_requests_mechanism_terms_check/);
    }
  });

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

  it("retries operator cancellation, reopens the holding, and embargoes terminal PDA reuse", async () => {
    const requestAddress = "ParRequestAddress11111111111111111111111";
    const created = await createRequest({
      mechanism: "operator_redemption",
      requestAddress,
      intermediateMint: INTERMEDIATE_MINT,
      intermediateAmount: "10.25",
      quotedAssets: "10.25",
      discountBps: null,
      maturityTimestamp: null,
      deadlineTimestamp: null,
    });
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "pending",
      creationTimestamp: "1800000000",
    });

    const firstCancel = await repository.createSignedCancel({
      actionId: "earn_vault_withdrawal_action_par_cancel_failed",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      withdrawalRequestId: created.request.id,
      signature: "par-cancel-signature-failed",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12346",
      clientRequestId: "par-cancel-key-failed",
      idempotencyFingerprint: "par-cancel-fingerprint-failed",
      createdBy: USER,
    });
    const recovered = await repository.failActionAndRecoverRequest({
      actionId: firstCancel.action.id,
      organizationId: ORG,
      failureReason: "blockhash expired",
    });
    expect(recovered).toMatchObject({
      action: { status: "failed" },
      request: { status: "pending", mechanism: "operator_redemption" },
    });

    const secondCancel = await repository.createSignedCancel({
      actionId: "earn_vault_withdrawal_action_par_cancel_final",
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      withdrawalRequestId: created.request.id,
      signature: "par-cancel-signature-final",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12347",
      clientRequestId: "par-cancel-key-final",
      idempotencyFingerprint: "par-cancel-fingerprint-final",
      createdBy: USER,
    });
    expect(secondCancel.request.status).toBe("cancelling");

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
      closingSignature: "par-cancel-signature-final",
      cancelledAt: "2026-09-18T01:00:00.000Z",
    });
    // The cancelled request's intermediate stays in the wallet and is still
    // this holding, so a stale zero-share close must not retire it.
    const position = await getDb(env)
      .prepare("SELECT closed_at, updated_at FROM earn_positions WHERE id = ?")
      .bind(POSITION)
      .first<{ closed_at: string | null; updated_at: string }>();
    expect(position?.closed_at).toBeNull();
    expect(position?.updated_at).not.toBe("2026-09-18T00:00:00.000Z");

    const reuseTerms = {
      mechanism: "operator_redemption" as const,
      requestAddress,
      intermediateMint: INTERMEDIATE_MINT,
      intermediateAmount: "5.1",
      quotedAssets: "5.1",
      discountBps: null,
      maturityTimestamp: null,
      deadlineTimestamp: null,
    };
    await expect(createRequest(reuseTerms)).rejects.toThrow(/reserving this provider nonce/i);
    await getDb(env)
      .prepare(
        `UPDATE earn_vault_withdrawal_request_pda_leases
            SET expires_at = '2000-01-01T00:00:00.000Z',
                reuse_not_before = '2000-01-01T00:00:00.000Z'
          WHERE environment = 'sandbox' AND request_address = ?`
      )
      .bind(requestAddress)
      .run();

    const reused = await createRequest(reuseTerms);
    expect(reused.request.id).not.toBe(created.request.id);
    await expect(
      repository.getByAddress({
        environment: "sandbox",
        provider: "veda",
        requestAddress,
      })
    ).resolves.toMatchObject({ id: reused.request.id, status: "creating" });
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

  it("records every payout in a batched solver transaction exactly once", async () => {
    const first = await createRequest({
      positionId: EXTERNAL_POSITION,
      custodyWalletId: null,
      ownerAddress: EXTERNAL_OWNER,
    });
    const second = await createRequest({
      positionId: EXTERNAL_POSITION,
      custodyWalletId: null,
      ownerAddress: EXTERNAL_OWNER,
    });
    const fulfill = (withdrawalRequestId: string, assetsPaid: string) =>
      repository.advanceRequest({
        withdrawalRequestId,
        organizationId: ORG,
        toStatus: "fulfilled",
        closingSignature: "batched-solver-signature",
        assetsPaid,
        fulfilledAt: "2026-09-29T01:00:00.000Z",
      });
    await fulfill(first.request.id, "9.9");
    await fulfill(second.request.id, "9.8");
    expect(await fulfill(first.request.id, "9.9")).toBeNull();
    expect(await fulfill(second.request.id, "9.8")).toBeNull();
    const totals = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).aggregateExternalWalletMovements({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      ownerAddress: EXTERNAL_OWNER,
    });
    expect(totals.get(EXTERNAL_POSITION)).toMatchObject({
      finalizedWithdrawals: "19.7",
      finalizedWithdrawalCount: 2,
    });
  });

  it("retains signature uniqueness for transactions initiated by SDP", async () => {
    const movements = createPostgresEarnMovementsRepository(getDb(env));
    const input = {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox" as const,
      provider: "veda",
      positionId: POSITION,
      vaultAddress: VAULT,
      custodyWalletId: WALLET,
      shareMint: SHARE_MINT,
      requestedShares: "1",
      walletAddress: OWNER,
      signature: "unique-initiated-signature",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      requestId: "first-initiated-key",
      idempotencyFingerprint: "initiated-fingerprint",
    };
    await movements.createSignedVaultWithdrawalIntent(input);
    expect((await movements.createSignedVaultWithdrawalIntent(input)).replayed).toBe(true);
    await expect(
      movements.createSignedVaultWithdrawalIntent({
        ...input,
        requestId: "second-initiated-key",
      })
    ).rejects.toThrow(/idx_earn_movements_signature/);
  });

  it("backfills existing payouts and permits the previous writer during rollout", async () => {
    const created = await createRequest();
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "fulfilled",
      closingSignature: "pre-migration-solver-signature",
      assetsPaid: "9.9",
    });
    const migration = readFileSync(
      new URL("../migrations/postgres/0119_earn_queue_payout_identity.sql", import.meta.url),
      "utf8"
    );
    const rollback = new Error("rollback migration fixture");
    await expect(
      getDb(env).transaction(async (tx) => {
        await tx.execute("ALTER TABLE earn_movements DROP COLUMN withdrawal_request_id CASCADE");
        await tx.execute(
          "CREATE UNIQUE INDEX idx_earn_movements_signature ON earn_movements(signature) WHERE signature IS NOT NULL"
        );
        await tx.execute(migration);
        expect(
          await tx.queryOne(
            "SELECT withdrawal_request_id, token_amount_settled FROM earn_movements WHERE id = ?",
            [`earn_queue_fulfillment_${created.request.id}`]
          )
        ).toEqual({ withdrawal_request_id: created.request.id, token_amount_settled: "9.9" });
        await tx.execute(
          `INSERT INTO earn_movements
           SELECT (jsonb_populate_record(NULL::earn_movements, to_jsonb(movement) ||
             jsonb_build_object(
               'id', 'legacy-payout', 'withdrawal_request_id', NULL,
               'signature', 'legacy-solver-signature', 'request_id', 'legacy-request-key',
               'provider_reference', 'legacy-provider-request'
             ))).*
             FROM earn_movements movement WHERE id = ?`,
          [`earn_queue_fulfillment_${created.request.id}`]
        );
        expect(
          await tx.queryOne(
            "SELECT withdrawal_request_id FROM earn_movements WHERE id = 'legacy-payout'"
          )
        ).toEqual({ withdrawal_request_id: null });
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it("keeps a paid request reconcilable if another movement already used its caller key", async () => {
    const created = await createRequest();
    await createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultWithdrawalIntent({
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "veda",
      positionId: POSITION,
      vaultAddress: VAULT,
      custodyWalletId: WALLET,
      shareMint: SHARE_MINT,
      requestedShares: "1",
      walletAddress: OWNER,
      signature: "direct-withdrawal-key-collision",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      requestId: created.request.client_request_id,
      idempotencyFingerprint: "direct-withdrawal-fingerprint",
    });
    await expect(
      repository.advanceRequest({
        withdrawalRequestId: created.request.id,
        organizationId: ORG,
        toStatus: "fulfilled",
        closingSignature: "solver-key-collision",
        assetsPaid: "9.9",
      })
    ).rejects.toThrow(/idx_earn_movements_vault_request/);
    expect(
      await repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: created.request.id,
      })
    ).toMatchObject({ status: "creating", assets_paid: null });
  });

  it("does not fail or release a provider-proven request when its PDA later disappears", async () => {
    const created = await createRequest();
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "pending",
      nonce: "8",
      creationTimestamp: "1700000000",
    });
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "closed_or_unknown",
    });
    await expect(
      repository.failActionAndRecoverRequest({
        actionId: created.action.id,
        organizationId: ORG,
        failureReason: "conflicting observation",
      })
    ).rejects.toThrow(/changed before action failure recovery/);
    expect(
      await repository.advanceRequest({
        withdrawalRequestId: created.request.id,
        organizationId: ORG,
        toStatus: "failed",
        failureReason: "conflicting observation",
      })
    ).toBeNull();
    expect(
      await repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: created.request.id,
      })
    ).toMatchObject({ status: "closed_or_unknown", nonce: "8" });
  });

  it("can fail a finalized rejected create after an absent-PDA observation", async () => {
    const created = await createRequest();
    await repository.advanceAction({
      actionId: created.action.id,
      organizationId: ORG,
      toStatus: "submitted",
    });
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "closed_or_unknown",
    });
    await expect(
      repository.failActionAndRecoverRequest({
        actionId: created.action.id,
        organizationId: ORG,
        failureReason: "finalized program rejection",
      })
    ).resolves.toMatchObject({
      action: { status: "failed" },
      request: { status: "failed" },
    });
  });

  it.each(["solver_queue", "operator_redemption"] as const)(
    "does not let a stale %s provider read reopen an in-flight cancellation",
    async (mechanism) => {
      const created = await createRequest(
        mechanism === "solver_queue"
          ? {}
          : {
              mechanism,
              intermediateMint: INTERMEDIATE_MINT,
              intermediateAmount: "10",
              discountBps: null,
              maturityTimestamp: null,
              deadlineTimestamp: null,
            }
      );
      const toStatus = mechanism === "solver_queue" ? "expired_cancelable" : "pending";
      await repository.advanceRequest({
        withdrawalRequestId: created.request.id,
        organizationId: ORG,
        toStatus,
      });
      const cancel = {
        actionId: "cancel-race",
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox" as const,
        withdrawalRequestId: created.request.id,
        signature: "cancel-race-signature",
        signedTransaction: "AQ==",
        lastValidBlockHeight: "12345",
        clientRequestId: "cancel-race-key",
        idempotencyFingerprint: "cancel-race-fingerprint",
      };
      await repository.createSignedCancel(cancel);
      expect(
        await repository.advanceRequest({
          withdrawalRequestId: created.request.id,
          organizationId: ORG,
          toStatus,
        })
      ).toBeNull();
      await expect(
        repository.createSignedCancel({
          ...cancel,
          actionId: "second-cancel-race",
          signature: "second-cancel-race-signature",
          clientRequestId: "second-cancel-race-key",
        })
      ).rejects.toThrow(/cancelling/);
      await repository.advanceRequest({
        withdrawalRequestId: created.request.id,
        organizationId: ORG,
        toStatus: "closed_or_unknown",
      });
      expect(
        await repository.advanceRequest({
          withdrawalRequestId: created.request.id,
          organizationId: ORG,
          toStatus,
        })
      ).toBeNull();
      expect(
        await repository.getById({
          organizationId: ORG,
          environment: "sandbox",
          withdrawalRequestId: created.request.id,
        })
      ).toMatchObject({ status: "closed_or_unknown" });
    }
  );

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

    // The claim itself is a lease. A second worker cannot pick up the same
    // provider read until either the worker schedules it or the lease expires.
    const overlapping = await repository.claimOpenRequests(16);
    expect(overlapping.map(({ id }) => id)).not.toContain(created.request.id);

    await getDb(env)
      .prepare("UPDATE earn_vault_withdrawal_requests SET next_check_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", created.request.id)
      .run();
    const retried = await repository.claimOpenRequests(16);
    expect(retried.map(({ id }) => id)).toContain(created.request.id);
  });

  it("preserves the claim lease when a nonterminal advance omits the next check", async () => {
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
    const [claimed] = await repository.claimOpenRequests(1);
    if (!claimed) throw new Error("Expected one due queued withdrawal");
    expect(claimed.next_check_at).not.toBeNull();

    // A nonterminal advance without a replacement schedule must keep the
    // lease claimOpenRequests wrote, or the same request becomes due again
    // inside the same worker tick and hogs the whole claim budget.
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "pending",
      lastIndexError: null,
    });
    await expect(
      repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: created.request.id,
      })
    ).resolves.toMatchObject({ next_check_at: claimed.next_check_at });

    // A supplied schedule still wins, and terminal transitions clear it.
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "pending",
      nextCheckAt: "2030-01-01T00:00:00.000Z",
    });
    await expect(
      repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: created.request.id,
      })
    ).resolves.toMatchObject({ next_check_at: "2030-01-01T00:00:00.000Z" });
    await repository.advanceRequest({
      withdrawalRequestId: created.request.id,
      organizationId: ORG,
      toStatus: "cancelled",
      closingSignature: "queued-cancel-signature",
    });
    await expect(
      repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: created.request.id,
      })
    ).resolves.toMatchObject({ next_check_at: null });
  });

  it("defers a failed request before claiming later due work", async () => {
    const first = await createRequest();
    const second = await createRequest();
    for (const created of [first, second]) {
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
    }

    const [failed] = await repository.claimOpenRequests(1);
    if (!failed) throw new Error("Expected one due queued withdrawal");
    await repository.recordIndexError({
      withdrawalRequestId: failed.id,
      error: "provider timed out",
      retryAt: "2099-01-01T00:00:00.000Z",
    });

    const [next] = await repository.claimOpenRequests(1);
    const expectedNext = [first.request.id, second.request.id].find((id) => id !== failed.id);
    expect(next?.id).toBe(expectedNext);
    await expect(
      repository.getById({
        organizationId: ORG,
        environment: "sandbox",
        withdrawalRequestId: failed.id,
      })
    ).resolves.toMatchObject({
      last_index_error: "provider timed out",
      next_check_at: "2099-01-01T00:00:00.000Z",
    });
  });
});
