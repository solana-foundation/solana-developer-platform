import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const getSignatureStatuses = vi.hoisted(() => vi.fn());
const getBlockHeight = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", () => ({
  createRpc: () => ({ getBlockHeight: () => ({ send: getBlockHeight }) }),
  getSignatureStatuses,
}));
vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  assertClusterEndpoint: vi.fn(async () => {}),
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));
vi.mock("@/services/earn/vault-execution.service", () => ({ broadcastVaultTransaction }));

const { reconcileEarnVaultMovements } = await import("./reconcile-earn-vault-movements");

const ORG = "org_vault_reconcile";
const PROJECT = "prj_vault_reconcile";
const USER = "usr_vault_reconcile";
const WALLET = "cwlt_vault_reconcile";

beforeEach(async () => {
  await seedTestDatabase(env);
  vi.clearAllMocks();
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Reconcile", "vault-reconcile", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "vault-reconcile@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Vault Reconcile', 'vault-reconcile', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_vault_reconcile', ?, ?, 'privy', 'test', 'active')`
      )
      .bind(ORG, PROJECT),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_vault_reconcile', 'privy_vault_reconcile',
                 '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'active')`
      )
      .bind(WALLET),
  ]);
  broadcastVaultTransaction.mockResolvedValue(undefined);
});

async function seedMovement(lastValidBlockHeight = "100") {
  return createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    vaultAddress: `vault_${crypto.randomUUID()}`,
    custodyWalletId: WALLET,
    shareMint: "So11111111111111111111111111111111111111112",
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "USDC Vault",
    requestedAmount: "1",
    sourceAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: Buffer.from([1, 2, 3]).toString("base64"),
    lastValidBlockHeight,
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: crypto.randomUUID(),
  });
}

/** The ledger row, which is where settlement now lives. */
async function ledgerRow(movementId: string) {
  return createPostgresEarnMovementsRepository(getDb(env)).getMovementById({
    movementId,
    organizationId: ORG,
  });
}

async function withdrawalLegRow(movementId: string, legIndex: number) {
  return createPostgresEarnMovementsRepository(getDb(env)).getVaultWithdrawalLegByIndex({
    movementId,
    legIndex,
  });
}

