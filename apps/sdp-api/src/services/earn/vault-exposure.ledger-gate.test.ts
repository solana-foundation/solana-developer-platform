import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asTransactionalClient, getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import {
  type CreateSignedVaultDepositIntentInput,
  createPostgresEarnMovementsRepository,
} from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

/**
 * A small absolute cap on the test vault so two deposits that each fit can
 * jointly exceed it. Sandbox rows resolve to the devnet table.
 */
const VAULT = "GateVault11111111111111111111111111111111111";
vi.mock("@/routes/earn/handlers/curation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/routes/earn/handlers/curation")>();
  return {
    ...actual,
    VAULT_EXPOSURE_CAPS: {
      devnet: { [`kamino:${VAULT}`]: { maxShareOfTvlBps: 10_000, maxAbsolute: "100" } },
    },
  };
});

const {
  EARN_VOLUME_CAP_EVALUATED_EVENT,
  ledgerVaultExposureGate,
  resetVaultExposureCacheForTesting,
} = await import("./vault-exposure");

const ORG = "org_earn_gate";
const ORG_OTHER = "org_earn_gate_other";
const USER = "usr_earn_gate";
const PROJECT = "prj_earn_gate";
const PROJECT_OTHER = "prj_earn_gate_other";
const WALLET = "cw_earn_gate";
const WALLET_OTHER = "cw_earn_gate_other";
const CONFIG = "cc_earn_gate";
const CONFIG_OTHER = "cc_earn_gate_other";
const TOKEN_MINT = "GateTokenMint111111111111111111111111111111";
const SHARE_MINT = "GateShareMint111111111111111111111111111111";
const WALLET_PUBKEY = "GateDepositor111111111111111111111111111111";
const WALLET_OTHER_PUBKEY = "GateDepositorOther1111111111111111111111111";

/**
 * The write-side half of the vault exposure cap (ADR 0004 layer 1), against a
 * real Postgres: two ledger transactions racing for the same vault, the
 * per-vault advisory lock that serializes them, and the cross-tenant aggregate
 * read from inside a TENANT-stamped transaction.
 */
