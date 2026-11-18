import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { createPostgresEarnVaultWithdrawalRequestsRepository } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { buildEarnVaultParRedemptionFingerprint } from "@/lib/idempotency";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const quoteParRedemption = vi.hoisted(() => vi.fn());
const buildParRedemptionRequest = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const signVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const compileUnsignedVaultTransaction = vi.hoisted(() => vi.fn());
const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const resolveVaultSponsorship = vi.hoisted(() => vi.fn());
const verifySignedWalletTransaction = vi.hoisted(() => vi.fn());
const readConfirmedBlockHeight = vi.hoisted(() => vi.fn());

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultParRedemptionClient: () => ({ quoteParRedemption, buildParRedemptionRequest }),
}));
vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  simulateVaultPlan,
  signVaultPlan,
  broadcastVaultTransaction,
  compileUnsignedVaultTransaction,
}));
vi.mock("@/services/solana/signer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana/signer")>()),
  createOrgSignerForCustodyWallet,
}));
vi.mock("./vault-sponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-sponsorship")>()),
  resolveVaultSponsorship,
}));
vi.mock("./vault-wallet.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-wallet.service")>()),
  verifySignedWalletTransaction,
}));
vi.mock("./vault-intent-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-intent-execution.service")>()),
  readConfirmedBlockHeight,
}));

const service = await import("./vault-queued-withdraw.service");
const clusterRpc = installClusterRpcResponder();

/** Each call in the cluster scope the project middleware opens for the sandbox project. */
function inProjectScope<TArgs extends unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  return (...args) =>
    runInClusterScope({ projectId: PROJECT, environment: "sandbox" }, () => operation(...args));
}

const buildWalletQueuedWithdrawalRequest = inProjectScope(
  service.buildWalletQueuedWithdrawalRequest
);
const createCustodyQueuedWithdrawal = inProjectScope(service.createCustodyQueuedWithdrawal);
const submitWalletQueuedWithdrawalAction = inProjectScope(
  service.submitWalletQueuedWithdrawalAction
);

const ORG = "org_par_intermediate";
const PROJECT = "prj_par_intermediate";
const USER = "usr_par_intermediate";
const WALLET_ROW_ID = "cwlt_par_intermediate";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OWNER_ADDRESS = "C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRIME_MINT = "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7";
const WYLDS_MINT = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const CUSTODY_POSITION = "earn_position_par_intermediate_custody";
const OWNER_POSITION = "earn_position_par_intermediate_external";
const CUSTODY_REQUEST = "ParIntermediateCustodyRequest11111111111";
const OWNER_REQUEST = "ParIntermediateExternalRequest1111111111";
const terms = { mechanism: "operator_redemption", intermediateAmount: "2000" } as const;

function heldIntermediatePlan(requestAddress: string, shares = "0") {
  return {
    cluster: "devnet",
    instructions: [{ programAddress: "11111111111111111111111111111111", accounts: [], data: "" }],
    lookupTables: [],
    assetIdentity: { depositTokenMint: USDC_MINT, shareMint: PRIME_MINT },
    requestAddress,
    expectedRequest: {
      shares,
      intermediateMint: WYLDS_MINT,
      intermediateAmount: "2000",
      assetMint: USDC_MINT,
      assets: "2000",
    },
  };
}

function position(id: string, ownerAddress: string, custodyWalletId: string | null) {
  return {
    id,
    provider: "hastra",
    vaultAddress: PRIME_MINT,
    tokenMint: USDC_MINT,
    shareMint: PRIME_MINT,
    ownerAddress,
    custodyWalletId,
  };
}

