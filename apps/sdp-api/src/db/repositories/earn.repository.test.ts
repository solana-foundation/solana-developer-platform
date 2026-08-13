import type { EarnPortfolioDeposit, EarnPortfolioWithdrawal } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import {
  applyEarnDepositObservation,
  depositObservationFromProviderRead,
} from "@/services/earn-deposit-ledger.service";
import {
  applyEarnWithdrawalObservationByReference,
  applyEarnWithdrawalObservationToRow,
} from "@/services/earn-withdrawal-ledger.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  CreateEarnProgramWithdrawalInput,
  EarnProgramDepositRow,
  EarnProgramWithdrawalRow,
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProgramDepositInput,
  InsertEarnProviderWalletInput,
  ListEarnProviderWalletsInput,
  ListEarnProviderWalletsResult,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import { EARN_SEED_REFERENCE_PREFIX } from "./earn.repository";
import { createPostgresEarnRepository } from "./earn.repository.postgres";

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
    await db.prepare("DELETE FROM earn_program_movements").run();
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

  type OrderedTable = "earn_strategies" | "earn_program_movements" | "earn_provider_wallets";

  async function setCreatedAt(table: OrderedTable, id: string, createdAt: string): Promise<void> {
    // The movement ledger sorts on occurred_at, not created_at (migration 0057), so
    // freezing only created_at there would leave the real sort key varying and the
    // id-tiebreaker assertions below would pass or fail by accident.
    const assignments = ["created_at = ?"];
    const values: unknown[] = [createdAt];
    if (table === "earn_program_movements") {
      assignments.push("occurred_at = ?");
      values.push(createdAt);
    }
    await getDb(env)
      .prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
  }

  async function freezeCreatedAt(table: OrderedTable, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      await setCreatedAt(table, id, SHARED_CREATED_AT);
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

    it("never touches dev-seed fixtures, which no provider lists", async () => {
      const fixture = await seedStrategy({
        providerReference: `${EARN_SEED_REFERENCE_PREFIX}kamino-allez-usdc`,
      });

      const deleted = await repo.deleteUnlistedStrategies({
        provider: "ground",
        environment: "sandbox",
        listedProviderReferences: ["kamino-steakhouse-usdc"],
      });

      expect(deleted).toEqual([]);
      expect((await repo.getStrategyById(fixture.id))?.status).toBe("active");
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
  describe("program withdrawals ledger (earn_program_movements)", () => {
    const NON_TERMINAL = ["requested", "processing", "pending_approval"] as const;

    let wallet: EarnProviderWalletRow;

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
    });

    function withdrawalInput(
      overrides: Partial<CreateEarnProgramWithdrawalInput> = {}
    ): CreateEarnProgramWithdrawalInput {
      return {
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        walletId: wallet.id,
        provider: "veda",
        amountRequestedUsd: "125.50",
        token: "usdc",
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
      overrides: Partial<CreateEarnProgramWithdrawalInput> = {}
    ): Promise<EarnProgramWithdrawalRow> {
      const row = await repo.createProgramWithdrawal(withdrawalInput(overrides));
      if (!row) {
        throw new Error("failed to seed withdrawal");
      }
      return row;
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

    async function readRow(id: string): Promise<EarnProgramWithdrawalRow | null> {
      const raw = await getDb(env)
        .prepare("SELECT * FROM earn_program_movements WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!raw) {
        return null;
      }
      // The repository has no unscoped get-by-id on purpose; a raw read keeps
      // assertions independent of the code under test.
      return raw as unknown as EarnProgramWithdrawalRow;
    }

    it("inserts an intent row: status 'requested', no provider reference, fingerprint stored", async () => {
      const row = await seedWithdrawal();

      expect(row.id).toMatch(/^earn_program_withdrawal_/);
      expect(row.status).toBe("requested");
      expect(row.provider_reference).toBeNull();
      expect(row.idempotency_fingerprint).toBe('{"scope":"earn_program_withdrawal"}');
      expect(row.amount_requested_usd).toBe("125.50");
      expect(row.amount_paid_usd).toBeNull();
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
      await expect(
        seedWithdrawal({ requestId, walletId: otherWallet?.id, provider: "ground" })
      ).resolves.toMatchObject({ wallet_id: otherWallet?.id });
    });

    it("resolves replays by (org, wallet, request_id) and misses foreign orgs", async () => {
      const requestId = crypto.randomUUID();
      const row = await seedWithdrawal({ requestId });

      await expect(
        repo.getProgramWithdrawalByRequestId({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          requestId,
        })
      ).resolves.toMatchObject({ id: row.id });
      await expect(
        repo.getProgramWithdrawalByRequestId({
          organizationId: "org_someone_else",
          walletId: wallet.id,
          requestId,
        })
      ).resolves.toBeNull();
    });

    describe("updateProgramWithdrawalStatusGuarded", () => {
      it("transitions when the current status is in fromStatuses and stamps the provider reference", async () => {
        const row = await seedWithdrawal();

        const updated = await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
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
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
          toStatus: "completed",
          providerReference: "wd-provider-ref-1",
          completedAt: "2026-08-11T01:00:00.000Z",
        });

        const regressed = await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
          toStatus: "processing",
        });

        expect(regressed).toBeNull();
        const current = await readRow(row.id);
        expect(current?.status).toBe("completed");
        expect(current?.completed_at).toBe("2026-08-11T01:00:00.000Z");
      });

      it("returns null for a missing row and for a foreign organization", async () => {
        const row = await seedWithdrawal();

        await expect(
          repo.updateProgramWithdrawalStatusGuarded({
            selector: { withdrawalId: "earn_program_withdrawal_missing" },
            organizationId: TEST_ORG.id,
            fromStatuses: NON_TERMINAL,
            toStatus: "processing",
          })
        ).resolves.toBeNull();

        await expect(
          repo.updateProgramWithdrawalStatusGuarded({
            selector: { withdrawalId: row.id },
            organizationId: "org_someone_else",
            fromStatuses: NON_TERMINAL,
            toStatus: "processing",
          })
        ).resolves.toBeNull();
        await expect(readRow(row.id)).resolves.toMatchObject({ status: "requested" });
      });

      it("supports the (provider, provider_reference) selector for observation paths", async () => {
        const row = await seedWithdrawal();
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
          toStatus: "processing",
          providerReference: "wd-provider-ref-9",
        });

        const updated = await repo.updateProgramWithdrawalStatusGuarded({
          selector: { provider: "veda", providerReference: "wd-provider-ref-9" },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
          toStatus: "completed",
          amountPaidUsd: "124.9",
          feeUsd: "0.6",
          completedAt: "2026-08-11T02:00:00.000Z",
        });

        expect(updated?.id).toBe(row.id);
        expect(updated?.status).toBe("completed");
        expect(updated?.amount_paid_usd).toBe("124.9");
        expect(updated?.fee_usd).toBe("0.6");
      });

      it("self-transitions refresh fields without changing status", async () => {
        const row = await seedWithdrawal();
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
          toStatus: "processing",
          providerReference: "wd-provider-ref-2",
          providerData: { first: true },
        });

        const refreshed = await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: ["processing"],
          toStatus: "processing",
          feeUsd: "0.55",
          providerData: { second: true },
        });

        expect(refreshed?.status).toBe("processing");
        expect(refreshed?.fee_usd).toBe("0.55");
        // JSONB shallow merge: both observations survive.
        expect(refreshed?.provider_data).toEqual({ first: true, second: true });
      });

      it("serializes concurrent terminal transitions — exactly one wins", async () => {
        const row = await seedWithdrawal();
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: row.id },
          organizationId: TEST_ORG.id,
          fromStatuses: NON_TERMINAL,
          toStatus: "processing",
          providerReference: "wd-provider-ref-3",
        });

        const [completed, failed] = await Promise.all([
          repo.updateProgramWithdrawalStatusGuarded({
            selector: { withdrawalId: row.id },
            organizationId: TEST_ORG.id,
            fromStatuses: NON_TERMINAL,
            toStatus: "completed",
            amountPaidUsd: "125.5",
            completedAt: "2026-08-11T03:00:00.000Z",
          }),
          repo.updateProgramWithdrawalStatusGuarded({
            selector: { withdrawalId: row.id },
            organizationId: TEST_ORG.id,
            fromStatuses: NON_TERMINAL,
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
          expect(current.amount_paid_usd).toBe("125.5");
          expect(current.failure_reason).toBeNull();
        } else {
          expect(current?.status).toBe("failed");
          expect(current?.failure_reason).toBe("declined");
          expect(current?.amount_paid_usd).toBeNull();
        }
      });
    });

    describe("ledger service appliers", () => {
      it("applyToRow advances a requested row and stamps its provider reference", async () => {
        const row = await seedWithdrawal();

        const updated = await applyEarnWithdrawalObservationToRow({
          repo,
          row,
          observed: observed({ status: "processing", feeUsd: "0.5" }),
        });

        expect(updated?.status).toBe("processing");
        expect(updated?.provider_reference).toBe("wd-provider-ref-1");
        expect(updated?.fee_usd).toBe("0.5");
        expect(updated?.provider_data).toMatchObject({
          lastObservation: { status: "processing" },
        });
      });

      it("applyToRow is a no-op on a terminal row (belt before the SQL braces)", async () => {
        const row = await seedWithdrawal();
        await applyEarnWithdrawalObservationToRow({
          repo,
          row,
          observed: observed({ status: "failed", failureReason: "declined" }),
        });
        const terminal = await readRow(row.id);

        const result = await applyEarnWithdrawalObservationToRow({
          repo,
          row: terminal as EarnProgramWithdrawalRow,
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
          repo,
          row,
          observed: observed({ status: "pending_approval" }),
        });

        const completed = await applyEarnWithdrawalObservationByReference({
          repo,
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
        expect(completed?.completed_at).toBe("2026-08-11T04:00:00.000Z");

        // Terminal rows never regress, even through the reference path.
        const after = await applyEarnWithdrawalObservationByReference({
          repo,
          provider: "veda",
          organizationId: TEST_ORG.id,
          observed: observed({ status: "processing" }),
        });
        expect(after?.status).toBe("completed");
      });

      it("applyByReference no-ops cleanly on an unknown reference (pre-ledger withdrawals)", async () => {
        await expect(
          applyEarnWithdrawalObservationByReference({
            repo,
            provider: "veda",
            organizationId: TEST_ORG.id,
            observed: observed({ withdrawalRef: "wd-never-seen" }),
          })
        ).resolves.toBeNull();
      });

      it("applyByReference refuses to write across organizations", async () => {
        const row = await seedWithdrawal();
        await applyEarnWithdrawalObservationToRow({
          repo,
          row,
          observed: observed({ status: "processing" }),
        });

        const result = await applyEarnWithdrawalObservationByReference({
          repo,
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
        await freezeCreatedAt("earn_program_movements", ids);
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
        await seedWithdrawal({ walletId: siblingProgram?.id });

        const seen: string[] = [];
        for (let offset = 0; offset < expected.length; offset += 2) {
          const { rows, total } = await repo.listProgramWithdrawals({
            organizationId: TEST_ORG.id,
            walletId: wallet.id,
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

  // Same non-Ground stub provider as the withdrawal suite above, for the same
  // reason: the deposit ledger consumes only the canonical contract, so any
  // registered provider id must exercise it identically (ADR 0002 pluggability).
  describe("program deposits ledger (earn_program_movements)", () => {
    const SOURCE_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const SIGNATURE = "5h1mNqE8s8kQ7Yy3wV2bT1cR9dF4gH6jK8lM0nP2qS4tU6vW8xY0zA2bC4dE6fG8";

    let wallet: EarnProviderWalletRow;

    beforeEach(async () => {
      const row = await repo.insertProviderWallet({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        environment: "sandbox",
        provider: "veda",
        providerWalletRef: "bb8e6b2f-9a5d-4d2b-8f3c-4e8a7b9d0f13",
        label: null,
        createdBy: TEST_USER.id,
      });
      if (!row) {
        throw new Error("failed to seed program wallet");
      }
      wallet = row;
    });

    function depositInput(
      overrides: Partial<InsertEarnProgramDepositInput> = {}
    ): InsertEarnProgramDepositInput {
      return {
        organizationId: TEST_ORG.id,
        walletId: wallet.id,
        provider: "veda",
        status: "processing",
        amountUsd: "250.00",
        token: "usdc",
        providerReference: `dep_${crypto.randomUUID()}`,
        sourceAddress: SOURCE_ADDRESS,
        transactionSignature: SIGNATURE,
        transactionInstructionIndex: null,
        observedVia: "provider_poll",
        occurredAt: "2026-08-12T09:00:00.000Z",
        completedAt: null,
        providerData: { discoveredVia: "provider_poll" },
        ...overrides,
      };
    }

    async function seedDeposit(
      overrides: Partial<InsertEarnProgramDepositInput> = {}
    ): Promise<EarnProgramDepositRow> {
      const row = await repo.insertProgramDeposit(depositInput(overrides));
      if (!row) {
        throw new Error("failed to seed deposit");
      }
      return row;
    }

    function observedDeposit(overrides: Partial<EarnPortfolioDeposit> = {}): EarnPortfolioDeposit {
      return {
        id: "dep_provider_ref_1",
        amountUsd: "250.00",
        token: "usdc",
        status: "processing",
        fromAddress: SOURCE_ADDRESS,
        transactionSignature: SIGNATURE,
        createdAt: "2026-08-12T09:00:00.000Z",
        ...overrides,
      };
    }

    // Raw read, same reasoning as the withdrawal suite: keeps assertions
    // independent of the code under test.
    async function readRawRow(id: string): Promise<Record<string, unknown> | null> {
      return getDb(env)
        .prepare("SELECT * FROM earn_program_movements WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
    }

    it("inserts an observed row with no intent state and stamped provenance", async () => {
      const row = await seedDeposit();

      expect(row.id).toMatch(/^earn_program_deposit_/);
      expect(row.direction).toBe("deposit");
      expect(row.status).toBe("processing");
      expect(row.observed_via).toBe("provider_poll");
      expect(row.amount_paid_usd).toBe("250.00");
      expect(row.occurred_at).toBe("2026-08-12T09:00:00.000Z");
      expect(row.source_address).toBe(SOURCE_ADDRESS);
      expect(row.transaction_signature).toBe(SIGNATURE);
      expect(row.transaction_instruction_index).toBeNull();

      // Every intent column is null — nobody at SDP requested this money, and the
      // DB CHECK makes writing one unrepresentable.
      expect(row.request_id).toBeNull();
      expect(row.idempotency_fingerprint).toBeNull();
      expect(row.project_id).toBeNull();
      expect(row.amount_requested_usd).toBeNull();
      expect(row.destination_address).toBeNull();
    });

    it("locks one row per (provider, direction, provider_reference)", async () => {
      const first = await seedDeposit();

      await expect(
        repo.insertProgramDeposit(depositInput({ providerReference: first.provider_reference }))
      ).rejects.toSatisfy((err: unknown) => isPostgresUniqueViolation(err));
    });

    it("does not over-lock the same reference across DIRECTIONS", async () => {
      // A provider with ONE id space across deposits and withdrawals must not have
      // its second movement swallowed as a replay. Ground happens to prefix its
      // ids, but the ledger may never depend on that.
      const shared = "shared_provider_movement_id";
      await seedDeposit({ providerReference: shared });

      const withdrawal = await repo.createProgramWithdrawal({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        walletId: wallet.id,
        provider: "veda",
        amountRequestedUsd: "10.00",
        token: "usdc",
        destinationAddress: DESTINATION,
        requestId: crypto.randomUUID(),
        idempotencyFingerprint: '{"scope":"earn_program_withdrawal"}',
        providerData: {},
        createdBy: TEST_USER.id,
        initiatedByKeyId: null,
      });
      const advanced = await repo.updateProgramWithdrawalStatusGuarded({
        selector: { withdrawalId: withdrawal?.id ?? "" },
        organizationId: TEST_ORG.id,
        fromStatuses: ["requested"],
        toStatus: "processing",
        providerReference: shared,
      });

      expect(advanced?.provider_reference).toBe(shared);
    });

    it("does NOT constrain two deposits that share one transaction signature", async () => {
      // Two SPL transfers to one funding address inside one transaction are legal,
      // and the provider reports them as two deposits sharing a hash. A unique on
      // the signature would reject the second and silently drop real money.
      const first = await seedDeposit({ providerReference: "dep_batch_a" });
      const second = await seedDeposit({ providerReference: "dep_batch_b" });

      expect(first.transaction_signature).toBe(SIGNATURE);
      expect(second.transaction_signature).toBe(SIGNATURE);

      const both = await repo.listProgramDepositsBySignature({
        walletId: wallet.id,
        transactionSignature: SIGNATURE,
      });
      expect(both.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
    });

    it("locks chain identity only once an observer supplies an instruction index", async () => {
      // The chain-identity unique is dormant in V1 (no provider reports a
      // positional index) and arms itself the day an indexer writes.
      await seedDeposit({
        providerReference: null,
        transactionInstructionIndex: 0,
        observedVia: "chain_indexer",
      });

      await expect(
        repo.insertProgramDeposit(
          depositInput({
            providerReference: null,
            transactionInstructionIndex: 0,
            observedVia: "chain_indexer",
          })
        )
      ).rejects.toSatisfy((err: unknown) => isPostgresUniqueViolation(err));

      // A different transfer in the SAME transaction is a different movement.
      await expect(
        repo.insertProgramDeposit(
          depositInput({
            providerReference: null,
            transactionInstructionIndex: 1,
            observedVia: "chain_indexer",
          })
        )
      ).resolves.toMatchObject({ transaction_instruction_index: 1 });
    });

    describe("observation applier", () => {
      it("creates the row on first sight and is idempotent under re-sweep", async () => {
        const observation = depositObservationFromProviderRead(
          observedDeposit(),
          "provider_poll",
          "2026-08-12T09:05:00.000Z"
        );

        const created = await applyEarnDepositObservation({ repo, wallet, observation });
        const again = await applyEarnDepositObservation({ repo, wallet, observation });

        expect(created?.id).toBeDefined();
        expect(again?.id).toBe(created?.id);

        const { total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(1);
      });

      it("records two deposits that share one transaction signature as TWO rows", async () => {
        // The applier-level twin of the schema test above, and the one that
        // matters: proving the DB PERMITS two rows sharing a signature says
        // nothing about whether the write path can ever produce them. A batching
        // payer landing two transfers to one funding address in one transaction is
        // reported by the provider as two deposits sharing one txHash, and both are
        // real money that must appear separately in the ledger.
        const shared = { transactionSignature: SIGNATURE, createdAt: "2026-08-12T09:00:00.000Z" };

        const first = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ id: "dep_batch_a", amountUsd: "100.00", ...shared }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });
        const second = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ id: "dep_batch_b", amountUsd: "250.00", ...shared }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        expect(first?.id).toBeDefined();
        expect(second?.id).toBeDefined();
        expect(second?.id).not.toBe(first?.id);

        const { rows, total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(2);
        expect(rows.map((row) => row.provider_reference).sort()).toEqual([
          "dep_batch_a",
          "dep_batch_b",
        ]);
        // Neither row may have been overwritten by the other's amount.
        expect(rows.map((row) => row.amount_paid_usd).sort()).toEqual(["100.00", "250.00"]);
      });

      it("still records the second of two batched deposits when the first has already settled", async () => {
        // The silent-loss variant: a poll running after settlement sees the first
        // deposit already terminal, so an adopt-then-early-return would drop the
        // second movement entirely, with no error and nothing in the ledger.
        const shared = { transactionSignature: SIGNATURE, createdAt: "2026-08-12T09:00:00.000Z" };

        await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({
              id: "dep_settled_a",
              status: "completed",
              amountUsd: "100.00",
              completedAt: "2026-08-12T09:01:00.000Z",
              ...shared,
            }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        const second = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({
              id: "dep_settled_b",
              status: "completed",
              amountUsd: "250.00",
              completedAt: "2026-08-12T09:01:00.000Z",
              ...shared,
            }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        expect(second?.provider_reference).toBe("dep_settled_b");
        const { total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(2);
      });

      it("still adopts an UNCLAIMED row on a signature match — the indexer handoff", async () => {
        // The capability the signature branch exists for, and what the fix above
        // must not break: a row written by an observer that had no provider
        // reference (an indexer reading chain) is CLAIMED by the poller that later
        // learns the provider's id, rather than duplicated.
        const indexerRow = await seedDeposit({
          providerReference: null,
          transactionSignature: SIGNATURE,
          transactionInstructionIndex: 0,
          observedVia: "chain_indexer",
          amountUsd: "100.00",
        });

        const claimed = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({
              id: "dep_from_provider",
              amountUsd: "100.00",
              transactionSignature: SIGNATURE,
            }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        expect(claimed?.id).toBe(indexerRow.id);
        expect(claimed?.provider_reference).toBe("dep_from_provider");
        expect(claimed?.observed_via).toBe("provider_poll");
        // Claimed, not duplicated.
        const { total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(1);
      });

      it("normalizes a provider timestamp to the DB's fixed-width shape", async () => {
        // TEXT timestamps sort lexicographically, so a provider sending no
        // milliseconds would sort wrongly against DB-stamped rows.
        const row = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ createdAt: "2026-08-12T09:00:00Z" }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        expect(row?.occurred_at).toBe("2026-08-12T09:00:00.000Z");
      });

      it("advances processing to completed and never regresses from terminal", async () => {
        const first = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit(),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });
        expect(first?.status).toBe("processing");

        const settled = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ status: "completed", completedAt: "2026-08-12T09:10:00.000Z" }),
            "provider_poll",
            "2026-08-12T09:10:00.000Z"
          ),
        });
        expect(settled?.status).toBe("completed");
        expect(settled?.completed_at).toBe("2026-08-12T09:10:00.000Z");

        // A late or reordered page must not walk a settled row backwards.
        const regressed = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ status: "processing" }),
            "provider_poll",
            "2026-08-12T09:15:00.000Z"
          ),
        });
        expect(regressed?.status).toBe("completed");
      });

      it("never turns a failed deposit into a completed one", async () => {
        await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ status: "failed" }),
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        const reversed = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            observedDeposit({ status: "completed" }),
            "provider_poll",
            "2026-08-12T09:10:00.000Z"
          ),
        });

        expect(reversed?.status).toBe("failed");
      });

      it("lets concurrent observers race without either throwing, landing one row", async () => {
        // The applier's only concurrency defence: a unique violation means "it
        // already happened", so the loser re-reads and advances the winner's row.
        const observation = depositObservationFromProviderRead(
          observedDeposit(),
          "provider_poll",
          "2026-08-12T09:05:00.000Z"
        );

        const [a, b] = await Promise.all([
          applyEarnDepositObservation({ repo, wallet, observation }),
          applyEarnDepositObservation({ repo, wallet, observation }),
        ]);

        expect(a?.id).toBeDefined();
        expect(b?.id).toBe(a?.id);

        const { total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(1);
      });

      it("lands ONE row when the same movement is observed by all three sources", async () => {
        // The product direction this design exists to serve: the poller today,
        // PRO-1631's webhooks next, and an SDP indexer eventually all write the
        // SAME row. If any pair failed to converge, one real deposit would appear
        // two or three times and every downstream total would over-count.
        const base = observedDeposit({ id: "dep_multi", transactionSignature: SIGNATURE });

        const fromPoll = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            base,
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });
        const fromWebhook = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            base,
            "provider_webhook",
            "2026-08-12T09:06:00.000Z"
          ),
        });
        // The indexer has no provider id — only chain identity.
        const fromIndexer = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: {
            source: "chain_indexer",
            transactionSignature: SIGNATURE,
            status: "completed",
            amountUsd: base.amountUsd,
            token: "usdc",
            occurredAt: "2026-08-12T09:00:00.000Z",
            raw: { slot: 1234 },
          },
        });

        expect(fromWebhook?.id).toBe(fromPoll?.id);
        expect(fromIndexer?.id).toBe(fromPoll?.id);
        // Latest observer wins the state; the DISCOVERING one survives the merge.
        expect(fromIndexer?.observed_via).toBe("chain_indexer");
        expect(fromIndexer?.status).toBe("completed");
        expect(fromIndexer?.provider_data).toMatchObject({ discoveredVia: "provider_poll" });

        const { total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          limit: 10,
          offset: 0,
        });
        expect(total).toBe(1);
      });

      it("refuses to write a sibling program's row", async () => {
        const existing = await seedDeposit({ providerReference: "dep_provider_ref_1" });
        const sibling = await repo.insertProviderWallet({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          environment: "sandbox",
          provider: "veda",
          providerWalletRef: "cc9f7c30-1b6e-4e3c-9a4d-5f9b8c0e1a24",
          label: null,
          createdBy: TEST_USER.id,
        });
        if (!sibling) {
          throw new Error("failed to seed sibling program");
        }

        const applied = await applyEarnDepositObservation({
          repo,
          wallet: sibling,
          observation: depositObservationFromProviderRead(
            observedDeposit({ status: "completed" }),
            "provider_poll",
            "2026-08-12T09:10:00.000Z"
          ),
        });

        expect(applied).toBeNull();
        await expect(readRawRow(existing.id)).resolves.toMatchObject({ status: "processing" });
      });

      it("records an off-rail deposit's value with no signature or source address", async () => {
        // ADR 0002 invariant 5: the VALUE always surfaces, another rail's
        // identifiers never do — so a real deposit legitimately has neither.
        const row = await applyEarnDepositObservation({
          repo,
          wallet,
          observation: depositObservationFromProviderRead(
            {
              id: "dep_off_rail",
              amountUsd: "77.00",
              token: "usdt",
              status: "completed",
              createdAt: "2026-08-12T09:00:00.000Z",
            },
            "provider_poll",
            "2026-08-12T09:05:00.000Z"
          ),
        });

        expect(row?.amount_paid_usd).toBe("77.00");
        expect(row?.transaction_signature).toBeNull();
        expect(row?.source_address).toBeNull();
      });
    });

    describe("listProgramMovements", () => {
      it("returns both directions newest-first on occurred_at with an id tiebreaker", async () => {
        const olderDeposit = await seedDeposit({
          providerReference: "dep_older",
          occurredAt: "2026-08-10T00:00:00.000Z",
        });
        const newerDeposit = await seedDeposit({
          providerReference: "dep_newer",
          occurredAt: "2026-08-14T00:00:00.000Z",
        });

        const { rows, total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "all",
          limit: 10,
          offset: 0,
        });

        expect(total).toBe(2);
        expect(rows.map((row) => row.id)).toEqual([newerDeposit.id, olderDeposit.id]);
      });

      it("filters by direction, status, token and a HALF-OPEN period", async () => {
        await seedDeposit({ providerReference: "dep_in", occurredAt: "2026-08-05T00:00:00.000Z" });
        await seedDeposit({
          providerReference: "dep_on_upper_bound",
          occurredAt: "2026-08-10T00:00:00.000Z",
        });

        const { rows } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "deposit",
          statuses: ["processing"],
          token: "usdc",
          occurredFrom: "2026-08-01T00:00:00.000Z",
          occurredTo: "2026-08-10T00:00:00.000Z",
          limit: 10,
          offset: 0,
        });

        // The row landing exactly on the upper bound is EXCLUDED — a closed bound
        // would double-count it into the next period too.
        expect(rows.map((row) => row.provider_reference)).toEqual(["dep_in"]);
      });

      it("keeps a sibling program's movements out", async () => {
        await seedDeposit({ providerReference: "dep_mine" });
        const sibling = await repo.insertProviderWallet({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          environment: "sandbox",
          provider: "veda",
          providerWalletRef: "dd0a8d41-2c7f-4f4d-ab5e-6a0c9d1f2b35",
          label: null,
          createdBy: TEST_USER.id,
        });
        await seedDeposit({ walletId: sibling?.id, providerReference: "dep_theirs" });

        const { rows, total } = await repo.listProgramMovements({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          direction: "all",
          limit: 10,
          offset: 0,
        });

        expect(total).toBe(1);
        expect(rows[0]?.provider_reference).toBe("dep_mine");
      });
    });

    describe("sumProgramMovementsByDirection", () => {
      it("nets BOTH directions per token, counting partially_completed and the requested fallback", async () => {
        // The movement half of PRO-1672's identity (delta balance - net movements
        // = earnings). Getting either direction or the settled-status set wrong
        // silently mis-states customer earnings, so this pins all of it together.
        await seedDeposit({
          providerReference: "dep_usdc",
          status: "completed",
          amountUsd: "300.00",
          occurredAt: "2026-08-05T00:00:00.000Z",
        });
        await seedDeposit({
          providerReference: "dep_usdt",
          status: "completed",
          token: "usdt",
          amountUsd: "50.00",
          occurredAt: "2026-08-06T00:00:00.000Z",
        });

        // A fully settled withdrawal: the PAID figure is what actually moved.
        const settled = await repo.createProgramWithdrawal({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          walletId: wallet.id,
          provider: "veda",
          amountRequestedUsd: "120.00",
          token: "usdc",
          destinationAddress: DESTINATION,
          requestId: crypto.randomUUID(),
          idempotencyFingerprint: "{}",
          providerData: {},
          createdBy: TEST_USER.id,
          initiatedByKeyId: null,
        });
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: settled?.id ?? "" },
          organizationId: TEST_ORG.id,
          fromStatuses: ["requested"],
          toStatus: "completed",
          amountPaidUsd: "118.00",
        });

        // partially_completed moved REAL money and must be counted.
        const partial = await repo.createProgramWithdrawal({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          walletId: wallet.id,
          provider: "veda",
          amountRequestedUsd: "80.00",
          token: "usdc",
          destinationAddress: DESTINATION,
          requestId: crypto.randomUUID(),
          idempotencyFingerprint: "{}",
          providerData: {},
          createdBy: TEST_USER.id,
          initiatedByKeyId: null,
        });
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: partial?.id ?? "" },
          organizationId: TEST_ORG.id,
          fromStatuses: ["requested"],
          toStatus: "partially_completed",
          amountPaidUsd: "30.00",
        });

        // Terminal but moved NOTHING — must be excluded from the net.
        const failed = await repo.createProgramWithdrawal({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          walletId: wallet.id,
          provider: "veda",
          amountRequestedUsd: "999.00",
          token: "usdc",
          destinationAddress: DESTINATION,
          requestId: crypto.randomUUID(),
          idempotencyFingerprint: "{}",
          providerData: {},
          createdBy: TEST_USER.id,
          initiatedByKeyId: null,
        });
        await repo.updateProgramWithdrawalStatusGuarded({
          selector: { withdrawalId: failed?.id ?? "" },
          organizationId: TEST_ORG.id,
          fromStatuses: ["requested"],
          toStatus: "failed",
        });

        // Freeze every movement into the period: withdrawals stamp occurred_at at
        // intent, which is "now".
        await getDb(env)
          .prepare(
            "UPDATE earn_program_movements SET occurred_at = ? WHERE direction = 'withdrawal'"
          )
          .bind("2026-08-07T00:00:00.000Z")
          .run();

        const sums = await repo.sumProgramMovementsByDirection({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          occurredFrom: "2026-08-01T00:00:00.000Z",
          occurredTo: "2026-09-01T00:00:00.000Z",
        });

        expect(sums).toEqual([
          { direction: "deposit", token: "usdc", movementCount: 1, totalUsd: "300.00" },
          { direction: "deposit", token: "usdt", movementCount: 1, totalUsd: "50.00" },
          // 118.00 paid + 30.00 partially paid; the failed 999.00 is excluded, and
          // the settled figures win over the requested ones.
          { direction: "withdrawal", token: "usdc", movementCount: 2, totalUsd: "148.00" },
        ]);
      });

      it("attributes a boundary movement to one period only, whatever shape the bound arrives in", async () => {
        // occurred_at is TEXT compared lexicographically, so an un-normalized bound
        // without milliseconds would book this movement into the WRONG month.
        await seedDeposit({
          providerReference: "dep_boundary",
          status: "completed",
          amountUsd: "10.00",
          occurredAt: "2026-09-01T00:00:00.000Z",
        });

        const august = await repo.sumProgramMovementsByDirection({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          occurredFrom: "2026-08-01T00:00:00Z",
          occurredTo: "2026-09-01T00:00:00Z",
        });
        const september = await repo.sumProgramMovementsByDirection({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          occurredFrom: "2026-09-01T00:00:00Z",
          occurredTo: "2026-10-01T00:00:00Z",
        });

        expect(august).toEqual([]);
        expect(september).toEqual([
          { direction: "deposit", token: "usdc", movementCount: 1, totalUsd: "10.00" },
        ]);
      });

      it("nets settled movements per direction on the movement's OWN time", async () => {
        // In period, settled.
        await seedDeposit({
          providerReference: "dep_settled",
          status: "completed",
          amountUsd: "100.00",
          occurredAt: "2026-08-05T00:00:00.000Z",
        });
        // In period, still processing — no money moved yet.
        await seedDeposit({
          providerReference: "dep_pending",
          amountUsd: "999.00",
          occurredAt: "2026-08-06T00:00:00.000Z",
        });
        // Settled but OUTSIDE the period.
        await seedDeposit({
          providerReference: "dep_next_month",
          status: "completed",
          amountUsd: "500.00",
          occurredAt: "2026-09-02T00:00:00.000Z",
        });

        const sums = await repo.sumProgramMovementsByDirection({
          organizationId: TEST_ORG.id,
          walletId: wallet.id,
          occurredFrom: "2026-08-01T00:00:00.000Z",
          occurredTo: "2026-09-01T00:00:00.000Z",
        });

        expect(sums).toEqual([
          { direction: "deposit", token: "usdc", movementCount: 1, totalUsd: "100.00" },
        ]);
      });
    });

    describe("scanProviderWallets", () => {
      it("crosses organizations — the only Earn read with no tenant scope", async () => {
        // A platform sweep has no tenant, so this must see every org's programs.
        const before = await repo.scanProviderWallets({ environment: "sandbox", limit: 100 });
        expect(before.some((row) => row.id === wallet.id)).toBe(true);
        expect(before.every((row) => row.environment === "sandbox")).toBe(true);
      });

      it("resumes from a keyset cursor and skips nothing when a sibling is inserted mid-scan", async () => {
        // Timestamps are pinned explicitly: bulk inserts share one sdp_iso_now()
        // value, so leaving them to the clock makes the ORDER — and therefore this
        // assertion — depend on which random uuid sorts first.
        const second = await repo.insertProviderWallet({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          environment: "sandbox",
          provider: "veda",
          providerWalletRef: "ee1b9e52-3d8a-4a5e-bc6f-7b1d0e2a3c46",
          label: null,
          createdBy: TEST_USER.id,
        });
        if (!second) {
          throw new Error("failed to seed the second program");
        }
        await setCreatedAt("earn_provider_wallets", wallet.id, "2026-08-01T00:00:00.000Z");
        await setCreatedAt("earn_provider_wallets", second.id, "2026-08-03T00:00:00.000Z");

        const firstPage = await repo.scanProviderWallets({ environment: "sandbox", limit: 1 });
        expect(firstPage.map((row) => row.id)).toEqual([wallet.id]);

        // A program created mid-pass lands BETWEEN the cursor and the row still to
        // be visited. Offset paging would now skip that pending row entirely; a
        // keyset resume cannot, which is the property 0056's stable ordering buys.
        const insertedMidScan = await repo.insertProviderWallet({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          environment: "sandbox",
          provider: "veda",
          providerWalletRef: "ff2ca063-4e9b-4b6f-bd7a-8c2e1f3b4d57",
          label: null,
          createdBy: TEST_USER.id,
        });
        if (!insertedMidScan) {
          throw new Error("failed to seed the mid-scan program");
        }
        await setCreatedAt("earn_provider_wallets", insertedMidScan.id, "2026-08-02T00:00:00.000Z");

        const resumed = await repo.scanProviderWallets({
          environment: "sandbox",
          after: { createdAt: "2026-08-01T00:00:00.000Z", id: wallet.id },
          limit: 100,
        });

        // Never re-visits the cursor row, and never loses the pending one.
        expect(resumed.map((row) => row.id)).toEqual([insertedMidScan.id, second.id]);
      });

      it("excludes the other environment", async () => {
        const production = await repo.scanProviderWallets({
          environment: "production",
          limit: 100,
        });
        expect(production.some((row) => row.id === wallet.id)).toBe(false);
      });
    });
  });
});
