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

/**
 * The bounded exclusion slice, behind a switch: the walk test needs the pass
 * to read an EMPTY slice while the ledger's unique index still refuses a
 * second stamp of the same order — the slice's newest-first ceiling,
 * compressed to a flag.
 */
let exclusionSliceEnabled = true;

vi.mock("@/db/repositories/earn-movements.repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/db/repositories/earn-movements.repository")>();
  const real = actual.createPostgresEarnMovementsRepository;
  return {
    ...actual,
    createPostgresEarnMovementsRepository: (...args: Parameters<typeof real>) => {
      const repo = real(...args);
      return {
        ...repo,
        listCompletedProviderOrderReferences: (
          ...refArgs: Parameters<typeof repo.listCompletedProviderOrderReferences>
        ) =>
          exclusionSliceEnabled
            ? repo.listCompletedProviderOrderReferences(...refArgs)
            : Promise.resolve([]),
      };
    },
  };
});

const { completeProviderOrderDeposits } = await import("./vault-provider-order-completion.service");

const ORG = "org_provider_completion";
const PROJECT = "prj_provider_completion";
const USER = "usr_provider_completion";
const WALLET = "cwlt_provider_completion";
const COMPLETED_AT = "2026-09-22T10:00:00.000Z";

beforeEach(async () => {
  await seedTestDatabase(env);
  vi.clearAllMocks();
  exclusionSliceEnabled = true;
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

  it("walks past a consumed order the bounded exclusion slice no longer holds", async () => {
    // The slice is a newest-first LIMIT: once enough orders have completed, an
    // older consumed identity drops out of it — and a reader that still sees
    // that order in the feed would re-select it for a twin deposit on every
    // tick, the ledger refusing its stamp each time, never reaching the twin's
    // own order, its settlement and cross-key claim stuck for good. This test
    // hides the consumed identity from the slice entirely (the slice ceiling,
    // compressed) while the unique index still refuses a second stamp of it:
    // the pass must feed the refused identity back into the read and settle
    // from the deposit's OWN order.
    exclusionSliceEnabled = false;
    const settledElsewhere = await chainFinalDeposit();
    const second = await chainFinalDeposit();
    const ledger = createPostgresEarnMovementsRepository(getDb(env));
    await expect(
      ledger.recordVaultMovementProviderCompletion({
        movementId: settledElsewhere.id,
        organizationId: ORG,
        completedAt: COMPLETED_AT,
        orderReference: "order-stale",
      })
    ).resolves.toMatchObject({ id: settledElsewhere.id });

    // The feed offers the stale order first, then the deposit's own one.
    let candidate: string | null = "order-stale";
    readDepositOrderCompletion.mockImplementation(
      async (
        _ctx: unknown,
        input: { providerReference: string | null }
      ): Promise<{ orderReference: string; completedAt: string } | null> => {
        if (input.providerReference !== second.vault_address) return null;
        const current = candidate;
        candidate = "order-own";
        return current === null ? null : { orderReference: current, completedAt: COMPLETED_AT };
      }
    );

    await expect(completeProviderOrderDeposits(env)).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      unobserved: 0,
      errors: 0,
    });
    await expect(ledgerRow(second.id)).resolves.toMatchObject({
      provider_completed_order_reference: "order-own",
    });

    // The second read carried the refused identity: the walk, not luck.
    const reads = readDepositOrderCompletion.mock.calls.filter(
      ([, input]) =>
        (input as { providerReference: string | null }).providerReference === second.vault_address
    );
    expect(reads).toHaveLength(2);
    expect(
      (reads[1][1] as { excludedOrderReferences: string[] }).excludedOrderReferences
    ).toContain("order-stale");
  });
});