describe("reconcileEarnVaultMovements", () => {
  it("marks an observed successful signature confirmed", async () => {
    const seeded = await seedMovement();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: 1n, err: null, confirmationStatus: "confirmed" },
    ]);

    await reconcileEarnVaultMovements(env);

    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({
      status: "confirmed",
      // Recorded, but NOT settled: settlement waits for finalization.
      settled_at: null,
    });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("fails a missing signature after its recorded blockhash expires", async () => {
    const seeded = await seedMovement("100");
    getSignatureStatuses.mockResolvedValue([null]);
    getBlockHeight.mockResolvedValue(101n);

    await reconcileEarnVaultMovements(env);

    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({
      status: "failed",
      failure_reason: "Transaction blockhash expired before confirmation",
    });
  });

  it("rebroadcasts the exact recorded bytes while the blockhash is valid", async () => {
    const seeded = await seedMovement("100");
    getSignatureStatuses.mockResolvedValue([null]);
    getBlockHeight.mockResolvedValue(99n);

    await reconcileEarnVaultMovements(env);

    expect(broadcastVaultTransaction).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ bytes: new Uint8Array([1, 2, 3]) })
    );
    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({ status: "submitted" });
  });

  it("keeps a confirmed movement in the queue until the chain finalizes it", async () => {
    const seeded = await seedMovement();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: 1n, err: null, confirmationStatus: "confirmed" },
    ]);
    await reconcileEarnVaultMovements(env);

    // Commitment is not settlement (PRO-1716): the row is confirmed, carries no
    // settled_at, and is STILL unsettled work as far as the sweep is concerned.
    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({
      status: "confirmed",
      settled_at: null,
    });
    const queued = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).claimUnsettledVaultMovements(256);
    expect(queued.map((row) => row.id)).toContain(seeded.movement.id);

    // A later tick sees finalization and settles it.
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: null, err: null, confirmationStatus: "finalized" },
    ]);
    await reconcileEarnVaultMovements(env);

    const finalized = await ledgerRow(seeded.movement.id);
    // amount_settled rides along with commitment: the intent's amount is what
    // the chain executed, so a settled row always reports what moved.
    expect(finalized).toMatchObject({ status: "finalized", amount_settled: "1" });
    expect(finalized?.settled_at).not.toBeNull();
    expect(finalized?.confirmed_at).not.toBeNull();
    expect(
      (
        await createPostgresEarnMovementsRepository(getDb(env)).claimUnsettledVaultMovements(256)
      ).map((row) => row.id)
    ).not.toContain(seeded.movement.id);
  });

  it("settles a movement whose first observation is already finalized", async () => {
    const seeded = await seedMovement();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: null, err: null, confirmationStatus: "finalized" },
    ]);

    await reconcileEarnVaultMovements(env);

    // It never reported a separate commitment, so confirmed_at is stamped from
    // the moment finalization was observed rather than left null — which 0062's
    // confirmation biconditional would reject outright.
    const row = await ledgerRow(seeded.movement.id);
    expect(row).toMatchObject({ status: "finalized", amount_settled: "1" });
    expect(row?.confirmed_at).not.toBeNull();
    expect(row?.settled_at).not.toBeNull();
  });

  it("does not expire a confirmed movement whose signature aged out of RPC history", async () => {
    const seeded = await seedMovement("100");
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: 1n, err: null, confirmationStatus: "confirmed" },
    ]);
    await reconcileEarnVaultMovements(env);

    // The transaction demonstrably landed, so an unknown signature later is the
    // RPC forgetting it — never grounds to expire it on the blockhash rule, which
    // only ever applied to a transaction that never made it on chain.
    getSignatureStatuses.mockResolvedValue([null]);
    getBlockHeight.mockResolvedValue(100_000n);
    await reconcileEarnVaultMovements(env);

    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({ status: "confirmed" });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  describe("withdrawal leg ordering (0066)", () => {
    const POSITION = "earn_position_reconcile_withdraw";

    async function seedWithdrawalGroup(legs: Array<{ lastValidBlockHeight: string }>) {
      await getDb(env)
        .prepare(
          `INSERT INTO earn_positions (
             id, organization_id, project_id, environment, provider, kind,
             custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
           ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?,
                     'vault_reconcile_withdraw', 'So11111111111111111111111111111111111111112',
                     'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Exit Vault', sdp_iso_now())
           ON CONFLICT DO NOTHING`
        )
        .bind(POSITION, ORG, PROJECT, WALLET)
        .run();
      return createPostgresEarnMovementsRepository(getDb(env)).createSignedVaultWithdrawalIntent({
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        provider: "kamino",
        positionId: POSITION,
        vaultAddress: "vault_reconcile_withdraw",
        custodyWalletId: WALLET,
        shareMint: "So11111111111111111111111111111111111111112",
        requestedShares: String(legs.reduce((sum, _leg, index) => sum + index + 1, 0)),
        walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        legs: legs.map((leg, index) => ({
          shares: String(index + 1),
          signature: `sig_leg_${index}_${crypto.randomUUID()}`,
          signedTransaction: Buffer.from([index + 10]).toString("base64"),
          lastValidBlockHeight: leg.lastValidBlockHeight,
        })),
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: crypto.randomUUID(),
      });
    }

    function answerStatusesBySignature(statusBySignature: Record<string, unknown>) {
      getSignatureStatuses.mockImplementation(async (_rpc: unknown, signatures: string[]) =>
        signatures.map((signature) => statusBySignature[signature] ?? null)
      );
    }

    it("holds a later leg until its predecessor commits, then broadcasts it in order", async () => {
      const group = await seedWithdrawalGroup([
        { lastValidBlockHeight: "100" },
        { lastValidBlockHeight: "100" },
      ]);
      const [first, second] = group.legs;
      answerStatusesBySignature({});
      getBlockHeight.mockResolvedValue(50n);

      await reconcileEarnVaultMovements(env);

      // Only leg 0's bytes may reach the wire while it is uncommitted.
      expect(broadcastVaultTransaction.mock.calls.map(([, input]) => input.bytes)).toEqual([
        new Uint8Array([10]),
      ]);
      await expect(withdrawalLegRow(group.movement.id, second.leg_index)).resolves.toMatchObject({
        status: "requested",
      });

      // Once the chain reports leg 0 committed, the next ticks release leg 1.
      answerStatusesBySignature({
        [String(first.signature)]: {
          slot: 1n,
          confirmations: 1n,
          err: null,
          confirmationStatus: "confirmed",
        },
      });
      broadcastVaultTransaction.mockClear();
      await reconcileEarnVaultMovements(env);
      await reconcileEarnVaultMovements(env);

      expect(broadcastVaultTransaction.mock.calls.map(([, input]) => input.bytes)).toContainEqual(
        new Uint8Array([11])
      );
      await expect(withdrawalLegRow(group.movement.id, first.leg_index)).resolves.toMatchObject({
        status: "confirmed",
      });
      await expect(withdrawalLegRow(group.movement.id, second.leg_index)).resolves.toMatchObject({
        status: "submitted",
      });
    });

    it("fails a leg whose predecessor failed, without broadcasting it", async () => {
      const group = await seedWithdrawalGroup([
        // Leg 0 expires; leg 1's own blockhash window is still open, so the
        // ONLY thing that may fail it is the predecessor gate.
        { lastValidBlockHeight: "100" },
        { lastValidBlockHeight: "10000" },
      ]);
      const [first, second] = group.legs;
      answerStatusesBySignature({});
      getBlockHeight.mockResolvedValue(101n);

      await reconcileEarnVaultMovements(env);
      await reconcileEarnVaultMovements(env);

      await expect(withdrawalLegRow(group.movement.id, first.leg_index)).resolves.toMatchObject({
        status: "failed",
        failure_reason: "Transaction blockhash expired before confirmation",
      });
      const cascaded = await withdrawalLegRow(group.movement.id, second.leg_index);
      expect(cascaded?.status).toBe("failed");
      expect(cascaded?.failure_reason).toContain("Predecessor withdrawal leg");
      expect(broadcastVaultTransaction).not.toHaveBeenCalled();
    });
  });

  it("fails a finalized-then-errored signature without regressing a settled row", async () => {
    const seeded = await seedMovement();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: null, err: null, confirmationStatus: "finalized" },
    ]);
    await reconcileEarnVaultMovements(env);
    expect((await ledgerRow(seeded.movement.id))?.status).toBe("finalized");

    // Finalization is irreversible, so nothing may move the row afterwards — not
    // even a chain error, which at this point can only be noise.
    getSignatureStatuses.mockResolvedValue([
      {
        slot: 1n,
        confirmations: null,
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "finalized",
      },
    ]);
    await reconcileEarnVaultMovements(env);

    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({
      status: "finalized",
      failure_reason: null,
    });
  });
});