async function seed(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Par Intermediate Org", "par-intermediate", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER, "par-intermediate@example.com", 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_par_intermediate', ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(ORG, PROJECT),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_par_intermediate', 'privy_par_intermediate', ?, 'active')`
      )
      .bind(WALLET_ROW_ID, WALLET_ADDRESS),
    db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, 'Hastra PRIME',
                   sdp_iso_now())`
      )
      .bind(CUSTODY_POSITION, ORG, PROJECT, WALLET_ROW_ID, PRIME_MINT, PRIME_MINT, USDC_MINT),
    db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           owner_address, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, 'Hastra PRIME',
                   sdp_iso_now())`
      )
      .bind(OWNER_POSITION, ORG, PROJECT, OWNER_ADDRESS, PRIME_MINT, PRIME_MINT, USDC_MINT),
  ]);
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seed();
  vi.clearAllMocks();
  clusterRpc.respond("getTransaction", () => ({ result: null }));
  quoteParRedemption.mockResolvedValue({
    shares: "0",
    shareDecimals: 6,
    intermediateMint: WYLDS_MINT,
    intermediateAmount: "2000",
    assetMint: USDC_MINT,
    assets: "2000",
    assetDecimals: 6,
    blockingIssues: [],
  });
  resolveVaultSponsorship.mockResolvedValue({ kind: "wallet-pays" });
  simulateVaultPlan.mockResolvedValue({ ok: true, prepared: {} });
  createOrgSignerForCustodyWallet.mockResolvedValue({ address: WALLET_ADDRESS });
  signVaultPlan.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    signature: "sig_par_intermediate_custody",
    lastValidBlockHeight: "12345",
  });
  broadcastVaultTransaction.mockResolvedValue(undefined);
  compileUnsignedVaultTransaction.mockReturnValue({
    bytes: new Uint8Array([9, 9]),
    lastValidBlockHeight: "20000",
  });
  readConfirmedBlockHeight.mockResolvedValue(100n);
  verifySignedWalletTransaction.mockResolvedValue({
    signature: "sig_par_intermediate_external",
    signedTransactionBase64: "CQk=",
  });
});

