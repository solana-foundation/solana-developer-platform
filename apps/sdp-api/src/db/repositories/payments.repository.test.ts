import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { PaymentsRepository } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";

const TEST_PROJECT_ID = "prj_payments_repo_test";
const OTHER_PROJECT_ID = "prj_payments_repo_test_other";
const TEST_WALLET_ID = "wallet_payments_repo_test";
const ORG_CUSTODY_CONFIG_ID = "ccfg_payments_repo_org";
const PROJECT_CUSTODY_CONFIG_ID = "ccfg_payments_repo_project";
const ORG_CUSTODY_WALLET_ID = "cwal_payments_repo_org";
const PROJECT_CUSTODY_WALLET_ID = "cwal_payments_repo_project";
const CANCELABLE = ["pending", "awaiting_payment"] as const;

describe("PaymentsRepository.updateTransferStatusGuarded (postgres)", () => {
  let repo: PaymentsRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_wallet_policies").run();
    await db.prepare("DELETE FROM custody_scope_defaults").run();
    await db.prepare("DELETE FROM custody_wallets").run();
    await db.prepare("DELETE FROM custody_configs").run();
    await db.prepare("DELETE FROM payment_transfers").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    repo = createPostgresPaymentsRepository(db);
  });

  it("installs the indexed payment-ledger search plan", async () => {
    const extension = await getDb(env)
      .prepare("SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'")
      .first<{ extname: string }>();
    const indexes = await getDb(env)
      .prepare(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE indexname IN (
           'idx_payment_transfers_project_source_created_id',
           'idx_payment_transfers_project_destination_created_id',
           'idx_payment_transfers_search_trgm',
           'idx_counterparties_display_name_trgm'
         )`
      )
      .all<{ indexdef: string; indexname: string }>();

    expect(extension?.extname).toBe("pg_trgm");
    expect(indexes.results.map((index) => index.indexname).sort()).toEqual([
      "idx_counterparties_display_name_trgm",
      "idx_payment_transfers_project_destination_created_id",
      "idx_payment_transfers_project_source_created_id",
      "idx_payment_transfers_search_trgm",
    ]);
    expect(
      indexes.results
        .filter((index) => index.indexname.endsWith("_trgm"))
        .every((index) => index.indexdef.includes("gin_trgm_ops"))
    ).toBe(true);
  });

  async function seedTransfer(input: {
    id: string;
    status: string;
    projectId?: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    await getDb(env)
      .prepare(
        `INSERT INTO payment_transfers
           (id, organization_id, project_id, wallet_id, token, type, direction, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        TEST_ORG.id,
        input.projectId === undefined ? TEST_PROJECT_ID : input.projectId,
        TEST_WALLET_ID,
        "USDC",
        "offramp",
        "outbound",
        input.status,
        now,
        now
      )
      .run();
  }

  async function readStatus(id: string): Promise<string | null> {
    const row = await getDb(env)
      .prepare("SELECT status FROM payment_transfers WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status ?? null;
  }

  it("transitions the status when the current status is in fromStatuses", async () => {
    await seedTransfer({ id: "xfr_guard_ok", status: "awaiting_payment" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_ok",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated?.status).toBe("canceled");
    expect(await readStatus("xfr_guard_ok")).toBe("canceled");
  });

  it("is a no-op returning null when the status moved out of fromStatuses (the race)", async () => {
    await seedTransfer({ id: "xfr_guard_race", status: "settling" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_race",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_race")).toBe("settling");
  });

  it("returns null for a transfer that does not exist", async () => {
    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_missing",
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
  });

  it("does not transition a transfer owned by a different organization", async () => {
    await seedTransfer({ id: "xfr_guard_org", status: "awaiting_payment" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_org",
      organizationId: "org_someone_else",
      projectId: TEST_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_org")).toBe("awaiting_payment");
  });

  it("does not transition a transfer scoped to a different project", async () => {
    await seedTransfer({ id: "xfr_guard_project", status: "awaiting_payment" });

    const updated = await repo.updateTransferStatusGuarded({
      transferId: "xfr_guard_project",
      organizationId: TEST_ORG.id,
      projectId: OTHER_PROJECT_ID,
      fromStatuses: CANCELABLE,
      toStatus: "canceled",
      updatedAt: new Date().toISOString(),
    });

    expect(updated).toBeNull();
    expect(await readStatus("xfr_guard_project")).toBe("awaiting_payment");
  });

  it("makes a valid foreign transfer id indistinguishable from a missing row", async () => {
    await seedTransfer({
      id: "xfr_foreign_valid_id",
      status: "awaiting_payment",
      projectId: OTHER_PROJECT_ID,
    });
    const scoped = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      })
    );

    await expect(
      scoped.updateTransfer({
        transferId: "xfr_foreign_valid_id",
        status: "confirmed",
        updatedAt: new Date().toISOString(),
      })
    ).resolves.toBeNull();
    await expect(
      scoped.getTransferById({
        transferId: "xfr_foreign_valid_id",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      })
    ).resolves.toBeNull();
    expect(await readStatus("xfr_foreign_valid_id")).toBe("awaiting_payment");
  });

  it("lets an organization-scoped repository read and update project transfers", async () => {
    await seedTransfer({ id: "xfr_org_admin", status: "awaiting_payment" });
    const scoped = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: null })
    );

    await expect(
      scoped.getTransferById({
        transferId: "xfr_org_admin",
        organizationId: TEST_ORG.id,
        projectId: null,
      })
    ).resolves.toMatchObject({ id: "xfr_org_admin", project_id: TEST_PROJECT_ID });
    await expect(
      scoped.updateTransfer({
        transferId: "xfr_org_admin",
        status: "confirmed",
        updatedAt: new Date().toISOString(),
      })
    ).resolves.toMatchObject({ id: "xfr_org_admin", status: "confirmed" });
  });

  it("allows inherited wallet-policy reads but reserves organization-wallet writes", async () => {
    const db = getDb(env);
    for (const [configId, projectId, walletId, custodyWalletId, publicKey] of [
      [ORG_CUSTODY_CONFIG_ID, null, "wallet_org", ORG_CUSTODY_WALLET_ID, "OrgWallet111"],
      [
        PROJECT_CUSTODY_CONFIG_ID,
        TEST_PROJECT_ID,
        "wallet_project",
        PROJECT_CUSTODY_WALLET_ID,
        "ProjectWallet111",
      ],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, status)
           VALUES (?, ?, ?, 'local', 'encrypted', 'active')`
        )
        .bind(configId, TEST_ORG.id, projectId)
        .run();
      await db
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, 'Payments repository wallet', 'transfer', 'active')`
        )
        .bind(custodyWalletId, configId, walletId, publicKey)
        .run();
    }

    const now = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO payment_wallet_policies
           (id, custody_wallet_id, policy_type, policy, created_at, updated_at)
         VALUES ('pwp_org', ?, 'transfer', 'deny', ?, ?)`
      )
      .bind(ORG_CUSTODY_WALLET_ID, now, now)
      .run();

    const projectScoped = createPostgresPaymentsRepository(
      db,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT_ID })
    );
    await expect(
      projectScoped.getWalletPoliciesByCustodyWalletId(ORG_CUSTODY_WALLET_ID)
    ).resolves.toHaveLength(1);
    await expect(
      projectScoped.upsertWalletPolicies([
        {
          id: "pwp_project_attack",
          custodyWalletId: ORG_CUSTODY_WALLET_ID,
          policyType: "transfer",
          policy: "allow",
          createdAt: now,
          updatedAt: now,
        },
      ])
    ).rejects.toBeInstanceOf(TenantScopeViolationError);

    const organizationScoped = createPostgresPaymentsRepository(
      db,
      createTenantScope({ organizationId: TEST_ORG.id, projectId: null })
    );
    await expect(
      organizationScoped.getWalletPoliciesByCustodyWalletId(PROJECT_CUSTODY_WALLET_ID)
    ).resolves.toEqual([]);
    await expect(
      organizationScoped.upsertWalletPolicies([
        {
          id: "pwp_org_admin",
          custodyWalletId: PROJECT_CUSTODY_WALLET_ID,
          policyType: "transfer",
          policy: "allow",
          createdAt: now,
          updatedAt: now,
        },
      ])
    ).resolves.toHaveLength(1);
  });

  it("rejects forged tenant claims before querying and preserves same-tenant writes", async () => {
    await seedTransfer({ id: "xfr_owned_valid_id", status: "awaiting_payment" });
    const scoped = createPostgresPaymentsRepository(
      getDb(env),
      createTenantScope({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
      })
    );

    await expect(
      scoped.getTransferById({
        transferId: "xfr_owned_valid_id",
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
      })
    ).rejects.toBeInstanceOf(TenantScopeViolationError);

    await expect(
      scoped.updateTransfer({
        transferId: "xfr_owned_valid_id",
        status: "confirmed",
        updatedAt: new Date().toISOString(),
      })
    ).resolves.toMatchObject({ id: "xfr_owned_valid_id", status: "confirmed" });
  });

  it("persists idempotency metadata and looks it up by (org, key)", async () => {
    const repo = createPostgresPaymentsRepository(getDb(env));
    const created = await repo.createTransfer({
      organizationId: TEST_ORG.id,
      projectId: null,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: "Source111",
      destinationAddress: "Dest111",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyKey: "key-abc",
      idempotencyFingerprint: "fp-1",
    });
    expect(created?.idempotency_key).toBe("key-abc");

    const found = await repo.findTransferByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: null,
      idempotencyKey: "key-abc",
    });
    expect(found?.id).toBe(created?.id);
    expect(found?.idempotency_fingerprint).toBe("fp-1");
  });

  it("scopes idempotency to project — same org+key in different projects do not collide", async () => {
    const repo = createPostgresPaymentsRepository(getDb(env));
    const base = {
      organizationId: TEST_ORG.id,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: "Source111",
      destinationAddress: "Dest111",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer" as const,
      direction: "outbound" as const,
      status: "processing" as const,
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyFingerprint: "fp-1",
      idempotencyKey: "shared-key",
    };
    const orgLevel = await repo.createTransfer({ ...base, projectId: null });
    const projectScoped = await repo.createTransfer({ ...base, projectId: TEST_PROJECT_ID });
    expect(orgLevel?.id).not.toBe(projectScoped?.id);

    const foundOrg = await repo.findTransferByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: null,
      idempotencyKey: "shared-key",
    });
    const foundProject = await repo.findTransferByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      idempotencyKey: "shared-key",
    });
    expect(foundOrg?.id).toBe(orgLevel?.id);
    expect(foundProject?.id).toBe(projectScoped?.id);
  });

  it("rejects a second transfer with the same (org, idempotency_key)", async () => {
    const repo = createPostgresPaymentsRepository(getDb(env));
    const base = {
      organizationId: TEST_ORG.id,
      projectId: null,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: "Source111",
      destinationAddress: "Dest111",
      token: "SOL",
      amount: "1",
      memo: null,
      type: "transfer" as const,
      direction: "outbound" as const,
      status: "processing" as const,
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyFingerprint: "fp-1",
    };
    await repo.createTransfer({ ...base, idempotencyKey: "dup-key" });
    await expect(repo.createTransfer({ ...base, idempotencyKey: "dup-key" })).rejects.toSatisfy(
      (err: unknown) => isPostgresUniqueViolation(err)
    );
  });
});

describe("PaymentsRepository.listTransfers token filter (postgres)", () => {
  const SOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_transfers").run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
  });

  function transfer(token: string, suffix: string) {
    return {
      organizationId: TEST_ORG.id,
      projectId: null,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: `Source${suffix}`,
      destinationAddress: `Dest${suffix}`,
      token,
      amount: "1",
      memo: null,
      type: "transfer" as const,
      direction: "outbound" as const,
      status: "processing" as const,
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: null,
      idempotencyKey: `token-filter-${suffix}`,
      idempotencyFingerprint: `fp-${suffix}`,
    };
  }

  async function seedMixedForms() {
    // Exactly the shape the local ledger holds: the same asset written as a bare
    // symbol on some rows and as its mint on others, all with type = transfer.
    const repo = createPostgresPaymentsRepository(getDb(env));
    await repo.createTransfer(transfer("SOL", "sym-1"));
    await repo.createTransfer(transfer("SOL", "sym-2"));
    await repo.createTransfer(transfer(SOL_MINT_ADDRESS, "mint-1"));
    return repo;
  }

  const listArgs = { organizationId: TEST_ORG.id, projectId: null, limit: 50, offset: 0 };

  it("returns the mint rows and the symbol rows for one filter", async () => {
    const repo = await seedMixedForms();

    // An exact match returned 2 for the symbol and 1 for the mint. Both are the
    // same asset, so either spelling has to answer with all three.
    const bySymbol = await repo.listTransfers({ ...listArgs, token: "SOL" });
    const byMint = await repo.listTransfers({ ...listArgs, token: SOL_MINT_ADDRESS });

    expect(bySymbol.rows).toHaveLength(3);
    expect(byMint.rows).toHaveLength(3);
  });

  it("does not pull in a different asset that happens to share the catalogue", async () => {
    const repo = await seedMixedForms();
    await repo.createTransfer(transfer("USDC", "usdc-1"));

    const bySymbol = await repo.listTransfers({ ...listArgs, token: "SOL" });

    expect(bySymbol.rows).toHaveLength(3);
    expect(bySymbol.rows.every((row) => row.token !== "USDC")).toBe(true);
  });

  it("treats a blank token as no filter rather than as a value to match", async () => {
    const repo = await seedMixedForms();

    // The query schema takes `token` as a bare optional string, so whitespace
    // reaches the repository truthy. Matching it literally returned zero rows for
    // what is really an absent filter.
    const blank = await repo.listTransfers({ ...listArgs, token: "   " });

    expect(blank.rows).toHaveLength(3);
  });

  it("returns nothing for a token the organization has never transferred", async () => {
    const repo = await seedMixedForms();

    const none = await repo.listTransfers({ ...listArgs, token: "JUP" });

    expect(none.rows).toHaveLength(0);
  });
});
