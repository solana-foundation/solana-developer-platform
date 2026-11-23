import type { EarnVaultPositionSnapshot } from "@sdp/earn/types";
import { currentMinimumRpcSlot, observeRpcRead } from "@sdp/rpc/read-context";
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
import { installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { seedUnreadPrivyWallet } from "@/test/helpers/custody-connections";
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

const rpc = installClusterRpcStub();

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
  organizationId?: string;
  walletId?: string;
  projectId?: string;
  ownerAddress?: string;
  createdAt?: string;
  environment?: "sandbox" | "production";
}) {
  const id = generateEarnPositionId();
  const movementId = generateEarnMovementId();
  const projectId = input.projectId ?? tenant.project.id;
  const organizationId = input.organizationId ?? tenant.org.id;
  const ownerAddress = input.ownerAddress ?? OWNER;
  const environment = input.environment ?? "sandbox";
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO earn_positions (id, organization_id, project_id, environment, provider, kind, custody_wallet_id, owner_address, vault_address, share_mint, token_mint, label, activated_at, created_at) VALUES (?, ?, ?, ?, 'veda', 'vault_direct', ?, ?, ?, ?, ?, 'Strategy holding', sdp_iso_now(), ?)`
    )
    .bind(
      id,
      organizationId,
      projectId,
      environment,
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
      `INSERT INTO earn_movements (id, organization_id, project_id, environment, provider, execution_model, direction, position_id, status, denomination, amount_requested, custody_wallet_id, owner_address, vault_address, source_address, destination_address, signature, signed_transaction, last_valid_block_height, request_id, idempotency_fingerprint) VALUES (?, ?, ?, ?, 'veda', 'vault_direct', 'deposit', ?, 'requested', ?, '1', ?, ?, ?, ?, ?, ?, 'AQ==', '12345', ?, ?)`
    )
    .bind(
      movementId,
      organizationId,
      projectId,
      environment,
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

async function seedWallet(scope = { organizationId: tenant.org.id, projectId: tenant.project.id }) {
  const db = getDb(env);
  await db
    .prepare(
      "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status) VALUES ('cfg_core_read', ?, ?, 'privy', 'encrypted', 'active')"
    )
    .bind(scope.organizationId, scope.projectId)
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
      earnPositionsQuerySchema.safeParse({ ownerAddress: OWNER, sourceType: "wallet" }).success
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
  });

  it("keeps owner-address reads exact-project scoped", async () => {
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
      "positions?sourceType=address&limit=1&includeSummary=true&includeOwnerAddresses=true&includePositions=true"
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
      `positions?sourceType=address&afterMovementIds=${sibling.movementId}`
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

  it("resolves a selector that names a tracked holding without forgetting its cost basis", async () => {
    const strategy = await seedStrategy("tracked-reference");
    const holding = await seedPosition({ reference: "tracked-reference" });
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
    expect(row).toMatchObject({ id: holding.id, strategy_id: strategy.id, cost_basis_known: true });
  });

  it("keeps an imported holding listed and active after its first withdrawal fails", async () => {
    const strategy = await seedStrategy("imported-reference");
    const walletId = await seedWallet();
    const ledger = createPostgresEarnMovementsRepository(getDb(env));
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
    const { movement } = await ledger.createSignedVaultWithdrawalIntent({
      organizationId: tenant.org.id,
      projectId: tenant.project.id,
      environment: "sandbox",
      provider: "veda",
      positionId: position.id,
      vaultAddress: strategy.provider_reference,
      custodyWalletId: walletId,
      shareMint: SHARE,
      requestedShares: "1",
      walletAddress: OWNER,
      signature: "imported_failed_exit",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "12345",
      requestId: "imported-failed-exit",
      idempotencyFingerprint: "imported-failed-exit-fingerprint",
    });
    await ledger.advanceVaultMovement({
      movementId: movement.id,
      organizationId: tenant.org.id,
      toStatus: "failed",
      failureReason: "Transaction expired",
    });
    const tracked = await ledger.getReadablePositionByInstrument({
      organizationId: tenant.org.id,
      projectId: tenant.project.id,
      environment: "sandbox",
      provider: "veda",
      providerReference: strategy.provider_reference,
      tokenMint: TOKEN,
      shareMint: SHARE,
      source: { walletId },
    });
    expect(tracked).toMatchObject({ id: position.id, cost_basis_known: false });
    expect(tracked?.activated_at).not.toBeNull();
    const response = (await (await get(`positions?walletId=${walletId}`)).json()) as {
      data: EarnPositionsResponse;
    };
    expect(response.data.positions.map((listed) => listed.id)).toEqual([position.id]);
    expect(response.data.positions[0]).toMatchObject({ costBasisKnown: false });
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

describe("Earn position detail", () => {
  it("returns the list's canonical position with one targeted provider read", async () => {
    const position = await seedPosition({ reference: "target" });
    await seedPosition({ reference: "unrelated" });
    await seedStrategy("target");
    const page = (await (await get(`positions?ownerAddress=${OWNER}`)).json()) as {
      data: EarnPositionsResponse;
    };
    const listed = page.data.positions.find((candidate) => candidate.id === position.id);
    readVaultPositions.mockClear();
    const response = await get(`positions/${position.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: listed });
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
    expect(readVaultPositions.mock.calls[0]?.[1]).toEqual({
      owner: OWNER,
      providerReferences: ["target"],
    });
  });

  it("keeps missing, foreign-project and foreign-environment IDs private before RPC", async () => {
    const sibling = await seedPosition({
      reference: "sibling-detail",
      projectId: "prj_core_reads_production",
    });
    const production = await seedPosition({
      reference: "production-detail",
      projectId: "prj_core_reads_production",
      environment: "production",
    });
    for (const id of ["absent", sibling.id, production.id]) {
      const response = await get(`positions/${id}`);
      expect(response.status).toBe(404);
    }
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("requires earn.read before a detail can reach provider I/O", async () => {
    const position = await seedPosition({ reference: "read-grant" });
    key = await seedEarnApiKey(env, tenant, {
      id: "detail_without_read",
      grants: [],
      environment: "sandbox",
    });
    expect((await get(`positions/${position.id}`)).status).toBe(403);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("does not expose an unsigned preparation as a holding", async () => {
    const position = await seedPosition({ reference: "not-activated" });
    await getDb(env).execute("UPDATE earn_positions SET activated_at = NULL WHERE id = ?", [
      position.id,
    ]);
    expect((await get(`positions/${position.id}`)).status).toBe(404);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("uses project wallet read visibility even when the key has no signing wallets", async () => {
    const walletId = await seedWallet();
    const position = await seedPosition({ reference: "wallet-read", walletId });
    await getDb(env).execute("UPDATE api_keys SET wallet_scope = 'selected' WHERE id = ?", [
      key.id,
    ]);
    const response = await get(`positions/${position.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { source: { walletId } } });
  });

  it("refuses a custody holding owned by another organization before provider I/O", async () => {
    const foreign = await seedEarnAuthzTenant(env, "foreign_detail", { environment: "sandbox" });
    const walletId = await seedWallet({
      organizationId: foreign.org.id,
      projectId: foreign.project.id,
    });
    const position = await seedPosition({
      reference: "foreign-wallet",
      walletId,
      organizationId: foreign.org.id,
      projectId: foreign.project.id,
    });
    expect((await get(`positions/${position.id}`)).status).toBe(404);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("refuses a sibling-project wallet despite legacy position attribution", async () => {
    const walletId = "cwlt_sibling_detail";
    await seedUnreadPrivyWallet(getDb(env), {
      organizationId: tenant.org.id,
      projectId: "prj_core_reads_production",
      createdBy: tenant.user.id,
      custodyWalletId: walletId,
      walletId: "privy_sibling_detail",
      publicKey: OWNER,
    });
    const position = await seedPosition({
      reference: "sibling-wallet",
      walletId,
      projectId: tenant.project.id,
    });
    expect((await get(`positions/${position.id}`)).status).toBe(404);
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("retains custody visibility when its historical position project stamp is null", async () => {
    const walletId = await seedWallet();
    const position = await seedPosition({ reference: "retained-wallet", walletId });
    await getDb(env).execute("UPDATE earn_positions SET project_id = NULL WHERE id = ?", [
      position.id,
    ]);
    const listed = await get(`positions?walletId=${walletId}`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      data: { positions: [expect.objectContaining({ id: position.id })] },
    });
    const response = await get(`positions/${position.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: position.id, source: { walletId } },
    });
  });

  it("keeps tracked values unavailable after a failed live read", async () => {
    const position = await seedPosition({ reference: "unavailable-detail" });
    readVaultPositions.mockRejectedValue(new Error("Provider unavailable"));
    const response = await get(`positions/${position.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBe(position.id);
    expect(body.data.shares).toBeUndefined();
    expect(body.data.tokenValue).toBeUndefined();
    expect(
      await getDb(env).queryOne("SELECT closed_at FROM earn_positions WHERE id = ?", [position.id])
    ).toEqual({ closed_at: null });
  });

  it("reads a discovered holding without importing it or fabricating acquisition history", async () => {
    const strategy = await seedStrategy("discovered-detail", { status: "deprecated" });
    const id = encodeDiscoveredEarnPositionLocator({
      strategyId: strategy.id,
      source: { ownerAddress: OWNER },
    });
    const response = await get(`positions/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        id,
        strategyId: strategy.id,
        discovered: true,
        createdAt: null,
        costBasisKnown: false,
        tokenValue: "10",
      },
    });
    expect(await getDb(env).queryOne("SELECT COUNT(*)::int AS count FROM earn_positions")).toEqual({
      count: 0,
    });
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
    expect(readVaultPositions.mock.calls[0]?.[1].providerReferences).toEqual(["discovered-detail"]);
  });

  it("rejects malformed or unreadable discovered selectors before provider I/O", async () => {
    const strategy = await seedStrategy("discovered-authority");
    const foreignWallet = encodeDiscoveredEarnPositionLocator({
      strategyId: strategy.id,
      source: { walletId: "cwlt_foreign" },
    });
    for (const id of ["earn_discovered_invalid", foreignWallet]) {
      expect((await get(`positions/${id}`)).status).toBe(404);
    }
    expect(readVaultPositions).not.toHaveBeenCalled();
  });

  it("distinguishes an unverified discovered holding from a proven empty one", async () => {
    const strategy = await seedStrategy("discovered-unknown");
    const id = encodeDiscoveredEarnPositionLocator({
      strategyId: strategy.id,
      source: { ownerAddress: OWNER },
    });
    readVaultPositions.mockRejectedValueOnce(new Error("Provider unavailable"));
    expect((await get(`positions/${id}`)).status).toBe(503);
    readVaultPositions.mockResolvedValueOnce([
      {
        owner: OWNER,
        providerReference: "discovered-unknown",
        cluster: "devnet",
        tokenMint: TOKEN,
        shareMint: SHARE,
        shares: "0",
        withdrawableShares: "0",
        tokenValue: "0",
      },
    ]);
    expect((await get(`positions/${id}`)).status).toBe(404);
    expect(await getDb(env).queryOne("SELECT COUNT(*)::int AS count FROM earn_positions")).toEqual({
      count: 0,
    });
  });

  it("retains a discovered intermediate holding when wallet shares are zero", async () => {
    const strategy = await seedStrategy("intermediate-detail");
    const id = encodeDiscoveredEarnPositionLocator({
      strategyId: strategy.id,
      source: { ownerAddress: OWNER },
    });
    readVaultPositions.mockResolvedValueOnce([
      {
        owner: OWNER,
        providerReference: "intermediate-detail",
        cluster: "devnet",
        tokenMint: TOKEN,
        shareMint: SHARE,
        shares: "0",
        withdrawableShares: "0",
        tokenValue: "0",
        parIntermediate: { mint: TOKEN, amount: "5", withdrawableAmount: "5", tokenValue: "5" },
      },
    ]);
    const response = await get(`positions/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { shares: "0", parIntermediate: { amount: "5" } },
    });
  });

  it("resolves a discovered selector to its tracked queue holding even at zero wallet shares", async () => {
    const strategy = await seedStrategy("queued-detail");
    const position = await seedPosition({ reference: "queued-detail" });
    await getDb(env).execute(
      "UPDATE earn_movements SET status = 'finalized', confirmed_at = sdp_iso_now(), settled_at = sdp_iso_now() WHERE id = ?",
      [position.movementId]
    );
    await getDb(env).execute(
      `INSERT INTO earn_vault_withdrawal_requests (
        id, organization_id, project_id, environment, provider, position_id,
        owner_address, vault_address, token_mint, share_mint, request_address,
        status, shares, quoted_assets, share_decimals, asset_decimals, discount_bps,
        maturity_timestamp, deadline_timestamp, client_request_id, idempotency_fingerprint,
        creation_signature)
       VALUES ('queued-detail-request', ?, ?, 'sandbox', 'veda', ?, ?, 'queued-detail', ?, ?,
         'queued-detail-address', 'pending', '2', '10', 6, 6, 0, 10, 20,
         'queued-detail-client', 'queued-detail-fingerprint', 'queued-detail-signature')`,
      [tenant.org.id, tenant.project.id, position.id, OWNER, TOKEN, SHARE]
    );
    readVaultPositions.mockResolvedValueOnce([
      {
        owner: OWNER,
        providerReference: "queued-detail",
        cluster: "devnet",
        tokenMint: TOKEN,
        shareMint: SHARE,
        shares: "0",
        withdrawableShares: "0",
        tokenValue: "0",
      },
    ]);
    const id = encodeDiscoveredEarnPositionLocator({
      strategyId: strategy.id,
      source: { ownerAddress: OWNER },
    });
    const response = await get(`positions/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { id: position.id, shares: "0", closedAt: null },
    });
    expect(
      await getDb(env).queryOne("SELECT closed_at FROM earn_positions WHERE id = ?", [position.id])
    ).toEqual({ closed_at: null });
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
  });

  it("applies a ledger confirmation floor to the same discovered instrument ID", async () => {
    const strategy = await seedStrategy("confirmed-detail");
    const position = await seedPosition({ reference: "confirmed-detail" });
    await getDb(env).execute("UPDATE earn_movements SET signature = ? WHERE id = ?", [
      "3".repeat(88),
      position.movementId,
    ]);
    await getDb(env).execute("UPDATE earn_positions SET activated_at = NULL WHERE id = ?", [
      position.id,
    ]);
    rpc.answer("getSignatureStatuses", {
      value: [{ slot: 103, confirmations: 0, confirmationStatus: "confirmed", err: null }],
    });
    const id = encodeDiscoveredEarnPositionLocator({
      strategyId: strategy.id,
      source: { ownerAddress: OWNER },
    });
    readVaultPositions.mockImplementationOnce(async () => {
      expect(currentMinimumRpcSlot()).toBe(103);
      observeRpcRead(
        { method: "getAccountInfo" },
        { result: { context: { slot: 103 }, value: null } }
      );
      return [
        {
          owner: OWNER,
          providerReference: "confirmed-detail",
          cluster: "devnet",
          tokenMint: TOKEN,
          shareMint: SHARE,
          shares: "2",
          withdrawableShares: "2",
          tokenValue: "10",
        },
      ];
    });
    const response = await get(`positions/${id}?afterMovementIds=${position.movementId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id, tokenValue: "10" } });
    expect(readVaultPositions).toHaveBeenCalledTimes(1);
  });

  it("refuses another instrument's movement floor before any chain reads", async () => {
    const position = await seedPosition({ reference: "detail-floor" });
    const other = await seedPosition({ reference: "other-floor" });
    expect(
      (await get(`positions/${position.id}?afterMovementIds=${other.movementId}`)).status
    ).toBe(404);
    expect(readVaultPositions).not.toHaveBeenCalled();
    expect(rpc.calls.filter((call) => call.method === "getSignatureStatuses")).toEqual([]);
  });
});
