import type { EarnVaultPositionSnapshot } from "@sdp/earn/types";
import type { EarnPositionsResponse } from "@sdp/types/earn-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { UpsertEarnStrategyInput } from "@/db/repositories/earn.repository";
import { createPostgresEarnRepository } from "@/db/repositories/earn.repository.postgres";
import {
  claimDiscoveredStrategyPosition,
  createPostgresEarnMovementsRepository,
  generateEarnMovementId,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import { app } from "@/index";
import {
  type EarnAuthzTenant,
  type EarnTestApiKey,
  seedEarnApiKey,
  seedEarnAuthzTenant,
} from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import {
  encodeDiscoveredEarnPositionLocator,
  parseDiscoveredEarnPositionLocator,
} from "./discovered-position";
import { earnDiscoveryQuerySchema, earnPositionsQuerySchema } from "./read-schemas";

const { readVaultPositions } = vi.hoisted(() => ({ readVaultPositions: vi.fn() }));
vi.mock("@/services/earn/execution-registry", async (original) => ({
  ...(await original<typeof import("@/services/earn/execution-registry")>()),
  resolveVaultDirectClient: () => ({ readVaultPositions }),
}));

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE = "So11111111111111111111111111111111111111112";
let tenant: EarnAuthzTenant;
let key: EarnTestApiKey;

beforeEach(async () => {
  await seedTestDatabase(env);
  await clearKVStores(env);
  tenant = await seedEarnAuthzTenant(env, "core_reads", { environment: "sandbox" });
  key = await seedEarnApiKey(env, tenant, {
    id: "core_reads",
    grants: ["earn.read"],
    environment: "sandbox",
  });
  vi.clearAllMocks();
  readVaultPositions.mockImplementation(
    async (
      _runtime: unknown,
      input: { owner: string; providerReferences: string[] }
    ): Promise<EarnVaultPositionSnapshot[]> => {
      const references =
        input.providerReferences.length > 0
          ? input.providerReferences
          : (
              await getDb(env)
                .prepare(
                  "SELECT provider_reference FROM earn_strategies WHERE environment = 'sandbox'"
                )
                .all<{ provider_reference: string }>()
            ).results.map((row) => row.provider_reference);
      return references.map((providerReference) => ({
        owner: input.owner,
        providerReference,
        cluster: "devnet",
        tokenMint: TOKEN,
        shareMint: SHARE,
        shares: "2",
        withdrawableShares: "2",
        tokenValue: "10",
      }));
    }
  );
});

async function get(path: string) {
  return app.request(`/v1/earn/${path}`, { headers: { Authorization: `Bearer ${key.raw}` } }, env);
}

async function seedPosition(input: {
  reference: string;
  walletId?: string;
  projectId?: string;
  ownerAddress?: string;
  createdAt?: string;
}) {
  const id = generateEarnPositionId();
  const movementId = generateEarnMovementId();
  const projectId = input.projectId ?? tenant.project.id;
  const ownerAddress = input.ownerAddress ?? OWNER;
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider, kind, custody_wallet_id, owner_address, vault_address, share_mint, token_mint, label, activated_at, created_at) VALUES (?, ?, ?, 'sandbox', 'veda', 'vault_direct', ?, ?, ?, ?, ?, 'Strategy holding', sdp_iso_now(), ?)`
    )
    .bind(
      id,
      tenant.org.id,
      projectId,
      input.walletId ?? null,
      input.walletId ? null : ownerAddress,
      input.reference,
      SHARE,
      TOKEN,
      input.createdAt ?? "2026-11-18T10:00:00.000Z"
    )
    .run();
  await db
    .prepare(
      `INSERT INTO earn_movements (id, organization_id, project_id, environment, provider, execution_model, direction, position_id, status, denomination, amount_requested, custody_wallet_id, owner_address, vault_address, source_address, destination_address, signature, signed_transaction, last_valid_block_height, request_id, idempotency_fingerprint) VALUES (?, ?, ?, 'sandbox', 'veda', 'vault_direct', 'deposit', ?, 'requested', ?, '1', ?, ?, ?, ?, ?, ?, 'AQ==', '12345', ?, ?)`
    )
    .bind(
      movementId,
      tenant.org.id,
      projectId,
      id,
      TOKEN,
      input.walletId ?? null,
      input.walletId ? null : ownerAddress,
      input.reference,
      ownerAddress,
      input.reference,
      `sig_${crypto.randomUUID()}`,
      crypto.randomUUID(),
      `fp_${id}`
    )
    .run();
  return { id, movementId };
}

async function seedWallet() {
  const db = getDb(env);
  await db
    .prepare(
      "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status) VALUES ('cfg_core_read', ?, ?, 'privy', 'encrypted', 'active')"
    )
    .bind(tenant.org.id, tenant.project.id)
    .run();
  await db
    .prepare(
      "INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status) VALUES ('cwlt_core_read', 'cfg_core_read', 'privy_core_read', ?, 'active')"
    )
    .bind(OWNER)
    .run();
  return "cwlt_core_read";
}

async function seedStrategy(reference: string, overrides: Partial<UpsertEarnStrategyInput> = {}) {
  const row = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
    provider: "veda",
    providerReference: reference,
    name: "Indexed strategy",
    sourceKind: "defi",
    underlyingSource: null,
    depositMints: [TOKEN],
    shareMint: SHARE,
    apyType: "variable",
    currentApy: "0.06",
    liquidityTerm: "instant",
    redemptionDelayDays: null,
    riskMetadata: {},
    status: "active",
    hostCluster: "devnet",
    environment: "sandbox",
    ...overrides,
  });
  if (!row) throw new Error("missing strategy");
  return row;
}

describe("Earn core read contracts", () => {
  it("rejects conflicting owner filters and invalid summary disclosure options", () => {
    expect(
      earnPositionsQuerySchema.safeParse({ walletId: "wallet", ownerAddress: OWNER }).success
    ).toBe(false);
    expect(earnPositionsQuerySchema.safeParse({ discover: "true" }).success).toBe(false);
    expect(
      earnPositionsQuerySchema.safeParse({ ownerAddress: OWNER, ownerKind: "custody" }).success
    ).toBe(false);
    expect(
      earnPositionsQuerySchema.safeParse({ includeSummary: "true", includePositions: "true" })
        .success
    ).toBe(false);
    expect(earnDiscoveryQuerySchema.safeParse({ minApy: "0.08", maxApy: "0.01" }).success).toBe(
      false
    );
  });

  it("returns stable strategy IDs, narrowed filters and actual rate provenance", async () => {
    const row = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
      provider: "veda",
      providerReference: "core-strategy",
      name: "Core strategy",
      sourceKind: "defi",
      underlyingSource: null,
      depositMints: [TOKEN],
      shareMint: SHARE,
      apyType: "variable",
      currentApy: "0.06",
      rateObservedAt: "2026-11-18T09:00:00.000Z",
      liquidityTerm: "instant",
      redemptionDelayDays: null,
      riskMetadata: {},
      status: "active",
      hostCluster: "devnet",
      environment: "sandbox",
    });
    if (!row) throw new Error("missing strategy");
    const response = await get(
      `discovery?id=${row.id}&provider=veda&depositMint=${TOKEN}&minApy=0.05`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        total: 1,
        strategies: [
          {
            id: row.id,
            rate: { value: "0.06", measure: "apy", observedAt: "2026-11-18T09:00:00.000Z" },
            capabilities: { admission: "evaluated_on_prepare" },
          },
        ],
      },
    });
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("indexes formerly hidden strategies without widening their execution shelf", async () => {
    const row = await createPostgresEarnRepository(getDb(env)).upsertStrategy({
      provider: "veda",
      providerReference: "hidden-morpho-strategy",
      name: "Morpho strategy",
      sourceKind: "defi",
      underlyingSource: null,
      depositMints: [TOKEN],
      shareMint: SHARE,
      apyType: "variable",
      currentApy: "0.09",
      liquidityTerm: "instant",
      redemptionDelayDays: null,
      riskMetadata: {},
      status: "active",
      hostCluster: "devnet",
      environment: "sandbox",
    });
    if (!row) throw new Error("missing strategy");
    expect(await (await get(`discovery?id=${row.id}`)).json()).toMatchObject({
      data: {
        total: 1,
        strategies: [
          {
            id: row.id,
            capabilities: { deposit: false, depositUnavailableReason: "catalogue_only" },
          },
        ],
      },
    });
    expect(await (await get(`strategies`)).json()).toMatchObject({
      data: { total: 0, strategies: [] },
    });
  });

  it("keeps external owner reads exact-project scoped", async () => {
    const visible = await seedPosition({ reference: "visible" });
    await seedPosition({ reference: "sibling", projectId: "prj_core_reads_production" });
    const response = await get(`positions?ownerAddress=${OWNER}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: EarnPositionsResponse };
    expect(body.data.positions).toEqual([
      expect.objectContaining({
        id: visible.id,
        source: { ownerAddress: OWNER },
        tokenValue: "10",
      }),
    ]);
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
    expect(readVaultPositions.mock.calls[0]?.[1].providerReferences).toEqual(["visible"]);
  });

  it("merges owner shapes into one complete keyset sequence", async () => {
    const walletId = await seedWallet();
    const first = await seedPosition({
      reference: "custody",
      walletId,
      createdAt: "2026-11-18T11:00:00.000Z",
    });
    const second = await seedPosition({
      reference: "external",
      createdAt: "2026-11-18T10:00:00.000Z",
    });
    const page = (await (await get("positions?limit=1")).json()) as { data: EarnPositionsResponse };
    expect(page.data.positions).toEqual([
      expect.objectContaining({ id: first.id, source: { walletId } }),
    ]);
    expect(page.data.hasMore).toBe(true);
    const next = (await (
      await get(`positions?limit=1&before=${encodeURIComponent(page.data.nextCursor ?? "")}`)
    ).json()) as { data: EarnPositionsResponse };
    expect(next.data.positions.map((position) => position.id)).toEqual([second.id]);
    expect(next.data.hasMore).toBe(false);
  });

  it("summarizes the complete scope with one hydration, preserving unknown totals", async () => {
    await seedPosition({ reference: "known" });
    await seedPosition({ reference: "unavailable" });
    readVaultPositions.mockImplementation(
      async (_runtime: unknown, input: { owner: string }): Promise<EarnVaultPositionSnapshot[]> => [
        {
          owner: input.owner,
          providerReference: "known",
          cluster: "devnet",
          tokenMint: TOKEN,
          shareMint: SHARE,
          shares: "2",
          withdrawableShares: "2",
          tokenValue: "10",
        },
      ]
    );
    const response = await get(
      "positions?ownerKind=external&limit=1&includeSummary=true&includeOwnerAddresses=true&includePositions=true"
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: EarnPositionsResponse };
    expect(body.data.positions).toHaveLength(1);
    expect(body.data.hasMore).toBe(true);
    expect(body.data.summary).toMatchObject({
      positionCount: 2,
      unavailablePositionCount: 1,
      totalsByToken: [{ tokenMint: TOKEN, unavailablePositionCount: 1 }],
    });
    expect(body.data.summary?.totalsByToken[0]).not.toHaveProperty("tokenValue");
    expect(body.data.summary?.totalsByStrategy).toHaveLength(2);
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
  });

  it("refuses unreadable custody wallets before provider reads", async () => {
    await seedWallet();
    const response = await get("positions?walletId=cwlt_other_project");
    expect(response.status).toBe(404);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("rejects sibling-project movement floors before chain reads", async () => {
    const sibling = await seedPosition({
      reference: "sibling",
      projectId: "prj_core_reads_production",
    });
    const response = await get(
      `positions?ownerKind=external&afterMovementIds=${sibling.movementId}`
    );
    expect(response.status).toBe(404);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("does not double-count one physical holding represented by both owner shapes", async () => {
    const walletId = await seedWallet();
    await seedPosition({ reference: "same-holding", walletId });
    await seedPosition({ reference: "same-holding" });
    const body = (await (await get("positions?includeSummary=true")).json()) as {
      data: EarnPositionsResponse;
    };
    expect(body.data.positions).toHaveLength(2);
    expect(body.data.summary).toMatchObject({
      positionCount: 1,
      totalsByToken: [{ tokenValue: "10" }],
    });
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
  });

  it("discovers verified existing holdings without persisting claims or inventing dates", async () => {
    const strategy = await seedStrategy("outside-sdp");
    const response = await get(
      `positions?ownerAddress=${OWNER}&discover=true&includeSummary=true&includeOwnerAddresses=true&includePositions=true`
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: EarnPositionsResponse };
    expect(body.data.positions).toHaveLength(1);
    const position = body.data.positions[0];
    expect(position).toMatchObject({
      strategyId: strategy.id,
      discovered: true,
      createdAt: null,
      source: { ownerAddress: OWNER },
      tokenValue: "10",
    });
    expect(parseDiscoveredEarnPositionLocator(position?.id ?? "")).toEqual({
      strategyId: strategy.id,
      source: { ownerAddress: OWNER },
    });
    expect(body.data.summary?.totalsByStrategy[0]?.positions?.[0]).toMatchObject({
      createdAt: null,
      discovered: true,
    });
    expect(
      await getDb(env).prepare("SELECT COUNT(*)::int AS count FROM earn_positions").first()
    ).toEqual({ count: 0 });
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
    expect(readVaultPositions.mock.calls[0]?.[1].providerReferences).toEqual([]);
  });

  it("keeps discovered selectors when the strategy is delisted and does not leak another project's history", async () => {
    const strategy = await seedStrategy("retained-strategy", { status: "deprecated" });
    await seedPosition({ reference: "retained-strategy", projectId: "prj_core_reads_production" });
    const body = (await (await get(`positions?ownerAddress=${OWNER}&discover=true`)).json()) as {
      data: EarnPositionsResponse;
    };
    expect(body.data.positions).toEqual([
      expect.objectContaining({
        id: encodeDiscoveredEarnPositionLocator({
          strategyId: strategy.id,
          source: { ownerAddress: OWNER },
        }),
        discovered: true,
      }),
    ]);
    expect(
      await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM earn_positions WHERE project_id = ?")
        .bind(tenant.project.id)
        .first()
    ).toEqual({ count: 0 });
  });

  it("does not report unreadable discovered holdings as zero or as stored positions", async () => {
    await seedStrategy("unreadable-strategy");
    readVaultPositions.mockRejectedValue(new Error("Provider discovery unavailable"));
    const body = (await (await get(`positions?ownerAddress=${OWNER}&discover=true`)).json()) as {
      data: EarnPositionsResponse;
    };
    expect(body.data.positions).toEqual([]);
    expect(body.data.discovery).toEqual({ strategyCount: 1, unavailableStrategyCount: 1 });
  });

  it("rejects malformed selectors, oversized selectors and conflicting embedded sources", () => {
    const locator = encodeDiscoveredEarnPositionLocator({
      strategyId: "strategy",
      source: { ownerAddress: OWNER },
    });
    expect(parseDiscoveredEarnPositionLocator(locator)).toEqual({
      strategyId: "strategy",
      source: { ownerAddress: OWNER },
    });
    expect(parseDiscoveredEarnPositionLocator(`${locator}!`)).toBeNull();
    expect(parseDiscoveredEarnPositionLocator(`earn_discovered_${"a".repeat(1024)}`)).toBeNull();
    const conflicting = Buffer.from(
      JSON.stringify({
        strategyId: "strategy",
        source: { ownerAddress: OWNER, walletId: "wallet" },
      })
    ).toString("base64url");
    expect(parseDiscoveredEarnPositionLocator(`earn_discovered_${conflicting}`)).toBeNull();
  });

  it("claims a signed-discovered holding without fabricating deposits or cost basis", async () => {
    const strategy = await seedStrategy("signed-existing");
    const row = await getDb(env).transaction((tx) =>
      claimDiscoveredStrategyPosition(
        {
          organizationId: tenant.org.id,
          projectId: tenant.project.id,
          environment: "sandbox",
          provider: "veda",
          strategyId: strategy.id,
          strategyReference: strategy.provider_reference,
          tokenMint: TOKEN,
          shareMint: SHARE,
          label: strategy.name,
          source: { ownerAddress: OWNER },
        },
        tx
      )
    );
    expect(row).toMatchObject({
      strategy_id: strategy.id,
      strategy_reference: "signed-existing",
      vault_address: "signed-existing",
      owner_address: OWNER,
      project_id: tenant.project.id,
      cost_basis_known: false,
    });
    expect(
      await getDb(env).prepare("SELECT COUNT(*)::int AS count FROM earn_movements").first()
    ).toEqual({ count: 0 });
  });

  it("does not invent acquisition cost when a discovered holding later receives an SDP deposit", async () => {
    const strategy = await seedStrategy("custody-existing");
    const walletId = await seedWallet();
    const position = await getDb(env).transaction((tx) =>
      claimDiscoveredStrategyPosition(
        {
          organizationId: tenant.org.id,
          projectId: tenant.project.id,
          environment: "sandbox",
          provider: "veda",
          strategyId: strategy.id,
          strategyReference: strategy.provider_reference,
          tokenMint: TOKEN,
          shareMint: SHARE,
          label: strategy.name,
          source: { walletId },
        },
        tx
      )
    );
    const result = await createPostgresEarnMovementsRepository(
      getDb(env)
    ).createSignedVaultDepositIntent({
      organizationId: tenant.org.id,
      projectId: tenant.project.id,
      environment: "sandbox",
      provider: "veda",
      vaultAddress: strategy.provider_reference,
      custodyWalletId: walletId,
      tokenMint: TOKEN,
      shareMint: SHARE,
      label: strategy.name,
      requestedAmount: "1",
      sourceAddress: OWNER,
      signature: "signed_later_deposit",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      requestId: "later-deposit",
      idempotencyFingerprint: "later-deposit-fingerprint",
    });
    expect(result.position).toMatchObject({ id: position.id, cost_basis_known: false });
    const response = (await (
      await get(`positions?walletId=${walletId}&includeSummary=true`)
    ).json()) as {
      data: EarnPositionsResponse;
    };
    expect(response.data.positions[0]).toMatchObject({ id: position.id, costBasisKnown: false });
    expect(response.data.summary).toMatchObject({
      costBasisCoverage: "unknown",
      unknownCostBasisPositionCount: 1,
    });
  });

  it("rejects a signed claim whose strategy metadata disagrees and rolls it back", async () => {
    const strategy = await seedStrategy("correct-reference");
    await expect(
      getDb(env).transaction((tx) =>
        claimDiscoveredStrategyPosition(
          {
            organizationId: tenant.org.id,
            projectId: tenant.project.id,
            environment: "sandbox",
            provider: "veda",
            strategyId: strategy.id,
            strategyReference: "wrong-reference",
            tokenMint: TOKEN,
            shareMint: SHARE,
            label: strategy.name,
            source: { ownerAddress: OWNER },
          },
          tx
        )
      )
    ).rejects.toThrow("Position strategy identity");
    expect(
      await getDb(env).prepare("SELECT COUNT(*)::int AS count FROM earn_positions").first()
    ).toEqual({ count: 0 });
  });

  it("keeps legacy and canonical strategy reference writers compatible without changing order references", async () => {
    const holding = await seedPosition({ reference: "original-reference" });
    await getDb(env)
      .prepare("UPDATE earn_movements SET provider_reference = ? WHERE id = ?")
      .bind("provider-order-123", holding.movementId)
      .run();
    expect(
      await getDb(env)
        .prepare("SELECT strategy_reference, provider_reference FROM earn_movements WHERE id = ?")
        .bind(holding.movementId)
        .first()
    ).toEqual({
      strategy_reference: "original-reference",
      provider_reference: "provider-order-123",
    });
    await expect(
      getDb(env)
        .prepare("UPDATE earn_positions SET strategy_reference = ? WHERE id = ?")
        .bind("canonical-reference", holding.id)
        .run()
    ).rejects.toMatchObject({ code: "23503" });
    // Only an unreferenced fixture can change identity: the compatibility
    // trigger must preserve the ledger's existing compound foreign key.
    await getDb(env)
      .prepare("DELETE FROM earn_movements WHERE id = ?")
      .bind(holding.movementId)
      .run();
    await getDb(env)
      .prepare("UPDATE earn_positions SET strategy_reference = ? WHERE id = ?")
      .bind("canonical-reference", holding.id)
      .run();
    expect(
      await getDb(env)
        .prepare("SELECT strategy_reference, vault_address FROM earn_positions WHERE id = ?")
        .bind(holding.id)
        .first()
    ).toEqual({ strategy_reference: "canonical-reference", vault_address: "canonical-reference" });
    await getDb(env)
      .prepare("UPDATE earn_positions SET vault_address = ? WHERE id = ?")
      .bind("legacy-reference", holding.id)
      .run();
    expect(
      await getDb(env)
        .prepare("SELECT strategy_reference, vault_address FROM earn_positions WHERE id = ?")
        .bind(holding.id)
        .first()
    ).toEqual({ strategy_reference: "legacy-reference", vault_address: "legacy-reference" });
  });
});
