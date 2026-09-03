import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnExternalWalletTransactionsRepository } from "@/db/repositories/earn-external-wallet-transactions.repository";
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
const { reconcileEarnVaultMovementReadThrough } = await import(
  "../earn/vault-movement-reconciliation.service"
);

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

async function seedWithdrawal(lastValidBlockHeight = "100") {
  const repository = createPostgresEarnMovementsRepository(getDb(env));
  const deposit = await seedMovement();
  await repository.advanceVaultMovement({
    movementId: deposit.movement.id,
    organizationId: ORG,
    toStatus: "failed",
    failureReason: "test setup",
  });

  return repository.createSignedVaultWithdrawalIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    positionId: deposit.position.id,
    vaultAddress: deposit.position.vault_address as string,
    custodyWalletId: WALLET,
    shareMint: deposit.position.share_mint as string,
    requestedShares: "1",
    walletAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: Buffer.from([4, 5, 6]).toString("base64"),
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

/**
 * An external-wallet (caller-signed) deposit movement: the other signer shape
 * that rides this service, via the detail read's read-through. Same ledger
 * table, `owner_address` instead of a custody wallet, and a consumed build row.
 */
async function seedExternalWalletMovement() {
  const repository = createPostgresEarnMovementsRepository(getDb(env));
  const transactionId = `earn_ewt_${crypto.randomUUID()}`;
  await createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).create({
    id: transactionId,
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    direction: "deposit",
    ownerAddress: "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF",
    vaultAddress: `vault_${crypto.randomUUID()}`,
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    shareMint: "So11111111111111111111111111111111111111112",
    label: "USDC Vault",
    denomination: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amountRequested: "1",
    createsShareAccount: false,
    unsignedTransaction: Buffer.from([7, 8, 9]).toString("base64"),
    lastValidBlockHeight: "100",
  });
  const built = await createPostgresEarnExternalWalletTransactionsRepository(getDb(env)).getById({
    organizationId: ORG,
    transactionId,
  });
  if (!built) throw new Error("external-wallet build row did not persist");
  return repository.createSignedExternalWalletDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    vaultAddress: built.vault_address,
    ownerAddress: built.owner_address,
    shareMint: built.share_mint,
    tokenMint: built.token_mint,
    label: built.label,
    requestedAmount: built.amount_requested,
    signature: `sig_${crypto.randomUUID()}`,
    signedTransaction: Buffer.from([7, 8, 9]).toString("base64"),
    lastValidBlockHeight: "100",
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: crypto.randomUUID(),
    externalWalletTransactionId: built.id,
  });
}

describe("reconcileEarnVaultMovementReadThrough", () => {
  it("records confirmed chain status during an interactive detail read", async () => {
    const seeded = await seedWithdrawal();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: 1n, err: null, confirmationStatus: "confirmed" },
    ]);

    const movement = await reconcileEarnVaultMovementReadThrough(env, seeded.movement);

    expect(movement).toMatchObject({ status: "confirmed", settled_at: null });
    expect(movement.confirmed_at).not.toBeNull();
    expect(getSignatureStatuses).toHaveBeenCalledWith(
      expect.anything(),
      [seeded.movement.signature],
      { retryDelaysMs: [], searchTransactionHistory: true }
    );
    expect(getBlockHeight).not.toHaveBeenCalled();
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("records irreversible finality without waiting for the scheduled sweep", async () => {
    const seeded = await seedWithdrawal();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: null, err: null, confirmationStatus: "finalized" },
    ]);

    const movement = await reconcileEarnVaultMovementReadThrough(env, seeded.movement);

    expect(movement).toMatchObject({ status: "finalized", amount_settled: "1" });
    expect(movement.confirmed_at).not.toBeNull();
    expect(movement.settled_at).not.toBeNull();
  });

  it("leaves an unknown signature for the durable reconciler without rebroadcasting from GET", async () => {
    const seeded = await seedWithdrawal();
    getSignatureStatuses.mockResolvedValue([null]);

    const movement = await reconcileEarnVaultMovementReadThrough(env, seeded.movement);

    expect(movement.status).toBe("requested");
    expect(getBlockHeight).not.toHaveBeenCalled();
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("fails soft to the durable row when the interactive RPC read is unavailable", async () => {
    const seeded = await seedWithdrawal();
    getSignatureStatuses.mockRejectedValue(new Error("rpc unavailable"));

    await expect(
      reconcileEarnVaultMovementReadThrough(env, seeded.movement)
    ).resolves.toMatchObject({ id: seeded.movement.id, status: "requested" });
    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({ status: "requested" });
  });

  it("coalesces concurrent interactive reads for one movement", async () => {
    const seeded = await seedWithdrawal();
    let resolveStatuses: ((statuses: Array<Record<string, unknown>>) => void) | undefined;
    getSignatureStatuses.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatuses = resolve;
        })
    );

    const first = reconcileEarnVaultMovementReadThrough(env, seeded.movement);
    const second = reconcileEarnVaultMovementReadThrough(env, seeded.movement);
    await vi.waitFor(() => expect(getSignatureStatuses).toHaveBeenCalledTimes(1));
    resolveStatuses?.([
      { slot: 1n, confirmations: 1n, err: null, confirmationStatus: "confirmed" },
    ]);

    const movements = await Promise.all([first, second]);
    expect(movements.map((movement) => movement.status)).toEqual(["confirmed", "confirmed"]);
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("bounds an interactive response while a shared RPC observation remains in flight", async () => {
    const seeded = await seedWithdrawal();
    vi.useFakeTimers();
    try {
      getSignatureStatuses.mockImplementation(() => new Promise(() => {}));
      const response = reconcileEarnVaultMovementReadThrough(env, seeded.movement);

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(response).resolves.toMatchObject({
        id: seeded.movement.id,
        status: "requested",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances an external-wallet (caller-signed) movement the same way", async () => {
    // The embedded-yield detail read adopted this read-through; an
    // owner-signed row is the same vault_direct ledger shape with a signature
    // recorded at submit, so nothing here may depend on a custody wallet.
    const seeded = await seedExternalWalletMovement();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: null, err: null, confirmationStatus: "finalized" },
    ]);

    const movement = await reconcileEarnVaultMovementReadThrough(env, seeded.movement);

    expect(movement).toMatchObject({
      status: "finalized",
      owner_address: seeded.movement.owner_address,
    });
    expect(movement.settled_at).not.toBeNull();
    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({ status: "finalized" });
  });

  it("short-circuits a terminal movement without touching the RPC", async () => {
    const seeded = await seedExternalWalletMovement();
    const repository = createPostgresEarnMovementsRepository(getDb(env));
    await repository.advanceVaultMovement({
      movementId: seeded.movement.id,
      organizationId: ORG,
      toStatus: "failed",
      failureReason: "test setup",
    });
    const terminal = await ledgerRow(seeded.movement.id);
    if (!terminal) throw new Error("terminal movement did not persist");

    const movement = await reconcileEarnVaultMovementReadThrough(env, terminal);

    expect(movement.status).toBe("failed");
    expect(getSignatureStatuses).not.toHaveBeenCalled();
  });
});

describe("reconcileEarnVaultMovements", () => {
  it("reconciles withdrawals through the same movement queue", async () => {
    const seeded = await seedWithdrawal();
    getSignatureStatuses.mockResolvedValue([
      { slot: 1n, confirmations: null, err: null, confirmationStatus: "finalized" },
    ]);

    await reconcileEarnVaultMovements(env);

    await expect(ledgerRow(seeded.movement.id)).resolves.toMatchObject({
      direction: "withdrawal",
      status: "finalized",
      amount_settled: "1",
    });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

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
