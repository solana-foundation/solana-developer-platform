import type { EarnPortfolioWithdrawal } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  applyEarnWithdrawalObservationByReference,
  applyEarnWithdrawalObservationToRow,
} from "@/services/earn-withdrawal-ledger.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProviderWalletInput,
  ListEarnProviderWalletsInput,
  ListEarnProviderWalletsResult,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import { createPostgresEarnRepository } from "./earn.repository.postgres";
import {
  type CreateCustodialMovementInput,
  createPostgresEarnMovementsRepository,
  type EarnMovementRow,
  type EarnMovementsRepository,
} from "./earn-movements.repository";

const TEST_PROJECT_ID = "prj_earn_repo_test";
const OTHER_PROJECT_ID = "prj_earn_repo_test_other";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESTINATION = "4Nd1mYzL3T2fLGV1kZQcQq5o5FQMYuu1v6oCTKW6PYt5";
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
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    // The ledger references both the withdrawal's holding and the program
    // wallet, so it is cleared first.
    await db.prepare("DELETE FROM earn_button_configurations").run();
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
      hostCluster: "devnet",
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

  type OrderedTable = "earn_strategies" | "earn_movements" | "earn_provider_wallets";

  async function setCreatedAt(table: OrderedTable, id: string, createdAt: string): Promise<void> {
    await getDb(env)
      .prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`)
      .bind(createdAt, id)
      .run();
  }

  async function freezeCreatedAt(table: OrderedTable, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await setCreatedAt(table, id, SHARED_CREATED_AT);
    }
  }

  describe("button configurations", () => {
    it("persists one stable public handoff per organization and project", async () => {
      const firstStrategy = await seedStrategy();
      const first = await repo.upsertButtonConfiguration({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        strategyId: firstStrategy.id,
        style: "ink",
        accentColor: "#14F195",
        actorId: TEST_USER.id,
      });

      expect(first.id).toMatch(/^earn_button_config_/);
      expect(first.public_token).toMatch(/^[A-Za-z0-9_-]{24}$/);
      await expect(
        repo.getButtonConfiguration({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
        })
      ).resolves.toEqual(first);
      await expect(repo.getButtonConfigurationByPublicToken(first.public_token)).resolves.toEqual(
        first
      );

      const nextStrategy = await seedStrategy({ providerReference: "vault-usdc-next" });
      const updated = await repo.upsertButtonConfiguration({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        strategyId: nextStrategy.id,
        style: "accent",
        accentColor: "#9945FF",
        actorId: "usr_should_not_replace_creator",
      });

      expect(updated).toMatchObject({
        id: first.id,
        public_token: first.public_token,
        strategy_id: nextStrategy.id,
        style: "accent",
        accent_color: "#9945FF",
        created_by: TEST_USER.id,
      });
    });

    it("does not resolve a configuration through a sibling project scope", async () => {
      const strategy = await seedStrategy();
      await repo.upsertButtonConfiguration({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        strategyId: strategy.id,
        style: "light",
        accentColor: "#14F195",
        actorId: TEST_USER.id,
      });

      await expect(
        repo.getButtonConfiguration({
          organizationId: TEST_ORG.id,
          projectId: OTHER_PROJECT_ID,
        })
      ).resolves.toBeNull();
    });

    it("removes the project handoff when the owning project is deleted", async () => {
      const strategy = await seedStrategy();
      const configuration = await repo.upsertButtonConfiguration({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        strategyId: strategy.id,
        style: "ink",
        accentColor: "#14F195",
        actorId: TEST_USER.id,
      });

      await getDb(env).prepare("DELETE FROM projects WHERE id = ?").bind(TEST_PROJECT_ID).run();

      await expect(
        repo.getButtonConfigurationByPublicToken(configuration.public_token)
      ).resolves.toBeNull();
    });
  });

  /**
   * The five-minute metrics refresh writes through here. Its whole safety
   * argument is that it can only rewrite FIGURES on rows the hourly catalogue
   * sync already admitted — these cases are that argument.
   */
  describe("updateStrategyMetrics", () => {
    const metricsInput = (overrides: Record<string, unknown> = {}) => ({
      provider: "veda" as const,
      providerReference: "vault-usdc-prime",
      environment: "sandbox" as const,
      currentApy: "0.0731",
      riskMetadata: { tvlUsd: 4_200_000 },
      ...overrides,
    });

    it("refreshes the rate and merges volatile metadata over the stored object", async () => {
      const seeded = await seedStrategy();

      const applied = await repo.updateStrategyMetrics(metricsInput());

      expect(applied).toBe(true);
      const row = await repo.getStrategyById(seeded.id);
      expect(row?.current_apy).toBe("0.0731");
      // curator came from the catalogue sync and is NOT in the refresh payload;
      // a replacing write would drop it and the dashboard would lose the label.
      expect(row?.risk_metadata).toEqual({ curator: "gauntlet", tvlUsd: 4_200_000 });
    });

    it("never inserts — an unknown reference is a silent no-op", async () => {
      // This is what lets the refresh hand over a provider's whole shelf
      // without first working out which of it we catalogue. If it could
      // insert, it would be a second way into the catalogue that skips every
      // admission gate in the provider clients.
      const applied = await repo.updateStrategyMetrics(
        metricsInput({ providerReference: "a-vault-we-never-catalogued" })
      );

      expect(applied).toBe(false);
      const { total } = await repo.listStrategies({
        environment: "sandbox",
        includeInactive: true,
        limit: 10,
        offset: 0,
      });
      expect(total).toBe(0);
    });

    it("does not cross environments or providers", async () => {
      const seeded = await seedStrategy();

      expect(await repo.updateStrategyMetrics(metricsInput({ environment: "production" }))).toBe(
        false
      );
      expect(await repo.updateStrategyMetrics(metricsInput({ provider: "ground" }))).toBe(false);

      expect((await repo.getStrategyById(seeded.id))?.current_apy).toBe("0.052");
    });

    it("clears a rate the provider has stopped reporting", async () => {
      const seeded = await seedStrategy();

      await repo.updateStrategyMetrics(metricsInput({ currentApy: null }));

      // Null, not the last-known figure: a rate with no source behind it is
      // worse than no rate — the UI renders "—" for null.
      expect((await repo.getStrategyById(seeded.id))?.current_apy).toBeNull();
    });

    it("leaves identity alone — name, mints and liquidity term are the sync's", async () => {
      const seeded = await seedStrategy();

      await repo.updateStrategyMetrics(metricsInput());

      const row = await repo.getStrategyById(seeded.id);
      expect(row?.name).toBe(seeded.name);
      expect(row?.deposit_mints).toEqual(seeded.deposit_mints);
      expect(row?.liquidity_term).toBe(seeded.liquidity_term);
      expect(row?.host_cluster).toBe(seeded.host_cluster);
      expect(row?.source_kind).toBe(seeded.source_kind);
    });

    it("refreshes an operator-paused row's figures without reviving it", async () => {
      // A pause stops deposits; it does not freeze the vault's real-world
      // numbers. An operator deciding whether to unpause wants current figures,
      // not the ones from the moment they hit stop.
      const seeded = await seedStrategy();
      await repo.upsertStrategy(strategyInput({ status: "paused" }));

      const applied = await repo.updateStrategyMetrics(metricsInput());

      expect(applied).toBe(true);
      const row = await repo.getStrategyById(seeded.id);
      expect(row?.status).toBe("paused");
      expect(row?.current_apy).toBe("0.0731");
    });
  });

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

    /**
     * The expand half of migration 0057 leaves `host_cluster` NULLABLE, because
     * the deploy applies migrations BEFORE it rolls the service and the cron
     * image — and a rollback restores the old image over the new schema. So a
     * writer that predates the column can and will write a NULL row here.
     *
     * Both halves of that contract are pinned: the write must be ACCEPTED (a
     * NOT NULL would fail every upsert in that window, stalling the catalogue
     * refresh), and the read must resolve the row to the environment's own
     * cluster so it stays fundable instead of silently leaving the wizard.
     */
    it("admits a row from a writer that predates host_cluster, and reads it as this environment's cluster", async () => {
      const db = getDb(env);
      const legacyId = "earn_strategy_pre_host_cluster";
      for (const [id, environment, expected] of [
        [legacyId, "sandbox", "devnet"],
        [`${legacyId}_prod`, "production", "mainnet-beta"],
      ] as const) {
        await db
          .prepare(
            `INSERT INTO earn_strategies
               (id, provider, provider_reference, name, source_kind, deposit_mints,
                apy_type, current_apy, liquidity_term, risk_metadata, status, environment)
             VALUES (?, 'ground', ?, 'Legacy Ground Vault', 'defi', ?::jsonb,
                     'variable', '0.041', 'instant', '{}'::jsonb, 'active', ?)`
          )
          .bind(id, `${id}-ref`, JSON.stringify([USDC_MINT]), environment)
          .run();

        const row = await repo.getStrategyById(id);
        expect(row?.host_cluster).toBe(expected);
      }
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

  describe("deleteUnlistedStrategies", () => {
    it("deletes only active rows the provider no longer lists, scoped to (provider, environment)", async () => {
      const kept = await seedStrategy({
        provider: "ground",
        providerReference: "kamino-allez-usdc",
      });
      const stale = await seedStrategy({
        provider: "ground",
        providerReference: "morpho-gauntlet-usdc",
      });
      const otherEnvironment = await seedStrategy({
        providerReference: "morpho-gauntlet-usdc",
        environment: "production",
      });

      const deleted = await repo.deleteUnlistedStrategies({
        provider: "ground",
        environment: "sandbox",
        listedProviderReferences: ["kamino-allez-usdc"],
      });

      expect(deleted).toEqual(["morpho-gauntlet-usdc"]);
      expect((await repo.getStrategyById(kept.id))?.status).toBe("active");
      expect(await repo.getStrategyById(stale.id)).toBeNull();
      // Environment scope is load-bearing: a sandbox pass must never touch
      // production rows carrying the same provider reference.
      expect((await repo.getStrategyById(otherEnvironment.id))?.status).toBe("active");
    });

    it("is idempotent and leaves operator-paused rows alone", async () => {
      const paused = await seedStrategy({
        providerReference: "morpho-smokehouse-usdc",
        status: "paused",
      });
      await seedStrategy({ provider: "ground", providerReference: "aave-v3-usdc" });

      const first = await repo.deleteUnlistedStrategies({
        provider: "ground",
        environment: "sandbox",
        listedProviderReferences: ["kamino-allez-usdc"],
      });
      expect(first).toEqual(["aave-v3-usdc"]);
      // An operator pause outranks the catalogue, exactly as in upsertStrategy.
      expect((await repo.getStrategyById(paused.id))?.status).toBe("paused");

      const second = await repo.deleteUnlistedStrategies({
        provider: "ground",
        environment: "sandbox",
        listedProviderReferences: ["kamino-allez-usdc"],
      });
      expect(second).toEqual([]);
    });

    it("refuses an empty keep set rather than deleting the whole shelf", async () => {
      // "The provider listed nothing" is indistinguishable from a misconfigured
      // account, so it can never tear down a catalogue.
      const row = await seedStrategy({
        provider: "ground",
        providerReference: "kamino-allez-usdc",
      });

      const deleted = await repo.deleteUnlistedStrategies({
        provider: "ground",
        environment: "sandbox",
        listedProviderReferences: [],
      });

      expect(deleted).toEqual([]);
      expect((await repo.getStrategyById(row.id))?.status).toBe("active");
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

  /**
   * The per-vault curation knobs behind the API's HIDDEN_VAULTS / CURATED_VAULTS
   * config. Both filter in SQL, so `total` has to move with the rows — a
   * curated page that still counted the hidden vaults would paginate a reader
   * into empty windows.
   */
  describe("listStrategies per-vault curation", () => {
    it("drops a denied vault from rows AND total, keyed on provider:reference", async () => {
      const kept = await seedStrategy({ providerReference: "vault-kept" });
      await seedStrategy({ providerReference: "vault-denied" });

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        // `veda` is this suite's default seed provider — deliberately not Ground,
        // so the curation is proven against the canonical contract, not one
        // provider's quirks.
        excludeProviderKeys: ["veda:vault-denied"],
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows.map((row) => row.id)).toEqual([kept.id]);
    });

    it("scopes the denylist to its provider, so a shared reference is not collateral", async () => {
      // Same reference under two providers: only the keyed one may disappear.
      const ground = await seedStrategy({ provider: "ground", providerReference: "shared-ref" });
      const kamino = await seedStrategy({ provider: "kamino", providerReference: "shared-ref" });

      const { rows } = await repo.listStrategies({
        environment: "sandbox",
        excludeProviderKeys: ["ground:shared-ref"],
        limit: 10,
        offset: 0,
      });

      expect(rows.map((row) => row.id)).toEqual([kamino.id]);
      expect(rows.map((row) => row.id)).not.toContain(ground.id);
    });

    it("shows only the allowlisted references for a curated provider", async () => {
      const picked = await seedStrategy({ provider: "kamino", providerReference: "kv-picked" });
      await seedStrategy({ provider: "kamino", providerReference: "kv-other" });
      // An uncurated provider passes through untouched.
      const ground = await seedStrategy({ provider: "ground", providerReference: "ground-vault" });

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        allowedProviderReferences: { kamino: ["kv-picked"] },
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(2);
      expect(rows.map((row) => row.id).sort()).toEqual([ground.id, picked.id].sort());
    });

    it("reads an EMPTY allowlist literally — that provider shows nothing", async () => {
      await seedStrategy({ provider: "kamino", providerReference: "kv-any" });
      const ground = await seedStrategy({ provider: "ground", providerReference: "ground-vault" });

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        allowedProviderReferences: { kamino: [] },
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows.map((row) => row.id)).toEqual([ground.id]);
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
        // A FRESH ref per call by default. (provider, provider_wallet_ref) is
        // globally unique since migration 0056, so a shared default would make
        // every test that seeds a second program fail on the unique instead of
        // on its own assertion. Tests that care about the ref pass one.
        providerWalletRef: crypto.randomUUID(),
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

    function listPrograms(
      overrides: Partial<ListEarnProviderWalletsInput> = {}
    ): Promise<ListEarnProviderWalletsResult> {
      return repo.listProviderWallets({
        organizationId: TEST_ORG.id,
        environment: "sandbox",
        limit: 20,
        offset: 0,
        ...overrides,
      });
    }

    describe("getProviderWalletById", () => {
      it("round-trips a program by its own id, scoped to (organization, environment)", async () => {
        const inserted = await seedProviderWallet({
          providerWalletRef: GROUND_WALLET_REF,
          label: "Shared Ground portfolio",
        });
        expect(inserted.id).toMatch(/^earn_provider_wallet_/);

        const fetched = await repo.getProviderWalletById({
          organizationId: TEST_ORG.id,
          environment: "sandbox",
          walletId: inserted.id,
        });

        expect(fetched).toEqual(inserted);
        expect(fetched?.provider_wallet_ref).toBe(GROUND_WALLET_REF);
        expect(fetched?.label).toBe("Shared Ground portfolio");
        expect(fetched?.project_id).toBe(TEST_PROJECT_ID);
        expect(fetched?.created_by).toBe(TEST_USER.id);
      });

      it("misses a sibling organization's program id", async () => {
        await seedSiblingOrg();
        const ours = await seedProviderWallet();
        const theirs = await seedProviderWallet({
          organizationId: OTHER_ORG.id,
          projectId: OTHER_ORG_PROJECT_ID,
        });
        expect(theirs.id).not.toBe(ours.id);

        await expect(
          repo.getProviderWalletById({
            organizationId: TEST_ORG.id,
            environment: "sandbox",
            walletId: theirs.id,
          })
        ).resolves.toBeNull();

        // …and resolves for its owner, so the miss above is the organization
        // clause doing its job rather than an id that never existed.
        await expect(
          repo.getProviderWalletById({
            organizationId: OTHER_ORG.id,
            environment: "sandbox",
            walletId: theirs.id,
          })
        ).resolves.toMatchObject({ id: theirs.id });
      });

      it("misses the right id in the WRONG environment", async () => {
        // A real security property, not a formality. Before PRO-1670 the lookup
        // was keyed on (organization, environment, provider), so environment
        // scoping was structural and a sandbox row could not be reached from a
        // production session by construction. Addressing a program by its own id
        // removes that guarantee, so the clause is now explicit — and a
        // production dashboard session must never resolve a sandbox program.
        const sandboxProgram = await seedProviderWallet();

        await expect(
          repo.getProviderWalletById({
            organizationId: TEST_ORG.id,
            environment: "production",
            walletId: sandboxProgram.id,
          })
        ).resolves.toBeNull();

        await expect(
          repo.getProviderWalletById({
            organizationId: TEST_ORG.id,
            environment: "sandbox",
            walletId: sandboxProgram.id,
          })
        ).resolves.toMatchObject({ id: sandboxProgram.id });
      });

      it("returns null for an unknown id", async () => {
        await seedProviderWallet();

        await expect(
          repo.getProviderWalletById({
            organizationId: TEST_ORG.id,
            environment: "sandbox",
            walletId: "earn_provider_wallet_missing",
          })
        ).resolves.toBeNull();
      });
    });

    describe("listProviderWallets", () => {
      it("returns every program for the (organization, environment), OLDEST first", async () => {
        // Oldest-first is a stability requirement, not a preference (migration
        // 0056's header): consumers that track "the first program" across polls
        // must not be silently re-pointed at a different wallet — and therefore
        // at a different balance — the moment another program is created.
        const first = await seedProviderWallet({ label: "first" });
        const second = await seedProviderWallet({ label: "second" });
        const third = await seedProviderWallet({ label: "third" });
        await setCreatedAt("earn_provider_wallets", first.id, "2026-01-01T00:00:00.000Z");
        await setCreatedAt("earn_provider_wallets", second.id, "2026-02-01T00:00:00.000Z");
        await setCreatedAt("earn_provider_wallets", third.id, "2026-03-01T00:00:00.000Z");

        const { rows, total } = await listPrograms();

        expect(total).toBe(3);
        expect(rows.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
      });

      it("breaks a created_at tie by id ASC so windows tile the collection exactly", async () => {
        // Programs created in one burst share sdp_iso_now() exactly as bulk
        // catalogue rows do, so created_at alone leaves the order (and therefore
        // the head of the list) undefined. Five programs for ONE
        // org+environment+provider is itself only legal since PRO-1670.
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          ids.push((await seedProviderWallet()).id);
        }
        await freezeCreatedAt("earn_provider_wallets", ids);
        // ASC — the mirror of the DESC history lists above.
        const expected = [...ids].sort();

        const seen: string[] = [];
        for (let offset = 0; offset < expected.length; offset += 2) {
          const { rows, total } = await listPrograms({ limit: 2, offset });
          expect(total).toBe(expected.length);
          seen.push(...rows.map((row) => row.id));
        }
        expect(seen).toEqual(expected);
      });

      it("filters by provider and excludes sibling orgs and the sibling environment", async () => {
        await seedSiblingOrg();
        const groundA = await seedProviderWallet();
        const groundB = await seedProviderWallet();
        const veda = await seedProviderWallet({ provider: "veda" });
        const production = await seedProviderWallet({ environment: "production" });
        const sibling = await seedProviderWallet({
          organizationId: OTHER_ORG.id,
          projectId: OTHER_ORG_PROJECT_ID,
        });

        // Unfiltered: every provider's programs for this (org, environment).
        const all = await listPrograms();
        expect(all.total).toBe(3);
        expect(new Set(all.rows.map((row) => row.id))).toEqual(
          new Set([groundA.id, groundB.id, veda.id])
        );
        expect(all.rows.map((row) => row.id)).not.toContain(production.id);
        expect(all.rows.map((row) => row.id)).not.toContain(sibling.id);

        // The optional filter narrows rows AND total together.
        const ground = await listPrograms({ provider: "ground" });
        expect(ground.total).toBe(2);
        expect(new Set(ground.rows.map((row) => row.id))).toEqual(
          new Set([groundA.id, groundB.id])
        );

        // The sibling environment and the sibling org each see only their own.
        await expect(listPrograms({ environment: "production" })).resolves.toMatchObject({
          total: 1,
        });
        const theirs = await listPrograms({ organizationId: OTHER_ORG.id });
        expect(theirs.rows.map((row) => row.id)).toEqual([sibling.id]);
      });

      it("answers an organization with no programs with an empty envelope", async () => {
        // A collection cannot 404 for emptiness — the handler leans on this to
        // tell "no programs" apart from "provider not configured".
        await expect(listPrograms()).resolves.toEqual({ rows: [], total: 0 });
      });
    });

    describe("getProviderWalletByRef", () => {
      it("finds the claiming row across organizations — the lookup is GLOBAL", async () => {
        await seedSiblingOrg();
        const theirs = await seedProviderWallet({
          organizationId: OTHER_ORG.id,
          projectId: OTHER_ORG_PROJECT_ID,
          providerWalletRef: GROUND_WALLET_REF,
        });

        // No organization to scope by: the create path resolves a provider
        // replay before it knows whose row the insert collided with, and asserts
        // ownership afterwards (which is what turns THIS case into a 409).
        await expect(
          repo.getProviderWalletByRef({ provider: "ground", providerWalletRef: GROUND_WALLET_REF })
        ).resolves.toMatchObject({ id: theirs.id, organization_id: OTHER_ORG.id });
      });

      it("returns null for an unknown ref and for the same ref under another provider", async () => {
        await seedProviderWallet({ providerWalletRef: GROUND_WALLET_REF });

        await expect(
          repo.getProviderWalletByRef({
            provider: "ground",
            providerWalletRef: "44f0f6a1-0000-4000-8000-000000000000",
          })
        ).resolves.toBeNull();
        // Keyed on the PAIR: provider ids namespace refs, so one provider's
        // wallet id can never resolve another provider's program.
        await expect(
          repo.getProviderWalletByRef({ provider: "veda", providerWalletRef: GROUND_WALLET_REF })
        ).resolves.toBeNull();
      });
    });

    it("allows N programs per org+environment+provider (PRO-1670)", async () => {
      // The inverse of the pre-PRO-1670 rule. 0049's UNIQUE
      // (organization_id, environment, provider) capped an org at ONE program
      // per provider; 0056 drops it, so a second program with its own
      // provider-side ref is now a legitimate second strategy.
      const first = await seedProviderWallet();
      const second = await seedProviderWallet();
      expect(second.id).not.toBe(first.id);

      // Sibling environments and providers were always open and stay open.
      await expect(seedProviderWallet({ environment: "production" })).resolves.toMatchObject({
        environment: "production",
      });
      await expect(seedProviderWallet({ provider: "veda" })).resolves.toMatchObject({
        provider: "veda",
      });
      // project_id is still provisioning context only — a program created from a
      // sibling project joins the same org+environment collection.
      await expect(seedProviderWallet({ projectId: OTHER_PROJECT_ID })).resolves.toMatchObject({
        project_id: OTHER_PROJECT_ID,
      });

      const { total } = await listPrograms();
      expect(total).toBe(4);
    });

    it("still allows ONE link row per provider wallet — globally (migration 0056)", async () => {
      // The uniqueness did not disappear, it MOVED: a provider-side wallet holds
      // real funds, so exactly one link row may claim it platform-wide. Two rows
      // pointing at one Ground wallet would each read the other's balance.
      await seedSiblingOrg();
      await seedProviderWallet({ providerWalletRef: GROUND_WALLET_REF });

      await expect(seedProviderWallet({ providerWalletRef: GROUND_WALLET_REF })).rejects.toSatisfy(
        (err: unknown) => isPostgresUniqueViolation(err)
      );

      // Across ORGANIZATIONS — the constraint is not tenant-scoped, which is the
      // whole point (provider-side identifiers never are).
      await expect(
        seedProviderWallet({
          organizationId: OTHER_ORG.id,
          projectId: OTHER_ORG_PROJECT_ID,
          providerWalletRef: GROUND_WALLET_REF,
        })
      ).rejects.toSatisfy((err: unknown) => isPostgresUniqueViolation(err));

      // …and across ENVIRONMENTS, for the same reason: the provider wallet is
      // one object, whatever SDP environment reached for it.
      await expect(
        seedProviderWallet({ environment: "production", providerWalletRef: GROUND_WALLET_REF })
      ).rejects.toSatisfy((err: unknown) => isPostgresUniqueViolation(err));

      // The pair is (provider, ref): the same string under a DIFFERENT provider
      // names a different provider's wallet and stays insertable.
      await expect(
        seedProviderWallet({ provider: "veda", providerWalletRef: GROUND_WALLET_REF })
      ).resolves.toMatchObject({ provider: "veda", provider_wallet_ref: GROUND_WALLET_REF });
    });
  });

  // The whole ledger suite runs against a NON-Ground stub provider on purpose:
  // the ledger consumes only the canonical contract, so any registered
  // provider id must exercise it identically (ADR 0002 pluggability).
  describe("custodial movement ledger (earn_movements)", () => {
    let wallet: EarnProviderWalletRow;
    // The withdrawal ledger is `earn_movements`; `repo` still owns the ACCOUNT
    // table (`earn_provider_wallets`), which the unification deliberately left
    // alone — an account is not a holding.
    let ledger: EarnMovementsRepository;

    beforeEach(async () => {
      const row = await repo.insertProviderWallet({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        environment: "sandbox",
        provider: "veda",
        providerWalletRef: "aa7d5a1e-8f4c-4c1a-9e2b-3d7f6a8c9e02",
        label: null,
        createdBy: TEST_USER.id,
      });
      if (!row) {
        throw new Error("failed to seed program wallet");
      }
      wallet = row;
      ledger = createPostgresEarnMovementsRepository(getDb(env));
    });

    function withdrawalInput(
      overrides: Partial<CreateCustodialMovementInput> = {}
    ): CreateCustodialMovementInput {
      return {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        providerWalletId: wallet.id,
        environment: "sandbox",
        provider: "veda",
        amountRequestedUsd: "125.50",
        payoutToken: "usdc",
        destinationAddress: DESTINATION,
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: '{"scope":"earn_program_withdrawal"}',
        providerData: {},
        createdBy: TEST_USER.id,
        initiatedByKeyId: null,
        ...overrides,
      };
    }

    async function seedWithdrawal(
      overrides: Partial<CreateCustodialMovementInput> = {}
    ): Promise<EarnMovementRow> {
      return ledger.createCustodialMovement(withdrawalInput(overrides));
    }

    function observed(overrides: Partial<EarnPortfolioWithdrawal> = {}): EarnPortfolioWithdrawal {
      return {
        withdrawalRef: "wd-provider-ref-1",
        status: "processing",
        amountRequestedUsd: "125.5",
        destinationAddress: DESTINATION,
        createdAt: "2026-08-11T00:00:00.000Z",
        ...overrides,
      };
    }

    async function readRow(id: string): Promise<EarnMovementRow | null> {
      const raw = await getDb(env)
        .prepare("SELECT * FROM earn_movements WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!raw) {
        return null;
      }
      // The repository has no unscoped get-by-id on purpose; a raw read keeps
      // assertions independent of the code under test.
      return raw as unknown as EarnMovementRow;
    }

    it("inserts an intent row: status 'requested', no provider reference, fingerprint stored", async () => {
      const row = await seedWithdrawal();

      // One id space for every movement now; only migrated history keeps a
      // per-family prefix, which is why nothing may parse an id for its kind.
      expect(row.id).toMatch(/^earn_movement_/);
      expect(row.status).toBe("requested");
      expect(row.provider_reference).toBeNull();
      expect(row.idempotency_fingerprint).toBe('{"scope":"earn_program_withdrawal"}');
      expect(row.amount_requested).toBe("125.50");
      expect(row.amount_settled).toBeNull();
      expect(row.provider_data).toEqual({});
      expect(row.created_by).toBe(TEST_USER.id);
    });

    it("locks one intent row per (wallet, request_id) — the SDP-side idempotency anchor", async () => {
      const requestId = crypto.randomUUID();
      await seedWithdrawal({ requestId });

      await expect(seedWithdrawal({ requestId })).rejects.toSatisfy((err: unknown) =>
        isPostgresUniqueViolation(err)
      );

      // The anchor is the WALLET, so the same derived id under another wallet
      // (impossible in practice — derivation mixes the wallet ref — but the
      // index must not over-lock) stays insertable.
      const otherWallet = await repo.insertProviderWallet({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        environment: "sandbox",
        provider: "ground",
        providerWalletRef: "bb8e6b2f-9a5d-4d2b-8f3c-4e8a7b9d0f13",
        label: null,
        createdBy: TEST_USER.id,
      });
      // A movement names its HOLDING, and the holding is 1:1 with the program
      // wallet — so the sibling program resolves through it rather than through a
      // wallet column the ledger does not carry.
      const sibling = await seedWithdrawal({
        requestId,
        providerWalletId: otherWallet?.id,
        provider: "ground",
      });
      await expect(
        ledger.getPositionById({
          organizationId: TEST_ORG.id,
          environment: "sandbox",
          positionId: sibling.position_id,
        })
      ).resolves.toMatchObject({ provider_wallet_id: otherWallet?.id });
    });

    it("resolves replays by (org, wallet, request_id) and misses foreign orgs", async () => {
      const requestId = crypto.randomUUID();
      const row = await seedWithdrawal({ requestId });

      await expect(
        ledger.findCustodialMovementByRequestId({
          organizationId: TEST_ORG.id,
          providerWalletId: wallet.id,
          requestId,
        })
      ).resolves.toMatchObject({ id: row.id });
      await expect(
        ledger.findCustodialMovementByRequestId({
          organizationId: "org_someone_else",
          providerWalletId: wallet.id,
          requestId,
        })
      ).resolves.toBeNull();
    });

    describe("updateProgramWithdrawalStatusGuarded", () => {
      it("transitions when the current status is in fromStatuses and stamps the provider reference", async () => {
        const row = await seedWithdrawal();

        const updated = await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "processing",
          providerReference: "wd-provider-ref-1",
          providerData: { lastObservation: { status: "processing" } },
        });

        expect(updated?.status).toBe("processing");
        expect(updated?.provider_reference).toBe("wd-provider-ref-1");
        expect(updated?.provider_data).toEqual({ lastObservation: { status: "processing" } });
      });

      it("is a no-op returning null when the status moved out of fromStatuses (the race)", async () => {
        const row = await seedWithdrawal();
        await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "completed",
          providerReference: "wd-provider-ref-1",
          settledAt: "2026-08-11T01:00:00.000Z",
        });

        const regressed = await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "processing",
        });

        expect(regressed).toBeNull();
        const current = await readRow(row.id);
        expect(current?.status).toBe("completed");
        expect(current?.settled_at).toBe("2026-08-11T01:00:00.000Z");
      });

      it("returns null for a missing row and for a foreign organization", async () => {
        const row = await seedWithdrawal();

        await expect(
          ledger.updateCustodialMovementGuarded({
            selector: { movementId: "earn_program_withdrawal_missing" },
            organizationId: TEST_ORG.id,
            toStatus: "processing",
          })
        ).resolves.toBeNull();

        await expect(
          ledger.updateCustodialMovementGuarded({
            selector: { movementId: row.id },
            organizationId: "org_someone_else",
            toStatus: "processing",
          })
        ).resolves.toBeNull();
        await expect(readRow(row.id)).resolves.toMatchObject({ status: "requested" });
      });

      it("supports the (provider, provider_reference) selector for observation paths", async () => {
        const row = await seedWithdrawal();
        await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "processing",
          providerReference: "wd-provider-ref-9",
        });

        const updated = await ledger.updateCustodialMovementGuarded({
          selector: { provider: "veda", providerReference: "wd-provider-ref-9" },
          organizationId: TEST_ORG.id,
          toStatus: "completed",
          amountSettled: "124.9",
          feeAmount: "0.6",
          settledAt: "2026-08-11T02:00:00.000Z",
        });

        expect(updated?.id).toBe(row.id);
        expect(updated?.status).toBe("completed");
        expect(updated?.amount_settled).toBe("124.9");
        expect(updated?.fee_amount).toBe("0.6");
      });

      it("self-transitions refresh fields without changing status", async () => {
        const row = await seedWithdrawal();
        await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "processing",
          providerReference: "wd-provider-ref-2",
          providerData: { first: true },
        });

        const refreshed = await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "processing",
          feeAmount: "0.55",
          providerData: { second: true },
        });

        expect(refreshed?.status).toBe("processing");
        expect(refreshed?.fee_amount).toBe("0.55");
        // JSONB shallow merge: both observations survive.
        expect(refreshed?.provider_data).toEqual({ first: true, second: true });
      });

      it("serializes concurrent terminal transitions — exactly one wins", async () => {
        const row = await seedWithdrawal();
        await ledger.updateCustodialMovementGuarded({
          selector: { movementId: row.id },
          organizationId: TEST_ORG.id,
          toStatus: "processing",
          providerReference: "wd-provider-ref-3",
        });

        const [completed, failed] = await Promise.all([
          ledger.updateCustodialMovementGuarded({
            selector: { movementId: row.id },
            organizationId: TEST_ORG.id,
            toStatus: "completed",
            amountSettled: "125.5",
            settledAt: "2026-08-11T03:00:00.000Z",
          }),
          ledger.updateCustodialMovementGuarded({
            selector: { movementId: row.id },
            organizationId: TEST_ORG.id,
            toStatus: "failed",
            failureReason: "declined",
          }),
        ]);

        // Either order can win the row lock; the loser's fromStatuses guard
        // must miss. The stored row must be internally consistent with the
        // winner, never a blend of both writes.
        expect([completed, failed].filter(Boolean)).toHaveLength(1);
        const current = await readRow(row.id);
        if (current?.status === "completed") {
          expect(current.amount_settled).toBe("125.5");
          expect(current.failure_reason).toBeNull();
        } else {
          expect(current?.status).toBe("failed");
          expect(current?.failure_reason).toBe("declined");
          expect(current?.amount_settled).toBeNull();
        }
      });
    });

    describe("ledger service appliers", () => {
      it("applyToRow advances a requested row and stamps its provider reference", async () => {
        const row = await seedWithdrawal();

        const updated = await applyEarnWithdrawalObservationToRow({
          repo: ledger,
          row,
          observed: observed({ status: "processing", feeUsd: "0.5" }),
        });

        expect(updated?.status).toBe("processing");
        expect(updated?.provider_reference).toBe("wd-provider-ref-1");
        expect(updated?.fee_amount).toBe("0.5");
        expect(updated?.provider_data).toMatchObject({
          lastObservation: { status: "processing" },
        });
      });

      it("applyToRow is a no-op on a terminal row (belt before the SQL braces)", async () => {
        const row = await seedWithdrawal();
        await applyEarnWithdrawalObservationToRow({
          repo: ledger,
          row,
          observed: observed({ status: "failed", failureReason: "declined" }),
        });
        const terminal = await readRow(row.id);

        const result = await applyEarnWithdrawalObservationToRow({
          repo: ledger,
          row: terminal as EarnMovementRow,
          observed: observed({ status: "processing" }),
        });

        expect(result?.status).toBe("failed");
        await expect(readRow(row.id)).resolves.toMatchObject({
          status: "failed",
          failure_reason: "declined",
        });
      });

      it("applyByReference persists an observation and completes the lifecycle", async () => {
        const row = await seedWithdrawal();
        await applyEarnWithdrawalObservationToRow({
          repo: ledger,
          row,
          observed: observed({ status: "pending_approval" }),
        });

        const completed = await applyEarnWithdrawalObservationByReference({
          repo: ledger,
          provider: "veda",
          organizationId: TEST_ORG.id,
          observed: observed({
            status: "completed",
            amountPaidUsd: "124.9",
            feeUsd: "0.6",
            completedAt: "2026-08-11T04:00:00.000Z",
          }),
        });

        expect(completed?.id).toBe(row.id);
        expect(completed?.status).toBe("completed");
        expect(completed?.settled_at).toBe("2026-08-11T04:00:00.000Z");

        // Terminal rows never regress, even through the reference path.
        const after = await applyEarnWithdrawalObservationByReference({
          repo: ledger,
          provider: "veda",
          organizationId: TEST_ORG.id,
          observed: observed({ status: "processing" }),
        });
        expect(after?.status).toBe("completed");
      });

      it("applyByReference no-ops cleanly on an unknown reference (pre-ledger withdrawals)", async () => {
        await expect(
          applyEarnWithdrawalObservationByReference({
            repo: ledger,
            provider: "veda",
            organizationId: TEST_ORG.id,
            observed: observed({ withdrawalRef: "wd-never-seen" }),
          })
        ).resolves.toBeNull();
      });

      it("applyByReference refuses to write across organizations", async () => {
        const row = await seedWithdrawal();
        await applyEarnWithdrawalObservationToRow({
          repo: ledger,
          row,
          observed: observed({ status: "processing" }),
        });

        const result = await applyEarnWithdrawalObservationByReference({
          repo: ledger,
          provider: "veda",
          organizationId: "org_someone_else",
          observed: observed({ status: "completed" }),
        });

        expect(result).toBeNull();
        await expect(readRow(row.id)).resolves.toMatchObject({ status: "processing" });
      });
    });

    describe("listProgramWithdrawals", () => {
      it("windows by limit/offset with a stable total, scoped to the wallet", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          ids.push((await seedWithdrawal()).id);
        }
        await freezeCreatedAt("earn_movements", ids);
        const expected = [...ids].sort().reverse();

        // A sibling PROGRAM's history must never leak into the window or total —
        // and since PRO-1670 the sibling is the hard case: same organization,
        // same environment, same provider, differing only by wallet_id. Before
        // 0056 this row could not exist, so wallet scoping was never tested
        // against anything a weaker (org, environment, provider) scope would
        // have merged.
        const siblingProgram = await repo.insertProviderWallet({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          environment: "sandbox",
          provider: "veda",
          providerWalletRef: "cc9f7c30-ab6e-4e3c-9a4d-5f9b8c0e1a24",
          label: null,
          createdBy: TEST_USER.id,
        });
        expect(siblingProgram?.id).not.toBe(wallet.id);
        await seedWithdrawal({ providerWalletId: siblingProgram?.id });

        const seen: string[] = [];
        for (let offset = 0; offset < expected.length; offset += 2) {
          const { rows, total } = await ledger.listCustodialMovements({
            organizationId: TEST_ORG.id,
            providerWalletId: wallet.id,
            limit: 2,
            offset,
          });
          expect(total).toBe(expected.length);
          seen.push(...rows.map((row) => row.id));
        }
        expect(seen).toEqual(expected);
      });
    });
  });
});
