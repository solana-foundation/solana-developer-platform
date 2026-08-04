import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type {
  CreateEarnMovementInput,
  EarnMovementRow,
  EarnPositionRow,
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProviderWalletInput,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import { createPostgresEarnRepository } from "./earn.repository.postgres";

const TEST_PROJECT_ID = "prj_earn_repo_test";
const OTHER_PROJECT_ID = "prj_earn_repo_test_other";
const TEST_WALLET_ID = "wlt_earn_repo_test";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Bulk catalogue syncs land many rows on one sdp_iso_now() value, so every
// list ORDER BY carries an id tiebreaker (see 0048_earn.sql). Pinning
// created_at reproduces that case deterministically.
const SHARED_CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("EarnRepository (postgres)", () => {
  let repo: EarnRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM earn_nav_snapshots").run();
    await db.prepare("DELETE FROM earn_movements").run();
    await db.prepare("DELETE FROM earn_positions").run();
    await db.prepare("DELETE FROM earn_strategies").run();
    await db.prepare("DELETE FROM earn_provider_wallets").run();
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

    repo = createPostgresEarnRepository(db);
  });

  function strategyInput(
    overrides: Partial<UpsertEarnStrategyInput> = {}
  ): UpsertEarnStrategyInput {
    return {
      provider: "veda",
      providerReference: "vault-usdc-prime",
      name: "USDC Prime Vault",
      sourceKind: "defi",
      underlyingSource: "kamino",
      depositMints: [USDC_MINT],
      shareMint: null,
      apyType: "variable",
      currentApy: "0.052",
      liquidityTerm: "instant",
      redemptionDelayDays: null,
      riskMetadata: { curator: "gauntlet" },
      status: "active",
      environment: "sandbox",
      ...overrides,
    };
  }

  async function seedStrategy(
    overrides: Partial<UpsertEarnStrategyInput> = {}
  ): Promise<EarnStrategyRow> {
    const row = await repo.upsertStrategy(strategyInput(overrides));
    if (!row) {
      throw new Error("failed to seed strategy");
    }
    return row;
  }

  async function seedPosition(params: {
    strategyId: string;
    walletId?: string;
    projectId?: string;
  }): Promise<EarnPositionRow> {
    const row = await repo.createPosition({
      organizationId: TEST_ORG.id,
      projectId: params.projectId ?? TEST_PROJECT_ID,
      strategyId: params.strategyId,
      walletId: params.walletId ?? TEST_WALLET_ID,
    });
    if (!row) {
      throw new Error("failed to seed position");
    }
    return row;
  }

  async function seedMovement(
    position: EarnPositionRow,
    overrides: Partial<CreateEarnMovementInput> = {}
  ): Promise<EarnMovementRow> {
    const row = await repo.createMovement({
      organizationId: position.organization_id,
      projectId: position.project_id,
      positionId: position.id,
      strategyId: position.strategy_id,
      direction: "deposit",
      tokenMint: USDC_MINT,
      amount: "1000000",
      shareAmount: null,
      provider: null,
      providerReference: null,
      providerData: {},
      externalId: null,
      redemptionAvailableAt: null,
      ...overrides,
    });
    if (!row) {
      throw new Error("failed to seed movement");
    }
    return row;
  }

  async function freezeCreatedAt(
    table: "earn_strategies" | "earn_movements",
    ids: readonly string[]
  ): Promise<void> {
    const db = getDb(env);
    for (const id of ids) {
      await db
        .prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`)
        .bind(SHARED_CREATED_AT, id)
        .run();
    }
  }

  describe("upsertStrategy", () => {
    it("inserts a catalogue row and round-trips the jsonb columns", async () => {
      const row = await seedStrategy();

      expect(row.id).toMatch(/^earn_strategy_/);
      expect(row.deposit_mints).toEqual([USDC_MINT]);
      expect(row.risk_metadata).toEqual({ curator: "gauntlet" });
      expect(row.status).toBe("active");
      expect(row.environment).toBe("sandbox");
    });

    it("keeps an operator pause when the sync re-upserts the source as active", async () => {
      // The hourly catalogue sync always upserts `active` for anything the
      // provider still lists. An emergency pause has to survive that, or it
      // silently expires within the hour and deposits resume into a strategy
      // stopped for an exploit or depeg.
      await seedStrategy();
      await repo.upsertStrategy(strategyInput({ status: "paused" }));

      const resynced = await repo.upsertStrategy(
        strategyInput({ name: "USDC Prime Vault v3", currentApy: "0.072", status: "active" })
      );

      expect(resynced?.status).toBe("paused");
      // Metadata and rates still flow — only the status is protected.
      expect(resynced?.name).toBe("USDC Prime Vault v3");
      expect(resynced?.current_apy).toBe("0.072");
    });

    it("keeps a deprecation when the sync re-upserts the source as active", async () => {
      await seedStrategy();
      await repo.upsertStrategy(strategyInput({ status: "deprecated" }));

      const resynced = await repo.upsertStrategy(strategyInput({ status: "active" }));

      expect(resynced?.status).toBe("deprecated");
    });

    it("still lets the sync move an active source into a non-active status", async () => {
      // Only paused/deprecated are sticky; the provider can still take a
      // healthy row out of service.
      await seedStrategy();

      const resynced = await repo.upsertStrategy(strategyInput({ status: "paused" }));

      expect(resynced?.status).toBe("paused");
    });

    it("updates in place on (provider, provider_reference, environment) with a stable id", async () => {
      const inserted = await seedStrategy();

      const updated = await repo.upsertStrategy(
        strategyInput({
          name: "USDC Prime Vault v2",
          currentApy: "0.061",
          status: "paused",
          riskMetadata: { curator: "steakhouse", riskTier: "conservative" },
        })
      );

      expect(updated?.id).toBe(inserted.id);
      expect(updated?.name).toBe("USDC Prime Vault v2");
      expect(updated?.current_apy).toBe("0.061");
      expect(updated?.status).toBe("paused");
      expect(updated?.risk_metadata).toEqual({ curator: "steakhouse", riskTier: "conservative" });
      // DO UPDATE must not touch created_at — proof the row was not replaced.
      expect(updated?.created_at).toBe(inserted.created_at);

      const { total } = await repo.listStrategies({
        environment: "sandbox",
        includeInactive: true,
        limit: 10,
        offset: 0,
      });
      expect(total).toBe(1);
    });

    it("keys the sync on environment — one provider reference, separate sandbox/production rows", async () => {
      const sandbox = await seedStrategy();
      const production = await seedStrategy({ environment: "production" });

      expect(production.id).not.toBe(sandbox.id);
      for (const [environment, expectedId] of [
        ["sandbox", sandbox.id],
        ["production", production.id],
      ] as const) {
        const { rows, total } = await repo.listStrategies({
          environment,
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(1);
        expect(rows[0]?.id).toBe(expectedId);
      }
    });
  });

  describe("createPosition (idx_earn_positions_active_unique)", () => {
    it("rejects a second active position for the same strategy+wallet in a project", async () => {
      const strategy = await seedStrategy();
      await seedPosition({ strategyId: strategy.id });

      await expect(seedPosition({ strategyId: strategy.id })).rejects.toSatisfy((err: unknown) =>
        isPostgresUniqueViolation(err)
      );
    });

    it("allows a replacement active position once the prior one is closed", async () => {
      const strategy = await seedStrategy();
      const first = await seedPosition({ strategyId: strategy.id });
      await getDb(env)
        .prepare("UPDATE earn_positions SET status = 'closed' WHERE id = ?")
        .bind(first.id)
        .run();

      const replacement = await seedPosition({ strategyId: strategy.id });
      expect(replacement.id).not.toBe(first.id);
      expect(replacement.status).toBe("active");

      const listInput = {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        limit: 10,
        offset: 0,
      };
      // The closed row coexists but only surfaces with includeClosed.
      const activeOnly = await repo.listPositions(listInput);
      expect(activeOnly.total).toBe(1);
      expect(activeOnly.rows[0]?.id).toBe(replacement.id);
      const withClosed = await repo.listPositions({ ...listInput, includeClosed: true });
      expect(withClosed.total).toBe(2);
    });

    it("scopes active-uniqueness to the project", async () => {
      const strategy = await seedStrategy();
      await seedPosition({ strategyId: strategy.id });

      const sibling = await seedPosition({ strategyId: strategy.id, projectId: OTHER_PROJECT_ID });
      expect(sibling.project_id).toBe(OTHER_PROJECT_ID);
    });
  });

  describe("listStrategies pagination", () => {
    it("windows by limit/offset with a stable total and the id tiebreaker", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push((await seedStrategy({ providerReference: `vault-${i}` })).id);
      }
      await freezeCreatedAt("earn_strategies", ids);
      const expected = [...ids].sort().reverse();

      const seen: string[] = [];
      for (let offset = 0; offset < expected.length; offset += 2) {
        const { rows, total } = await repo.listStrategies({
          environment: "sandbox",
          limit: 2,
          offset,
        });
        expect(total).toBe(expected.length);
        seen.push(...rows.map((row) => row.id));
      }
      // Windows tile the id-DESC order exactly: no duplicates, no gaps.
      expect(seen).toEqual(expected);
    });

    it("excludes non-active strategies from rows and total unless includeInactive", async () => {
      const active = await seedStrategy({ providerReference: "vault-active" });
      await seedStrategy({ providerReference: "vault-paused", status: "paused" });

      const defaults = await repo.listStrategies({ environment: "sandbox", limit: 10, offset: 0 });
      expect(defaults.total).toBe(1);
      expect(defaults.rows.map((row) => row.id)).toEqual([active.id]);

      const all = await repo.listStrategies({
        environment: "sandbox",
        includeInactive: true,
        limit: 10,
        offset: 0,
      });
      expect(all.total).toBe(2);
    });
  });

  describe("listMovements pagination", () => {
    it("windows by limit/offset with a stable total and the id tiebreaker", async () => {
      const strategy = await seedStrategy();
      const position = await seedPosition({ strategyId: strategy.id });
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push((await seedMovement(position)).id);
      }
      await freezeCreatedAt("earn_movements", ids);
      const expected = [...ids].sort().reverse();

      // A sibling-project movement must never leak into the window or total.
      const foreignPosition = await seedPosition({
        strategyId: strategy.id,
        projectId: OTHER_PROJECT_ID,
      });
      await seedMovement(foreignPosition);

      const seen: string[] = [];
      for (let offset = 0; offset < expected.length; offset += 2) {
        const { rows, total } = await repo.listMovements({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          limit: 2,
          offset,
        });
        expect(total).toBe(expected.length);
        seen.push(...rows.map((row) => row.id));
      }
      expect(seen).toEqual(expected);
    });

    it("filters by direction with a matching total", async () => {
      const strategy = await seedStrategy();
      const position = await seedPosition({ strategyId: strategy.id });
      await seedMovement(position);
      const withdrawal = await seedMovement(position, { direction: "withdrawal" });

      const { rows, total } = await repo.listMovements({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        direction: "withdrawal",
        limit: 10,
        offset: 0,
      });
      expect(total).toBe(1);
      expect(rows.map((row) => row.id)).toEqual([withdrawal.id]);
    });
  });

  describe("provider wallets (earn_provider_wallets)", () => {
    const GROUND_WALLET_REF = "1b6d5a1e-8f4c-4c1a-9e2b-3d7f6a8c9e01";
    const OTHER_ORG = {
      id: "org_earn_repo_other",
      name: "Sibling Org",
      slug: "org-earn-repo-other",
    };
    const OTHER_ORG_PROJECT_ID = "prj_earn_repo_other_org";

    async function seedProviderWallet(
      overrides: Partial<InsertEarnProviderWalletInput> = {}
    ): Promise<EarnProviderWalletRow> {
      const row = await repo.insertProviderWallet({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        environment: "sandbox",
        provider: "ground",
        providerWalletRef: GROUND_WALLET_REF,
        label: null,
        createdBy: TEST_USER.id,
        ...overrides,
      });
      if (!row) {
        throw new Error("failed to seed provider wallet");
      }
      return row;
    }

    async function seedSiblingOrg(): Promise<void> {
      const db = getDb(env);
      await db
        .prepare(
          "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
        )
        .bind(OTHER_ORG.id, OTHER_ORG.name, OTHER_ORG.slug)
        .run();
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Sibling Org Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(OTHER_ORG_PROJECT_ID, OTHER_ORG.id, OTHER_ORG_PROJECT_ID, TEST_USER.id)
        .run();
    }

    it("round-trips the shared wallet link through getProviderWallet", async () => {
      const inserted = await seedProviderWallet({ label: "Shared Ground portfolio" });
      expect(inserted.id).toMatch(/^earn_provider_wallet_/);

      const fetched = await repo.getProviderWallet({
        organizationId: TEST_ORG.id,
        environment: "sandbox",
        provider: "ground",
      });

      expect(fetched).toEqual(inserted);
      expect(fetched?.provider_wallet_ref).toBe(GROUND_WALLET_REF);
      expect(fetched?.label).toBe("Shared Ground portfolio");
      expect(fetched?.project_id).toBe(TEST_PROJECT_ID);
      expect(fetched?.created_by).toBe(TEST_USER.id);
    });

    it("returns null when the org has no wallet for that provider+environment", async () => {
      await seedProviderWallet();

      await expect(
        repo.getProviderWallet({
          organizationId: TEST_ORG.id,
          environment: "production",
          provider: "ground",
        })
      ).resolves.toBeNull();
      await expect(
        repo.getProviderWallet({
          organizationId: TEST_ORG.id,
          environment: "sandbox",
          provider: "veda",
        })
      ).resolves.toBeNull();
    });

    it("enforces ONE shared wallet per org+environment+provider", async () => {
      await seedProviderWallet();

      // Rejected even from a different project with a different provider-side
      // ref: the wallet is org-scoped, project_id is provisioning context only.
      await expect(
        seedProviderWallet({
          projectId: OTHER_PROJECT_ID,
          providerWalletRef: "2c7e6b2f-9a5d-4d2b-8f3c-4e8a7b9d0f12",
        })
      ).rejects.toSatisfy((err: unknown) => isPostgresUniqueViolation(err));

      // The sibling environment and sibling providers stay open.
      await expect(seedProviderWallet({ environment: "production" })).resolves.toMatchObject({
        environment: "production",
      });
      await expect(seedProviderWallet({ provider: "veda" })).resolves.toMatchObject({
        provider: "veda",
      });
    });

    it("scopes lookups to the organization", async () => {
      await seedSiblingOrg();
      const ours = await seedProviderWallet();
      const theirs = await seedProviderWallet({
        organizationId: OTHER_ORG.id,
        projectId: OTHER_ORG_PROJECT_ID,
        providerWalletRef: "3d8f7c30-ab6e-4e3c-9a4d-5f9b8c0e1a23",
      });
      expect(theirs.id).not.toBe(ours.id);

      for (const [organizationId, expected] of [
        [TEST_ORG.id, ours],
        [OTHER_ORG.id, theirs],
      ] as const) {
        const fetched = await repo.getProviderWallet({
          organizationId,
          environment: "sandbox",
          provider: "ground",
        });
        expect(fetched?.id).toBe(expected.id);
        expect(fetched?.provider_wallet_ref).toBe(expected.provider_wallet_ref);
      }
    });
  });

  describe("NAV snapshots", () => {
    it("reads history newest-first by as_of with a limit (handler read path)", async () => {
      const strategy = await seedStrategy();
      const other = await seedStrategy({ providerReference: "vault-other" });
      // Inserted out of chronological order: ordering must come from as_of.
      for (const [sharePrice, asOf] of [
        ["1.01", "2026-01-02T00:00:00.000Z"],
        ["1.02", "2026-01-03T00:00:00.000Z"],
        ["1.00", "2026-01-01T00:00:00.000Z"],
      ] as const) {
        await repo.insertNavSnapshot({
          strategyId: strategy.id,
          sharePrice,
          apy: "0.05",
          tvl: "1000000",
          asOf,
        });
      }
      await repo.insertNavSnapshot({
        strategyId: other.id,
        sharePrice: "9.99",
        apy: null,
        tvl: null,
        asOf: "2026-01-04T00:00:00.000Z",
      });

      const history = await repo.listNavSnapshots({ strategyId: strategy.id, limit: 2 });

      expect(history.map((snapshot) => snapshot.as_of)).toEqual([
        "2026-01-03T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
      ]);
      expect(history[0]?.id).toMatch(/^earn_nav_/);
      expect(history[0]?.share_price).toBe("1.02");
      expect(history.every((snapshot) => snapshot.strategy_id === strategy.id)).toBe(true);
    });

    it("upserts in place on (strategy_id, as_of) with a stable id", async () => {
      const strategy = await seedStrategy();
      const asOf = "2026-01-01T00:00:00.000Z";
      const first = await repo.insertNavSnapshot({
        strategyId: strategy.id,
        sharePrice: "1.00",
        apy: "0.04",
        tvl: "900000",
        asOf,
      });

      const second = await repo.insertNavSnapshot({
        strategyId: strategy.id,
        sharePrice: "1.05",
        apy: "0.06",
        tvl: "950000",
        asOf,
      });

      expect(second?.id).toBe(first?.id);
      expect(second).toMatchObject({ share_price: "1.05", apy: "0.06", tvl: "950000" });
      await expect(
        repo.listNavSnapshots({ strategyId: strategy.id, limit: 10 })
      ).resolves.toHaveLength(1);
    });
  });
});
