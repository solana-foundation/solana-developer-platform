import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";

import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { type SeededDefaultProjects, seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { EarnRepository, EarnStrategyRow, UpsertEarnStrategyInput } from "./earn.repository";
import { createPostgresEarnRepository } from "./earn.repository.postgres";

const TEST_PROJECT_ID = "prj_earn_repo_test";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const _DESTINATION = "4Nd1mYzL3T2fLGV1kZQcQq5o5FQMYuu1v6oCTKW6PYt5";
// Bulk catalogue syncs land many rows on one sdp_iso_now() value, so every
// list ORDER BY carries an id tiebreaker (see 0048_earn.sql). Pinning
// created_at reproduces that case deterministically.
const SHARED_CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("EarnRepository (postgres)", () => {
  let repo: EarnRepository;
  let _projects: SeededDefaultProjects;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    // Clear movements before the holdings they reference.
    await db.prepare("DELETE FROM earn_movements").run();
    await db.prepare("DELETE FROM earn_positions").run();
    await db.prepare("DELETE FROM earn_strategies").run();
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

    _projects = await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
    });

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

  async function freezeStrategyCreatedAt(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await getDb(env)
        .prepare("UPDATE earn_strategies SET created_at = ? WHERE id = ?")
        .bind(SHARED_CREATED_AT, id)
        .run();
    }
  }

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

    it("updates a provider shelf in one batch and counts only catalogued rows", async () => {
      const first = await seedStrategy();
      const second = await seedStrategy({ providerReference: "vault-usdt-prime" });

      const updated = await repo.updateStrategyMetricsBatch([
        metricsInput(),
        metricsInput({ providerReference: "vault-usdt-prime", currentApy: "0.081" }),
        metricsInput({ providerReference: "not-catalogued" }),
      ]);

      expect(updated).toBe(2);
      expect((await repo.getStrategyById(first.id))?.current_apy).toBe("0.0731");
      expect((await repo.getStrategyById(second.id))?.current_apy).toBe("0.081");
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
      expect(await repo.updateStrategyMetrics(metricsInput({ provider: "upshift" }))).toBe(false);

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

  /**
   * The "before" the anomaly check (PRO-1867) diffs against: the whole stored
   * shelf for one (provider, environment), every status and both clusters.
   */
  describe("listStrategyFigures", () => {
    it("returns every row for the provider and environment with TVL lifted out of the metadata", async () => {
      await seedStrategy({
        providerReference: "a",
        currentApy: "0.05",
        riskMetadata: { tvlUsd: 1_500_000 },
      });
      await seedStrategy({
        providerReference: "b",
        currentApy: null,
        riskMetadata: {},
        status: "paused",
      });
      await seedStrategy({
        providerReference: "m",
        hostCluster: "mainnet-beta",
        riskMetadata: { tvlUsd: 9e7 },
      });
      // Other provider and other environment: out of scope.
      await seedStrategy({ provider: "kamino", providerReference: "a" });
      await seedStrategy({
        providerReference: "a",
        environment: "production",
        hostCluster: "mainnet-beta",
      });

      const figures = await repo.listStrategyFigures({ provider: "veda", environment: "sandbox" });

      expect(figures).toEqual([
        {
          provider_reference: "a",
          host_cluster: "devnet",
          status: "active",
          current_apy: "0.05",
          tvl_usd: 1_500_000,
        },
        {
          provider_reference: "b",
          host_cluster: "devnet",
          status: "paused",
          current_apy: null,
          tvl_usd: null,
        },
        {
          provider_reference: "m",
          host_cluster: "mainnet-beta",
          status: "active",
          current_apy: "0.052",
          tvl_usd: 90_000_000,
        },
      ]);
    });

    it("reads a non-numeric tvlUsd as no figure and a NULL host_cluster as the environment's cluster", async () => {
      const seeded = await seedStrategy({ riskMetadata: { tvlUsd: "12M" } });
      await getDb(env)
        .prepare("UPDATE earn_strategies SET host_cluster = NULL WHERE id = ?")
        .bind(seeded.id)
        .run();

      const [figure] = await repo.listStrategyFigures({ provider: "veda", environment: "sandbox" });

      expect(figure).toMatchObject({ tvl_usd: null, host_cluster: "devnet" });
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

    it("upserts a catalogue lane in one batch", async () => {
      const written = await repo.upsertStrategies([
        strategyInput({ providerReference: "vault-a" }),
        strategyInput({ providerReference: "vault-b", name: "Vault B" }),
      ]);

      expect(written).toBe(2);
      const listed = await repo.listStrategies({
        environment: "sandbox",
        includeInactive: true,
        limit: 10,
        offset: 0,
      });
      expect(listed.total).toBe(2);
      expect(new Set(listed.rows.map((row) => row.provider_reference))).toEqual(
        new Set(["vault-a", "vault-b"])
      );
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
             VALUES (?, 'upshift', ?, 'Legacy Upshift Vault', 'defi', ?::jsonb,
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

  describe("deprecateUnlistedStrategies", () => {
    it("deprecates only active rows the provider no longer lists, scoped to (provider, environment)", async () => {
      const kept = await seedStrategy({
        provider: "upshift",
        providerReference: "kamino-allez-usdc",
      });
      const stale = await seedStrategy({
        provider: "upshift",
        providerReference: "morpho-gauntlet-usdc",
      });
      const otherEnvironment = await seedStrategy({
        providerReference: "morpho-gauntlet-usdc",
        environment: "production",
      });

      const delisted = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        listedProviderReferences: ["kamino-allez-usdc"],
      });

      expect(delisted).toEqual(["morpho-gauntlet-usdc"]);
      expect((await repo.getStrategyById(kept.id))?.status).toBe("active");
      expect(await repo.getStrategyById(stale.id)).toMatchObject({
        id: stale.id,
        status: "deprecated",
        catalogue_delisted_at: expect.any(String),
      });
      // Environment scope is load-bearing: a sandbox pass must never touch
      // production rows carrying the same provider reference.
      expect((await repo.getStrategyById(otherEnvironment.id))?.status).toBe("active");
    });

    it("reactivates a sync-owned tombstone with the same stable id when the provider relists it", async () => {
      const stale = await seedStrategy({ providerReference: "relisted-vault" });
      await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        listedProviderReferences: ["another-vault"],
      });

      const relisted = await repo.upsertStrategy(
        strategyInput({ providerReference: "relisted-vault", status: "active" })
      );

      expect(relisted).toMatchObject({
        id: stale.id,
        status: "active",
        catalogue_delisted_at: null,
      });
    });

    it.each(["paused", "deprecated"] as const)(
      "keeps an operator %s applied to a tombstone sticky across a relist",
      async (status) => {
        const stale = await seedStrategy({ providerReference: `operator-${status}` });
        await repo.deprecateUnlistedStrategies({
          provider: "upshift",
          environment: "sandbox",
          listedProviderReferences: ["another-vault"],
        });

        // Operators update status directly. The trigger must distinguish this
        // from sync-owned deprecation even when deprecated -> deprecated.
        await getDb(env)
          .prepare("UPDATE earn_strategies SET status = ?, updated_at = sdp_iso_now() WHERE id = ?")
          .bind(status, stale.id)
          .run();

        expect(await repo.getStrategyById(stale.id)).toMatchObject({
          status,
          catalogue_delisted_at: null,
        });

        const relisted = await repo.upsertStrategy(
          strategyInput({ providerReference: `operator-${status}`, status: "active" })
        );
        expect(relisted).toMatchObject({
          id: stale.id,
          status,
          catalogue_delisted_at: null,
        });
      }
    );

    it("is idempotent and leaves operator-paused rows alone", async () => {
      const paused = await seedStrategy({
        providerReference: "morpho-smokehouse-usdc",
        status: "paused",
      });
      await seedStrategy({ provider: "upshift", providerReference: "aave-v3-usdc" });

      const first = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        listedProviderReferences: ["kamino-allez-usdc"],
      });
      expect(first).toEqual(["aave-v3-usdc"]);
      // An operator pause outranks the catalogue, exactly as in upsertStrategy.
      expect((await repo.getStrategyById(paused.id))?.status).toBe("paused");

      const second = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        listedProviderReferences: ["kamino-allez-usdc"],
      });
      expect(second).toEqual([]);
    });

    it("refuses an empty keep set rather than deprecating the whole shelf", async () => {
      // "The provider listed nothing" is indistinguishable from a misconfigured
      // account, so it can never deprecate a whole catalogue.
      const row = await seedStrategy({
        provider: "upshift",
        providerReference: "kamino-allez-usdc",
      });

      const delisted = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        listedProviderReferences: [],
      });

      expect(delisted).toEqual([]);
      expect((await repo.getStrategyById(row.id))?.status).toBe("active");
    });

    it("deprecates exactly one cluster sub-shelf on an AUTHORIZED empty keep set", async () => {
      // The mirror lane's convergence path (PRO-1742): when its truth source
      // reliably answers "nothing is listed", the browse-only mainnet sub-shelf
      // empties rather than serving orphaned rows forever. The devnet shelf and
      // operator-stopped rows stay untouched.
      const devnetRow = await seedStrategy({
        provider: "upshift",
        providerReference: "devnet-vault",
      });
      const mirroredMainnet = await seedStrategy({
        provider: "upshift",
        providerReference: "orphaned-mainnet-vault",
        hostCluster: "mainnet-beta",
      });
      const pausedMainnet = await seedStrategy({
        provider: "upshift",
        providerReference: "paused-mainnet-vault",
        hostCluster: "mainnet-beta",
        status: "paused",
      });

      const delisted = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: [],
        allowEmptyKeepSet: true,
      });

      expect(delisted).toEqual(["orphaned-mainnet-vault"]);
      expect(await repo.getStrategyById(mirroredMainnet.id)).toMatchObject({
        status: "deprecated",
        catalogue_delisted_at: expect.any(String),
      });
      expect((await repo.getStrategyById(devnetRow.id))?.status).toBe("active");
      expect((await repo.getStrategyById(pausedMainnet.id))?.status).toBe("paused");
    });

    it("refuses an authorized-empty delist without a cluster scope", async () => {
      // An empty keep set may deprecate one sub-shelf, never an environment.
      await expect(
        repo.deprecateUnlistedStrategies({
          provider: "upshift",
          environment: "sandbox",
          listedProviderReferences: [],
          allowEmptyKeepSet: true,
        })
      ).rejects.toThrow("allowEmptyKeepSet requires a cluster scope");
    });

    it("scopes a cluster-lane delist to its sub-shelf, counting NULL host_cluster as the environment's own", async () => {
      // The PRO-1742 shape: a sandbox environment holds its own devnet shelf
      // plus the mirrored mainnet one, each converged by its own lane.
      const devnetKept = await seedStrategy({
        provider: "upshift",
        providerReference: "devnet-kept",
      });
      const devnetStale = await seedStrategy({
        provider: "upshift",
        providerReference: "devnet-stale",
      });
      const mirroredMainnet = await seedStrategy({
        provider: "upshift",
        providerReference: "mainnet-vault",
        hostCluster: "mainnet-beta",
      });
      // A row a pre-0057 writer left unset reads as the environment's own
      // cluster (mapStrategyRow), so the devnet lane must govern it too.
      await getDb(env)
        .prepare(`UPDATE earn_strategies SET host_cluster = NULL WHERE id = ?`)
        .bind(devnetStale.id)
        .run();

      const delisted = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        hostCluster: "devnet",
        listedProviderReferences: ["devnet-kept"],
      });

      // The devnet lane deprecates its own stale row, including the NULL one,
      // and never reaches the mirrored shelf its keep set knows nothing about.
      expect(delisted).toEqual(["devnet-stale"]);
      expect(await repo.getStrategyById(devnetStale.id)).toMatchObject({
        status: "deprecated",
        catalogue_delisted_at: expect.any(String),
      });
      expect((await repo.getStrategyById(devnetKept.id))?.status).toBe("active");
      expect((await repo.getStrategyById(mirroredMainnet.id))?.status).toBe("active");

      // And the mirror lane converges its own shelf without touching devnet.
      const mirrorDelisted = await repo.deprecateUnlistedStrategies({
        provider: "upshift",
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        listedProviderReferences: ["a-mainnet-ref-still-listed"],
      });
      expect(mirrorDelisted).toEqual(["mainnet-vault"]);
      expect(await repo.getStrategyById(mirroredMainnet.id)).toMatchObject({
        status: "deprecated",
        catalogue_delisted_at: expect.any(String),
      });
      expect((await repo.getStrategyById(devnetKept.id))?.status).toBe("active");
    });
  });

  describe("core discovery filters and rate provenance", () => {
    it("intersects caller filters with visibility before pagination and counts", async () => {
      const target = await seedStrategy({ providerReference: "core-first", currentApy: "0.06" });
      await seedStrategy({ providerReference: "core-second", currentApy: "0.02" });
      await seedStrategy({ providerReference: "core-unknown", currentApy: null });
      await seedStrategy({
        provider: "kamino",
        providerReference: "core-other-provider",
        currentApy: "0.08",
      });
      const page = await repo.listStrategies({
        environment: "sandbox",
        provider: "veda",
        depositMint: USDC_MINT,
        minApy: "0.04",
        maxApy: "0.07",
        providers: ["veda"],
        limit: 1,
        offset: 0,
      });
      expect(page.total).toBe(1);
      expect(page.rows.map((row) => row.id)).toEqual([target.id]);
      expect(
        (
          await repo.listStrategies({
            environment: "sandbox",
            id: target.id,
            providers: [],
            limit: 10,
            offset: 0,
          })
        ).total
      ).toBe(0);
      expect(
        (
          await repo.listStrategies({
            environment: "sandbox",
            depositMint: "absent-mint",
            limit: 10,
            offset: 0,
          })
        ).total
      ).toBe(0);
    });

    it("does not invent a rate observation on metadata updates", async () => {
      const observedAt = "2026-11-18T10:00:00.000Z";
      const first = await seedStrategy({ rateObservedAt: observedAt });
      const metadataUpdate = await repo.upsertStrategy(strategyInput({ name: "New label" }));
      expect(metadataUpdate?.id).toBe(first.id);
      expect(metadataUpdate?.rate_observed_at).toBe(observedAt);
      await repo.updateStrategyMetrics({
        provider: "veda",
        providerReference: "vault-usdc-prime",
        environment: "sandbox",
        currentApy: "0.052",
        riskMetadata: { tvlUsd: 100 },
      });
      expect((await repo.getStrategyById(first.id))?.rate_observed_at).toBe(observedAt);
      await repo.updateStrategyMetrics({
        provider: "veda",
        providerReference: "vault-usdc-prime",
        environment: "sandbox",
        currentApy: "0.08",
        riskMetadata: {},
      });
      expect((await repo.getStrategyById(first.id))?.rate_observed_at).toBeNull();
      await repo.updateStrategyMetrics({
        provider: "veda",
        providerReference: "vault-usdc-prime",
        environment: "sandbox",
        currentApy: "0.08",
        rateObservedAt: observedAt,
        riskMetadata: {},
      });
      await getDb(env)
        .prepare("UPDATE earn_strategies SET current_apy = ? WHERE id = ?")
        .bind("0.09", first.id)
        .run();
      expect((await repo.getStrategyById(first.id))?.rate_observed_at).toBeNull();
    });

    it("keeps batch rate observations separate from null and malformed rates", async () => {
      const observedAt = "2026-11-18T10:01:00.000Z";
      await repo.upsertStrategies([
        strategyInput({ providerReference: "core-batch", rateObservedAt: observedAt }),
      ]);
      const first = await repo.getStrategyByReference({
        provider: "veda",
        providerReference: "core-batch",
        environment: "sandbox",
      });
      expect(first?.rate_observed_at).toBe(observedAt);
      await repo.updateStrategyMetricsBatch([
        {
          provider: "veda",
          providerReference: "core-batch",
          environment: "sandbox",
          currentApy: null,
          rateObservedAt: observedAt,
          riskMetadata: {},
        },
      ]);
      if (!first) throw new Error("missing strategy");
      expect((await repo.getStrategyById(first.id))?.rate_observed_at).toBeNull();
      await getDb(env)
        .prepare("UPDATE earn_strategies SET current_apy = ? WHERE id = ?")
        .bind("not-a-rate", first.id)
        .run();
      const page = await repo.listStrategies({
        environment: "sandbox",
        minApy: "0",
        limit: 10,
        offset: 0,
      });
      expect(page.total).toBe(0);
    });
  });

  describe("listStrategies pagination", () => {
    it("windows by limit/offset with a stable total and the id tiebreaker", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push((await seedStrategy({ providerReference: `vault-${i}` })).id);
      }
      await freezeStrategyCreatedAt(ids);
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
   * The PRD ranks the shelf by deposit size (PRO-1732): TVL descending, read
   * out of the riskMetadata JSON, with no-TVL rows last — never first, and
   * never fabricated as zero. The order must also be TOTAL, or OFFSET paging
   * repeats and skips rows across equal-TVL and no-TVL runs.
   */
  describe("listStrategies deposit-size ranking", () => {
    it("orders TVL descending with no-TVL rows last", async () => {
      const mid = await seedStrategy({
        providerReference: "vault-mid",
        riskMetadata: { tvlUsd: 40_000_000 },
      });
      const unsized = await seedStrategy({
        providerReference: "vault-unsized",
        riskMetadata: {},
      });
      const big = await seedStrategy({
        providerReference: "vault-big",
        riskMetadata: { tvlUsd: 251_000_000 },
      });
      const small = await seedStrategy({
        providerReference: "vault-small",
        riskMetadata: { tvlUsd: 3_000_000 },
      });
      await freezeStrategyCreatedAt([mid.id, unsized.id, big.id, small.id]);

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        limit: 10,
        offset: 0,
      });
      expect(total).toBe(4);
      expect(rows.map((row) => row.id)).toEqual([big.id, mid.id, small.id, unsized.id]);
    });

    /**
     * `risk_metadata` is an open bag and the schema only CHECKs that the whole
     * value is an object, so "tvlUsd is a JSON number or absent" is a provider
     * convention rather than a constraint. A bare `::numeric` cast would turn
     * one bad row into a 500 on every read for that environment; the ordering's
     * `jsonb_typeof` guard demotes it to unsized instead.
     */
    it("treats a non-numeric tvlUsd as unsized rather than failing the whole read", async () => {
      const sized = await seedStrategy({
        providerReference: "vault-sized",
        riskMetadata: { tvlUsd: 5_000_000 },
      });
      const malformed = await seedStrategy({
        providerReference: "vault-malformed",
        riskMetadata: { tvlUsd: "12M" },
      });
      const bool = await seedStrategy({
        providerReference: "vault-bool",
        riskMetadata: { tvlUsd: true },
      });
      await freezeStrategyCreatedAt([sized.id, malformed.id, bool.id]);

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(3);
      // The sized row still leads; the two unparseable ones sort last among
      // themselves by the id tiebreaker.
      expect(rows[0]?.id).toBe(sized.id);
      expect(
        rows
          .slice(1)
          .map((row) => row.id)
          .sort()
      ).toEqual([bool.id, malformed.id].sort());
    });

    it("pages the ordered set exactly once across equal-TVL and no-TVL runs", async () => {
      // Three rows tied at one TVL, one above, and two with none — every shape
      // the tiebreaker has to keep total. created_at is frozen shared, so only
      // the id tiebreaker separates the ties.
      const tied: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        tied.push(
          (
            await seedStrategy({
              providerReference: `vault-tied-${i}`,
              riskMetadata: { tvlUsd: 10_000_000 },
            })
          ).id
        );
      }
      const top = await seedStrategy({
        providerReference: "vault-top",
        riskMetadata: { tvlUsd: 90_000_000 },
      });
      const unsized: string[] = [];
      for (let i = 0; i < 2; i += 1) {
        unsized.push(
          (await seedStrategy({ providerReference: `vault-none-${i}`, riskMetadata: {} })).id
        );
      }
      const all = [...tied, top.id, ...unsized];
      await freezeStrategyCreatedAt(all);

      const expected = [top.id, ...[...tied].sort().reverse(), ...[...unsized].sort().reverse()];

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
      // Windows tile the TVL-DESC order exactly: no duplicates, no gaps.
      expect(seen).toEqual(expected);
    });
  });

  /**
   * The PRO-1742 read scope: a non-production environment stores two cluster
   * sub-shelves, and the strategies route lists exactly one per request —
   * the environment's own by default, the mirrored one on explicit opt-in.
   */
  describe("listStrategies cluster scope", () => {
    it("restricts to one cluster's sub-shelf, and total moves with the rows", async () => {
      const devnet = await seedStrategy({ providerReference: "devnet-vault" });
      const mainnet = await seedStrategy({
        providerReference: "mainnet-vault",
        hostCluster: "mainnet-beta",
      });

      const devnetView = await repo.listStrategies({
        environment: "sandbox",
        hostCluster: "devnet",
        limit: 10,
        offset: 0,
      });
      expect(devnetView.total).toBe(1);
      expect(devnetView.rows.map((row) => row.id)).toEqual([devnet.id]);

      const mainnetView = await repo.listStrategies({
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        limit: 10,
        offset: 0,
      });
      expect(mainnetView.total).toBe(1);
      expect(mainnetView.rows.map((row) => row.id)).toEqual([mainnet.id]);

      // Omitted, the filter is off — the program-create keep set reads the
      // whole environment and applies fundability itself.
      const unfiltered = await repo.listStrategies({
        environment: "sandbox",
        limit: 10,
        offset: 0,
      });
      expect(unfiltered.total).toBe(2);
    });

    it("counts a NULL host_cluster row as the environment's own cluster, matching the read rule", async () => {
      const legacy = await seedStrategy({ providerReference: "legacy-vault" });
      await getDb(env)
        .prepare(`UPDATE earn_strategies SET host_cluster = NULL WHERE id = ?`)
        .bind(legacy.id)
        .run();

      const devnetView = await repo.listStrategies({
        environment: "sandbox",
        hostCluster: "devnet",
        limit: 10,
        offset: 0,
      });
      expect(devnetView.rows.map((row) => row.id)).toEqual([legacy.id]);

      const mainnetView = await repo.listStrategies({
        environment: "sandbox",
        hostCluster: "mainnet-beta",
        limit: 10,
        offset: 0,
      });
      expect(mainnetView.total).toBe(0);
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
        // `veda` is this suite's default seed provider — deliberately not the
        // provider under test, so the curation is proven against the canonical
        // contract, not one provider's quirks.
        excludeProviderKeys: ["veda:vault-denied"],
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows.map((row) => row.id)).toEqual([kept.id]);
    });

    it("scopes the denylist to its provider, so a shared reference is not collateral", async () => {
      // Same reference under two providers: only the keyed one may disappear.
      const upshift = await seedStrategy({ provider: "upshift", providerReference: "shared-ref" });
      const kamino = await seedStrategy({ provider: "kamino", providerReference: "shared-ref" });

      const { rows } = await repo.listStrategies({
        environment: "sandbox",
        excludeProviderKeys: ["upshift:shared-ref"],
        limit: 10,
        offset: 0,
      });

      expect(rows.map((row) => row.id)).toEqual([kamino.id]);
      expect(rows.map((row) => row.id)).not.toContain(upshift.id);
    });

    it("shows only the allowlisted references for a curated provider", async () => {
      const picked = await seedStrategy({ provider: "kamino", providerReference: "kv-picked" });
      await seedStrategy({ provider: "kamino", providerReference: "kv-other" });
      // An uncurated provider passes through untouched.
      const uncurated = await seedStrategy({
        provider: "upshift",
        providerReference: "upshift-vault",
      });

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        allowedProviderReferences: { kamino: ["kv-picked"] },
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(2);
      expect(rows.map((row) => row.id).sort()).toEqual([uncurated.id, picked.id].sort());
    });

    it("reads an EMPTY allowlist literally — that provider shows nothing", async () => {
      await seedStrategy({ provider: "kamino", providerReference: "kv-any" });
      const uncurated = await seedStrategy({
        provider: "upshift",
        providerReference: "upshift-vault",
      });

      const { rows, total } = await repo.listStrategies({
        environment: "sandbox",
        allowedProviderReferences: { kamino: [] },
        limit: 10,
        offset: 0,
      });

      expect(total).toBe(1);
      expect(rows.map((row) => row.id)).toEqual([uncurated.id]);
    });
  });
});