describe("a par request over held intermediate", () => {
  it("keeps operation queue builds out of legacy submit independently of discovery permission", async () => {
    const actor = { organizationId: ORG, projectId: PROJECT, userId: USER };
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(OWNER_REQUEST));
    const built = await buildWalletQueuedWithdrawalRequest(env, {
      actor,
      position: position(OWNER_POSITION, OWNER_ADDRESS, null),
      terms,
      asyncOperation: true,
    });
    await expect(
      submitWalletQueuedWithdrawalAction(env, {
        actor,
        transactionId: built.id,
        signedTransaction: "CQk=",
        clientRequestId: "legacy-blocked",
        action: "request",
        allowDiscoveredPosition: true,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "operation_execution_required" },
    });
    expect(verifySignedWalletTransaction).not.toHaveBeenCalled();
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
    const submitted = await submitWalletQueuedWithdrawalAction(env, {
      actor,
      transactionId: built.id,
      signedTransaction: "CQk=",
      clientRequestId: "operation-worker",
      action: "request",
      allowOperationBuild: true,
      broadcast: false,
    });
    expect(submitted.request.position_id).toBe(OWNER_POSITION);
  });

  it.each([false, true])(
    "claims discovered holdings only with signed submission (custody=%s)",
    async (custody) => {
      const db = getDb(env);
      const positionId = custody ? CUSTODY_POSITION : OWNER_POSITION;
      await db.prepare("DELETE FROM earn_positions WHERE id = ?").bind(positionId).run();
      const strategy = await createPostgresEarnRepository(db).upsertStrategy({
        provider: "hastra",
        providerReference: PRIME_MINT,
        name: "Hastra PRIME",
        sourceKind: "rwa",
        underlyingSource: null,
        depositMints: [USDC_MINT],
        shareMint: PRIME_MINT,
        apyType: "variable",
        currentApy: null,
        liquidityTerm: "delayed",
        redemptionDelayDays: null,
        riskMetadata: {},
        status: "deprecated",
        hostCluster: "devnet",
        environment: "sandbox",
      });
      if (strategy === null) throw new Error("Missing strategy");
      const actor = { organizationId: ORG, projectId: PROJECT, userId: USER };
      const requestAddress = custody ? CUSTODY_REQUEST : OWNER_REQUEST;
      const custodyWalletId = custody ? WALLET_ROW_ID : undefined;
      buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(requestAddress));
      const built = await buildWalletQueuedWithdrawalRequest(env, {
        actor,
        position: position(
          "unclaimed-selector",
          custody ? WALLET_ADDRESS : OWNER_ADDRESS,
          custodyWalletId ?? null
        ),
        terms,
        custodyWalletId,
        discoveredStrategyId: strategy.id,
      });
      expect(built).toMatchObject({ position_id: null, strategy_id: strategy.id });
      expect(
        await db.prepare("SELECT id FROM earn_positions WHERE id = ?").bind(positionId).first()
      ).toBeNull();
      await expect(
        submitWalletQueuedWithdrawalAction(env, {
          actor,
          transactionId: built.id,
          signedTransaction: "CQk=",
          clientRequestId: "legacy-refused",
          action: "request",
          custodyWalletId,
        })
      ).rejects.toThrow("Earn queued withdrawal position");
      const submitted = await submitWalletQueuedWithdrawalAction(env, {
        actor,
        transactionId: built.id,
        signedTransaction: "CQk=",
        clientRequestId: "signed-discovery-key",
        action: "request",
        custodyWalletId,
        allowDiscoveredPosition: true,
        broadcast: false,
      });
      expect(
        await db
          .prepare("SELECT cost_basis_known, strategy_id FROM earn_positions WHERE id = ?")
          .bind(submitted.request.position_id)
          .first()
      ).toEqual({ cost_basis_known: false, strategy_id: strategy.id });
      expect(submitted.request).toMatchObject({
        custody_wallet_id: custodyWalletId ?? null,
        shares: "0",
        intermediate_amount: "2000",
      });
      const movements = createPostgresEarnMovementsRepository(db);
      const page = custody
        ? await movements.listVaultPositions({
            organizationId: ORG,
            environment: "sandbox",
            custodyWalletIds: [WALLET_ROW_ID],
            before: null,
            limit: 100,
          })
        : await movements.listWalletPositions({
            organizationId: ORG,
            projectId: PROJECT,
            environment: "sandbox",
            ownerAddress: OWNER_ADDRESS,
            before: null,
            limit: 100,
          });
      expect(page.rows.some((row) => row.id === submitted.request.position_id)).toBe(true);
      const replay = await submitWalletQueuedWithdrawalAction(env, {
        actor,
        transactionId: built.id,
        signedTransaction: "CQk=",
        clientRequestId: "signed-discovery-key",
        action: "request",
        custodyWalletId,
        allowDiscoveredPosition: true,
        broadcast: false,
      });
      expect(replay.request.id).toBe(submitted.request.id);
      expect(
        await db
          .prepare("SELECT COUNT(*)::int AS count FROM earn_movements WHERE direction = 'deposit'")
          .first()
      ).toEqual({ count: 0 });
      expect(signVaultPlan).not.toHaveBeenCalled();
      expect(broadcastVaultTransaction).not.toHaveBeenCalled();
    }
  );

  it("builds, signs and records a custody request that burns no shares", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(CUSTODY_REQUEST));

    const result = await createCustodyQueuedWithdrawal(env, {
      actor: {
        organizationId: ORG,
        projectId: PROJECT,
        custodyWalletId: WALLET_ROW_ID,
        custodyWalletPublicKey: WALLET_ADDRESS,
        userId: USER,
      },
      position: position(CUSTODY_POSITION, WALLET_ADDRESS, WALLET_ROW_ID),
      terms,
      clientRequestId: "par-intermediate-custody-key",
    });

    const source = { providerReference: PRIME_MINT, intermediateAmount: "2000" };
    expect(quoteParRedemption).toHaveBeenCalledWith(expect.anything(), source);
    expect(buildParRedemptionRequest).toHaveBeenCalledWith(expect.anything(), {
      ...source,
      owner: WALLET_ADDRESS,
    });
    expect(result.request).toMatchObject({
      mechanism: "operator_redemption",
      shares: "0",
      intermediate_mint: WYLDS_MINT,
      intermediate_amount: "2000",
      idempotency_fingerprint: buildEarnVaultParRedemptionFingerprint({
        environment: "sandbox",
        provider: "hastra",
        positionId: CUSTODY_POSITION,
        intermediateAmount: "2000",
      }),
    });
    expect(result.action).toMatchObject({ status: "submitted" });
  });

  it("refuses a build that burns shares the caller did not ask to redeem", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(CUSTODY_REQUEST, "1"));

    await expect(
      createCustodyQueuedWithdrawal(env, {
        actor: {
          organizationId: ORG,
          projectId: PROJECT,
          custodyWalletId: WALLET_ROW_ID,
          custodyWalletPublicKey: WALLET_ADDRESS,
          userId: USER,
        },
        position: position(CUSTODY_POSITION, WALLET_ADDRESS, WALLET_ROW_ID),
        terms,
        clientRequestId: "par-intermediate-drift-key",
      })
    ).rejects.toThrow(/changed the position asset identity or the requested amount/);
    expect(signVaultPlan).not.toHaveBeenCalled();
  });

  it("persists an owner-signed build and reconstructs the held source on submit", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(OWNER_REQUEST));
    const actor = {
      organizationId: ORG,
      projectId: PROJECT,
      userId: USER,
    };

    const built = await buildWalletQueuedWithdrawalRequest(env, {
      actor,
      position: position(OWNER_POSITION, OWNER_ADDRESS, null),
      terms,
    });
    expect(built).toMatchObject({
      action: "request",
      mechanism: "operator_redemption",
      shares: "0",
      intermediate_amount: "2000",
    });

    // Persist the original signed intent before an uncertain broadcast. Its
    // blockhash is still valid, so the worker can retry these same bytes.
    broadcastVaultTransaction.mockRejectedValueOnce(new Error("Blockhash not found"));
    const submitted = await submitWalletQueuedWithdrawalAction(env, {
      actor,
      transactionId: built.id,
      signedTransaction: "CQk=",
      clientRequestId: "par-intermediate-external-key",
      action: "request",
    });
    expect(submitted.action).toMatchObject({ status: "requested" });
    expect(submitted.request).toMatchObject({
      shares: "0",
      intermediate_amount: "2000",
      idempotency_fingerprint: buildEarnVaultParRedemptionFingerprint({
        environment: "sandbox",
        provider: "hastra",
        positionId: OWNER_POSITION,
        intermediateAmount: "2000",
        transactionId: built.id,
      }),
    });
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("retains an expired owner-signed build without claiming a request when history is missing", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(OWNER_REQUEST));
    const actor = { organizationId: ORG, projectId: PROJECT, userId: USER };
    const built = await buildWalletQueuedWithdrawalRequest(env, {
      actor,
      position: position(OWNER_POSITION, OWNER_ADDRESS, null),
      terms,
    });
    readConfirmedBlockHeight.mockResolvedValue(99999n);

    await expect(
      submitWalletQueuedWithdrawalAction(env, {
        actor,
        transactionId: built.id,
        signedTransaction: "CQk=",
        clientRequestId: "par-intermediate-expired-key",
        action: "request",
      })
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
    await expect(
      repository.getWalletTransaction({ organizationId: ORG, transactionId: built.id })
    ).resolves.toMatchObject({ consumed_action_id: null, intermediate_amount: "2000" });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("retries the original signed intent after a recovery RPC outage", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(OWNER_REQUEST));
    const actor = { organizationId: ORG, projectId: PROJECT, userId: USER };
    const built = await buildWalletQueuedWithdrawalRequest(env, {
      actor,
      position: position(OWNER_POSITION, OWNER_ADDRESS, null),
      terms,
    });
    const input = {
      actor,
      transactionId: built.id,
      signedTransaction: "CQk=",
      clientRequestId: "par-intermediate-outage-key",
      action: "request",
    } as const;
    clusterRpc.respond("getTransaction", () => ({
      error: { code: -32603, message: "Private RPC endpoint is unavailable" },
    }));

    await expect(submitWalletQueuedWithdrawalAction(env, input)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
    });
    const repository = createPostgresEarnVaultWithdrawalRequestsRepository(getDb(env));
    await expect(
      repository.getWalletTransaction({ organizationId: ORG, transactionId: built.id })
    ).resolves.toMatchObject({ consumed_action_id: null });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();

    clusterRpc.respond("getTransaction", () => ({ result: null }));
    const submitted = await submitWalletQueuedWithdrawalAction(env, input);
    expect(submitted.request).toMatchObject({
      client_request_id: input.clientRequestId,
      creation_signature: "sig_par_intermediate_external",
    });
    await expect(
      repository.getWalletTransaction({ organizationId: ORG, transactionId: built.id })
    ).resolves.toMatchObject({ consumed_action_id: submitted.action.id });
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });
});