describe("vault exposure cap: the ledger write gate", () => {
  const ledger = () => createPostgresEarnMovementsRepository(getDb(env));
  let sequence = 0;
  let originalEnforced: string | undefined;

  beforeEach(async () => {
    const db = getDb(env);
    for (const table of ["earn_movements", "earn_positions"]) {
      await db
        .prepare(`DELETE FROM ${table} WHERE organization_id IN (?, ?)`)
        .bind(ORG, ORG_OTHER)
        .run();
    }
    await db.prepare("DELETE FROM earn_strategies WHERE provider_reference = ?").bind(VAULT).run();
    await db
      .prepare("DELETE FROM custody_wallets WHERE id IN (?, ?)")
      .bind(WALLET, WALLET_OTHER)
      .run();
    await db
      .prepare("DELETE FROM custody_configs WHERE id IN (?, ?)")
      .bind(CONFIG, CONFIG_OTHER)
      .run();
    await db
      .prepare("DELETE FROM projects WHERE organization_id IN (?, ?)")
      .bind(ORG, ORG_OTHER)
      .run();
    await db.prepare("DELETE FROM organizations WHERE id IN (?, ?)").bind(ORG, ORG_OTHER).run();
    await db.prepare("DELETE FROM users WHERE id = ?").bind(USER).run();

    await db
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'earn-gate@example.com', 1, 'active')`
      )
      .bind(USER)
      .run();
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status) VALUES
           (?, 'Earn Gate', 'earn-gate', 'individual', 'active'),
           (?, 'Earn Gate Other', 'earn-gate-other', 'individual', 'active')`
      )
      .bind(ORG, ORG_OTHER)
      .run();
    await seedDefaultProjects(db, {
      organizationId: ORG,
      createdBy: USER,
      members: [],
      ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
    });
    await seedDefaultProjects(db, {
      organizationId: ORG_OTHER,
      createdBy: USER,
      members: [],
      ids: { sandbox: PROJECT_OTHER, production: `${PROJECT_OTHER}_production` },
    });
    for (const [config, org, wallet, pubkey] of [
      [CONFIG, ORG, WALLET, WALLET_PUBKEY],
      [CONFIG_OTHER, ORG_OTHER, WALLET_OTHER, WALLET_OTHER_PUBKEY],
    ]) {
      await db
        .prepare(
          `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted)
           VALUES (?, ?, NULL, 'local', 'encrypted')`
        )
        .bind(config, org)
        .run();
      await db
        .prepare(
          `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label)
           VALUES (?, ?, ?, ?, 'Earn gate wallet')`
        )
        .bind(wallet, config, `${wallet}-ref`, pubkey)
        .run();
    }
    await createPostgresEarnRepository(db).upsertStrategy({
      provider: "kamino",
      providerReference: VAULT,
      name: "Gate Vault",
      sourceKind: "defi",
      underlyingSource: "kamino",
      depositMints: [TOKEN_MINT],
      shareMint: SHARE_MINT,
      apyType: "variable",
      currentApy: "0.05",
      liquidityTerm: "instant",
      redemptionDelayDays: null,
      riskMetadata: {},
      status: "active",
      hostCluster: "devnet",
      environment: "sandbox",
    });

    resetVaultExposureCacheForTesting();
    logEvent.mockClear();
    sequence = 0;
    originalEnforced = env.EARN_VOLUME_CAPS_ENFORCED;
    env.EARN_VOLUME_CAPS_ENFORCED = "true";
  });

  afterEach(() => {
    env.EARN_VOLUME_CAPS_ENFORCED = originalEnforced;
  });

  function intent(
    amount: string,
    overrides: Partial<CreateSignedVaultDepositIntentInput> = {}
  ): CreateSignedVaultDepositIntentInput {
    sequence += 1;
    return {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      provider: "kamino",
      vaultAddress: VAULT,
      sourceAddress: WALLET_PUBKEY,
      custodyWalletId: WALLET,
      shareMint: SHARE_MINT,
      tokenMint: TOKEN_MINT,
      label: "Gate Vault",
      requestedAmount: amount,
      acceptedMinSharesOut: null,
      signature: `earn-gate-signature-${sequence}`,
      signedTransaction: `earn-gate-transaction-${sequence}`,
      lastValidBlockHeight: "123456",
      requestId: `earn-gate-request-${sequence}`,
      idempotencyFingerprint: `earn-gate-fingerprint-${sequence}`,
      createdBy: USER,
      initiatedByKeyId: null,
      admit: ledgerVaultExposureGate(env, {
        environment: "sandbox",
        provider: "kamino",
        vaultAddress: VAULT,
        amount,
      }),
      ...overrides,
    };
  }

  /** Write as the organization would: a tenant-stamped transaction, not the test's system identity. */
  function asTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenantDatabaseIdentity({ organizationId }, fn);
  }

  async function ledgerRows() {
    const result = await getDb(env)
      .prepare(
        "SELECT organization_id, amount_requested FROM earn_movements WHERE vault_address = ?"
      )
      .bind(VAULT)
      .all<{ organization_id: string; amount_requested: string }>();
    return result.results ?? [];
  }

  async function positionCount() {
    const row = await getDb(env)
      .prepare("SELECT count(*)::int AS n FROM earn_positions WHERE vault_address = ?")
      .bind(VAULT)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  function ledgerWriteEvents() {
    return logEvent.mock.calls
      .map(([, payload]) => payload)
      .filter(
        (payload) =>
          payload?.event === EARN_VOLUME_CAP_EVALUATED_EVENT && payload?.stage === "ledger_write"
      );
  }

  /**
   * Holds every arriving caller until `parties` of them have arrived, so both
   * ledger transactions are provably OPEN before either asks for the vault
   * lock. Without it the race is only probable.
   */
  function rendezvous(parties: number) {
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      arrived += 1;
      if (arrived === parties) release();
      return gate;
    };
  }

  /** Open the transaction, wait at the rendezvous, then run the write inside it. */
  function overlappingWrite(meet: () => Promise<void>, input: CreateSignedVaultDepositIntentInput) {
    return getDb(env).transaction(async (transaction) => {
      await meet();
      return createPostgresEarnMovementsRepository(
        asTransactionalClient(transaction)
      ).createSignedVaultDepositIntent(input);
    });
  }

  it("lets exactly one of two overlapping deposits land when together they exceed the cap", async () => {
    const meet = rendezvous(2);
    const outcomes = await asTenant(ORG, () =>
      Promise.allSettled([
        overlappingWrite(meet, intent("60")),
        overlappingWrite(meet, intent("60")),
      ])
    );

    const landed = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const refused = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "VAULT_EXPOSURE_CAP",
      statusCode: 409,
      details: { vaultAddress: VAULT, limit: "100", exposure: "60", projected: "120" },
    });

    // The loser rolled its claim back with its row: one movement, one holding.
    expect(await ledgerRows()).toEqual([{ organization_id: ORG, amount_requested: "60" }]);
    expect(await positionCount()).toBe(1);

    // Both writes were evaluated at the ledger stage; the second saw the first.
    expect(ledgerWriteEvents().map((event) => [event.exposure, event.would_block])).toEqual(
      expect.arrayContaining([
        ["0", false],
        ["60", true],
      ])
    );
  });

  it("answers a same-key twin that raced the write as a replay, never a refusal", async () => {
    // Two requests with the SAME idempotency key and payload, both past the
    // unlocked replay preflight before either has a row. The vault has room
    // for exactly one of them. The one that wins the lock records; the twin
    // must come back as ITS replay, not as a 409 from the cap.
    const meet = rendezvous(2);
    const first = intent("100");
    const twin = {
      ...first,
      signature: "earn-gate-signature-twin",
      signedTransaction: "earn-gate-transaction-twin",
    };

    const results = await asTenant(ORG, () =>
      Promise.all([overlappingWrite(meet, first), overlappingWrite(meet, twin)])
    );

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.movement.id)).size).toBe(1);
    expect(await ledgerRows()).toEqual([{ organization_id: ORG, amount_requested: "100" }]);
    // The cap was decided once: the twin never reached the hook.
    expect(ledgerWriteEvents()).toHaveLength(1);
  });

  it("counts every organization's deposits from inside a tenant-stamped transaction", async () => {
    // The other organization fills most of the vault. Then ORG writes under
    // ITS tenant identity, which row-level security would ordinarily scope to
    // ORG's own rows: the cap must still see the other organization's 90.
    await asTenant(ORG_OTHER, () =>
      ledger().createSignedVaultDepositIntent(
        intent("90", {
          organizationId: ORG_OTHER,
          projectId: PROJECT_OTHER,
          custodyWalletId: WALLET_OTHER,
          sourceAddress: WALLET_OTHER_PUBKEY,
        })
      )
    );

    await expect(
      asTenant(ORG, () => ledger().createSignedVaultDepositIntent(intent("11")))
    ).rejects.toMatchObject({
      code: "VAULT_EXPOSURE_CAP",
      details: { exposure: "90", projected: "101" },
    });
    // Landing exactly on the ceiling is admitted (strict comparison).
    await asTenant(ORG, () => ledger().createSignedVaultDepositIntent(intent("10")));

    expect((await ledgerRows()).map((row) => row.amount_requested).sort()).toEqual(["10", "90"]);
  });

  it("answers a replay from its recorded row without re-deciding the cap", async () => {
    const first = intent("100");
    const created = await asTenant(ORG, () => ledger().createSignedVaultDepositIntent(first));
    expect(created.replayed).toBe(false);
    logEvent.mockClear();

    // The vault is now full; a retry of the SAME request is the same deposit,
    // not a new one, and must come back as the replay rather than a 409.
    const replayed = await asTenant(ORG, () =>
      ledger().createSignedVaultDepositIntent({
        ...first,
        signature: "earn-gate-signature-retry",
        signedTransaction: "earn-gate-transaction-retry",
      })
    );
    expect(replayed).toMatchObject({ replayed: true, movement: { id: created.movement.id } });
    expect(ledgerWriteEvents()).toEqual([]);
  });

  it("only observes in shadow mode: both deposits land and the overshoot is on the event", async () => {
    env.EARN_VOLUME_CAPS_ENFORCED = undefined;

    await asTenant(ORG, () => ledger().createSignedVaultDepositIntent(intent("60")));
    await asTenant(ORG, () => ledger().createSignedVaultDepositIntent(intent("60")));

    expect((await ledgerRows()).map((row) => row.amount_requested)).toEqual(["60", "60"]);
    expect(ledgerWriteEvents().at(-1)).toMatchObject({
      would_block: true,
      enforced: false,
      exposure: "60",
      projected: "120",
    });
  });
});
