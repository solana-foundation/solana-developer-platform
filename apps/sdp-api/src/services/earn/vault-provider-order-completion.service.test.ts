import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const readDepositOrderCompletion = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/execution-registry")>()),
  // Every provider-order provider resolves to the same stubbed completion
  // reader: the pass's own logic, not the client's identity, is under test.
  resolveVaultDirectClient: () => ({ readDepositOrderCompletion }),
}));

const { completeProviderOrderDeposits } = await import("./vault-provider-order-completion.service");

const ORG = "org_provider_completion";
const PROJECT = "prj_provider_completion";
const USER = "usr_provider_completion";
const WALLET = "cwlt_provider_completion";
const COMPLETED_AT = "2026-09-22T10:00:00.000Z";

beforeEach(async () => {
  await seedTestDatabase(env);
  vi.clearAllMocks();
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Provider Completion", "provider-completion", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "provider-completion@example.com"),
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
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_provider_completion', ?, ?, 'privy', 'test', 'active')`
      )
      .bind(ORG, PROJECT),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_provider_completion', 'privy_provider_completion',
                 '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'active')`
      )
      .bind(WALLET),
  ]);
});

let sequence = 0;

/** A chain-final WisdomTree deposit: the row the completion pass serves. */
async function chainFinalDeposit() {
  sequence += 1;
  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  const recorded = await ledger.createSignedVaultDepositIntent({
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "wisdomtree",
    vaultAddress: `vault_provider_completion_${sequence}`,
    custodyWalletId: WALLET,
    shareMint: "So11111111111111111111111111111111111111112",
    tokenMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "WTGXX vault",
    requestedAmount: "250.50",
    sourceAddress: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    signature: `sig_provider_completion_${sequence}`,
    signedTransaction: Buffer.from([1, 2, sequence]).toString("base64"),
    lastValidBlockHeight: "100",
    requestId: crypto.randomUUID(),
    idempotencyFingerprint: crypto.randomUUID(),
    depositIntentFingerprint: crypto.randomUUID(),
  });
  await ledger.advanceVaultMovement({
    movementId: recorded.movement.id,
    organizationId: ORG,
    toStatus: "confirmed",
    confirmedAt: "2026-08-19T12:00:00.000Z",
  });
  await ledger.recordVaultMovementChainFinalization({
    movementId: recorded.movement.id,
    organizationId: ORG,
    observedAt: "2026-08-19T12:05:00.000Z",
  });
  // Backdate the row past the completion pass's retry spacing: a freshly
  // recorded movement is not due for its first attempt for 15 minutes.
  await getDb(env)
    .prepare("UPDATE earn_movements SET created_at = ? WHERE id = ?")
    .bind("2026-08-19T12:00:00.000Z", recorded.movement.id)
    .run();
  return recorded.movement;
}

async function ledgerRow(movementId: string) {
  return createPostgresEarnMovementsRepository(getDb(env)).getMovementById({
    movementId,
    organizationId: ORG,
  });
}

describe("completeProviderOrderDeposits", () => {
  it("stamps a demonstrated completion with the order's own identity", async () => {
    const movement = await chainFinalDeposit();
    readDepositOrderCompletion.mockResolvedValue({
      orderReference: "order-1",
      completedAt: COMPLETED_AT,
    });

    await expect(completeProviderOrderDeposits(env)).resolves.toEqual({
      claimed: 1,
      completed: 1,
      unobserved: 0,
      errors: 0,
    });

    await expect(ledgerRow(movement.id)).resolves.toMatchObject({
      provider_completed_at: COMPLETED_AT,
      provider_completed_order_reference: "order-1",
    });
    // The reader is told the deposit's own record instant (the seed's
    // backdate) and that nothing has been consumed yet.
    expect(readDepositOrderCompletion).toHaveBeenCalledWith(
      { env, environment: "sandbox" },
      expect.objectContaining({
        owner: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        amountRequested: "250.50",
        movementCreatedAt: "2026-08-19T12:00:00.000Z",
        excludedOrderReferences: [],
      })
    );
  });

  it("never settles a second deposit from an order that already completed another", async () => {
    // The exact double-deposit the order identity closes: two chain-final
    // deposits of the same shape, one completed order. The first stamp takes
    // it; the second movement's claim on the SAME order does not apply, the
    // row stays open, and its cross-key claim keeps holding — until the pass
    // feeds the reader the consumed identity and the deposit's OWN order
    // demonstrates completion.
    const first = await chainFinalDeposit();
    const second = await chainFinalDeposit();
    readDepositOrderCompletion.mockResolvedValue({
      orderReference: "order-shared",
      completedAt: COMPLETED_AT,
    });

    await expect(completeProviderOrderDeposits(env)).resolves.toMatchObject({
      claimed: 2,
      completed: 1,
      unobserved: 1,
      errors: 0,
    });
    await expect(ledgerRow(first.id)).resolves.toMatchObject({
      provider_completed_order_reference: "order-shared",
    });
    await expect(ledgerRow(second.id)).resolves.toMatchObject({
      provider_completed_at: null,
      provider_completed_order_reference: null,
    });

    // A consumed order never resurfaces as a candidate: the next pass (past
    // the retry spacing) hands the reader the identity the ledger accepted,
    // and only the deposit's own order can close it.
    const ledger = createPostgresEarnMovementsRepository(getDb(env));
    await expect(
      ledger.findOpenVaultDepositIntentClaim({
        organizationId: ORG,
        projectId: PROJECT,
        depositIntentFingerprint: first.deposit_intent_fingerprint ?? "",
        requestedMinSharesOut: null,
      })
    ).resolves.toBeNull();
    await expect(
      ledger.findOpenVaultDepositIntentClaim({
        organizationId: ORG,
        projectId: PROJECT,
        depositIntentFingerprint: second.deposit_intent_fingerprint ?? "",
        requestedMinSharesOut: null,
      })
    ).resolves.toMatchObject({ id: second.id });

    readDepositOrderCompletion.mockResolvedValue({
      orderReference: "order-own",
      completedAt: COMPLETED_AT,
    });
    await expect(
      completeProviderOrderDeposits(env, { now: Date.now() + 16 * 60_000 })
    ).resolves.toMatchObject({ claimed: 1, completed: 1, unobserved: 0, errors: 0 });

    expect(readDepositOrderCompletion).toHaveBeenLastCalledWith(
      { env, environment: "sandbox" },
      expect.objectContaining({ excludedOrderReferences: ["order-shared"] })
    );
    await expect(ledgerRow(second.id)).resolves.toMatchObject({
      provider_completed_order_reference: "order-own",
    });
    await expect(
      ledger.findOpenVaultDepositIntentClaim({
        organizationId: ORG,
        projectId: PROJECT,
        depositIntentFingerprint: second.deposit_intent_fingerprint ?? "",
        requestedMinSharesOut: null,
      })
    ).resolves.toBeNull();
  });
});
