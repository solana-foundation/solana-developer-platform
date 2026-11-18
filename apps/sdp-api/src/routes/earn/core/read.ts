import {
  supportsVaultDirect,
  supportsVaultParRedemption,
  supportsVaultQueuedWithdraw,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import { currentClusterScope } from "@sdp/rpc/scope";
import { isEarnVaultHoldingEmpty } from "@sdp/types/earn";
import type {
  EarnCorePosition,
  EarnCorePositionSummary,
  EarnCoreStrategy,
  EarnDiscoveryResponse,
  EarnPositionsResponse,
} from "@sdp/types/earn-core";
import type { z } from "zod";
import { getDb } from "@/db/client";
import {
  createPostgresEarnMovementsRepository,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, internalError, notFound } from "@/lib/errors";
import { isEarnVaultSponsorshipEnabled } from "@/lib/feature-flags";
import { decodeKeysetCursor } from "@/lib/keyset-cursor";
import { success } from "@/lib/response";
import type { AppContext } from "@/routes/earn/context";
import { getEarnRepository } from "@/routes/earn/context";
import { parseQuery } from "@/routes/earn/handlers/shared";
import {
  isEarnStrategyInExecutionShelf,
  mapToEarnStrategy,
  readEarnStrategyPage,
} from "@/routes/earn/handlers/strategies";
import { listReadableEarnVaultWallets } from "@/routes/earn/handlers/vault";
import {
  decodeVaultPositionCursor,
  encodeVaultPositionCursor,
  type VaultPositionCursor,
} from "@/routes/earn/handlers/vault-position-cursor";
import {
  closeEmptyHydratedPositions,
  type HydratedVaultPositionValue,
  hydrateVaultPositions,
  markVaultPositionRowsRead,
  vaultPositionDiscoveryScope,
} from "@/routes/earn/handlers/vault-position-hydration";
import {
  collectAllWalletPositionRows,
  summarizeWalletPositions,
  type WalletHolding,
} from "@/routes/earn/handlers/wallet";
import {
  isEarnDirectWithdrawalConfigured,
  resolveEarnExecutionClient,
} from "@/services/earn/execution-registry";
import { resolveVaultBalanceReadContext } from "@/services/earn/vault-balance-read-context";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import { parseDiscoveredEarnPositionLocator } from "./discovered-position";
import { buildDiscoveredEarnPositionRows } from "./position-discovery";
import { earnDiscoveryQuerySchema, earnPositionsQuerySchema } from "./read-schemas";

/** The validated ingested strategy catalogue, without provider I/O. */
export async function readEarnDiscovery(
  c: AppContext,
  query: z.output<typeof earnDiscoveryQuerySchema>
): Promise<EarnDiscoveryResponse> {
  const { rows, total, environment } = await readEarnStrategyPage(c, query, {
    includeCatalogueOnly: true,
  });
  const capabilities = new Map<string, EarnCoreStrategy["capabilities"]>();
  const deadline = createVaultDeadline();
  return {
    strategies: rows.map((row) => {
      let capability = capabilities.get(row.provider);
      if (!capability) {
        // Client construction is I/O-free. Resolve once per provider, not row.
        const client = resolveEarnExecutionClient(c.env, row.provider, deadline);
        capability = {
          deposit: client !== null && supportsVaultDirect(client),
          withdraw:
            client !== null &&
            ((isEarnDirectWithdrawalConfigured(c.env, row.provider) &&
              supportsVaultWithdraw(client)) ||
              supportsVaultQueuedWithdraw(client) ||
              supportsVaultParRedemption(client)),
          admission: "evaluated_on_prepare",
        };
        capabilities.set(row.provider, capability);
      }
      return {
        ...mapToEarnStrategy(row, environment, c.env),
        rate: {
          value: row.current_apy,
          measure: "apy",
          basis: "provider_reported",
          observedAt: row.rate_observed_at ?? null,
          source: { provider: row.provider, providerReference: row.provider_reference },
        },
        capabilities: {
          ...capability,
          deposit: capability.deposit && isEarnStrategyInExecutionShelf(row),
          depositUnavailableReason: !isEarnStrategyInExecutionShelf(row)
            ? "catalogue_only"
            : !capability.deposit
              ? "adapter_unavailable"
              : undefined,
        },
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** GET /v1/earn/discovery. */
export async function listEarnDiscovery(c: AppContext) {
  return success(c, await readEarnDiscovery(c, parseQuery(c, earnDiscoveryQuerySchema)));
}

function newestFirst(left: EarnPositionRow, right: EarnPositionRow): number {
  return right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id);
}

function positionCursor(value: string, discover: boolean | undefined): VaultPositionCursor | null {
  const durable = decodeVaultPositionCursor(value);
  if (durable || !discover) return durable;
  const decoded = decodeKeysetCursor(value);
  if (
    !decoded ||
    !parseDiscoveredEarnPositionLocator(decoded.id) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(decoded.value) ||
    !Number.isFinite(Date.parse(decoded.value))
  )
    return null;
  return { createdAt: decoded.value, id: decoded.id };
}

/** Merge independently scoped sources before applying their shared page limit. */
export function mergeEarnPositionPages(
  pages: readonly { rows: EarnPositionRow[]; hasMore: boolean }[],
  limit: number
) {
  const rows = pages.flatMap((page) => page.rows).sort(newestFirst);
  return {
    rows: rows.slice(0, limit),
    hasMore: pages.some((page) => page.hasMore) || rows.length > limit,
  };
}

function positionSummary(
  holdings: readonly WalletHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>,
  discoveredIds: ReadonlySet<string>,
  observedIds: ReadonlySet<string>,
  query: z.output<typeof earnPositionsQuerySchema>
): EarnCorePositionSummary | undefined {
  if (!query.includeSummary) return undefined;
  // Historical wallet-ID and owner-address claims can name one physical holding.
  const unique = new Map<string, WalletHolding>();
  for (const holding of holdings) {
    if (discoveredIds.has(holding.id) && !observedIds.has(holding.id)) continue;
    const identity = JSON.stringify([
      holding.ownerAddress,
      holding.provider,
      holding.vaultAddress,
      holding.tokenMint,
      holding.shareMint,
    ]);
    const existing = unique.get(identity);
    if (!existing) unique.set(identity, holding);
    else if (holding.costBasisKnown === false) existing.costBasisKnown = false;
  }
  const summary = summarizeWalletPositions([...unique.values()], live, {
    includeOwnerAddresses: query.includeOwnerAddresses ?? false,
    includePositions: query.includePositions ?? false,
  });
  return {
    ...summary,
    costBasisCoverage: [...unique.values()].some((holding) => holding.costBasisKnown === false)
      ? "unknown"
      : "complete",
    unknownCostBasisPositionCount: [...unique.values()].filter(
      (holding) => holding.costBasisKnown === false
    ).length,
    totalsByStrategy: summary.totalsByStrategy.map((strategy) => ({
      ...strategy,
      positions: strategy.positions?.map((position) =>
        discoveredIds.has(position.id)
          ? { ...position, createdAt: null, discovered: true }
          : position
      ),
    })),
  };
}

/**
 * Read tracked holdings with the existing wallet and exact-project boundaries.
 * Summaries scan the complete selected scope and share this one hydration.
 */
export async function readEarnPositions(
  c: AppContext,
  query: z.output<typeof earnPositionsQuerySchema>
): Promise<EarnPositionsResponse> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { environment, cluster } = currentClusterScope();
  const before = query.before ? positionCursor(query.before, query.discover) : null;
  if (query.before && !before) throw badRequest("Invalid Earn position pagination cursor");
  const includeCustody = query.sourceType !== "address" && query.ownerAddress === undefined;
  const includeAddress = query.sourceType !== "wallet" && query.walletId === undefined;
  const allWallets = includeCustody ? await listReadableEarnVaultWallets(c, auth, projectId) : [];
  const wallets = query.walletId
    ? allWallets.filter((wallet) => wallet.id === query.walletId)
    : allWallets;
  if (query.walletId && wallets.length === 0) throw notFound("Earn wallet");
  const custodyWalletIds = wallets.map((wallet) => wallet.id);
  const balanceContext = await resolveVaultBalanceReadContext(c.env, {
    movementIds: query.afterMovementIds?.split(",") ?? [],
    organizationId: auth.organizationId,
    projectId,
    custodyWalletIds,
    includeAddress,
    ownerAddress: query.ownerAddress,
  });
  const repo = createPostgresEarnMovementsRepository(getDb(c.env));
  const scope = { organizationId: auth.organizationId, environment };
  const readPage = async (cursor: VaultPositionCursor | null, limit: number) => {
    const pages = await Promise.all([
      custodyWalletIds.length > 0
        ? repo.listVaultPositions({ ...scope, custodyWalletIds, before: cursor, limit })
        : Promise.resolve({ rows: [], hasMore: false }),
      includeAddress
        ? repo.listWalletPositions({
            ...scope,
            projectId,
            ownerAddress: query.ownerAddress,
            before: cursor,
            limit,
          })
        : Promise.resolve({ rows: [], hasMore: false }),
    ]);
    return mergeEarnPositionPages(pages, limit);
  };
  const page =
    query.includeSummary || query.discover
      ? {
          rows: await collectAllWalletPositionRows((cursor) => readPage(cursor, 100)),
          hasMore: false,
        }
      : await readPage(before, query.limit);
  // Retained catalogue metadata gives discovered selectors a stable instrument
  // identity; deprecated strategies remain readable for existing holdings.
  const strategies = await getEarnRepository(c).listShareMintedStrategies({
    environment,
    hostCluster: cluster,
  });
  const discoverySource = query.walletId
    ? { walletId: query.walletId }
    : query.ownerAddress
      ? { ownerAddress: query.ownerAddress }
      : null;
  const discoveredRows =
    query.discover && discoverySource
      ? buildDiscoveredEarnPositionRows(
          strategies,
          {
            source: discoverySource,
            organizationId: auth.organizationId,
            projectId,
            environment,
          },
          page.rows
        )
      : [];
  const discoveredIds = new Set(discoveredRows.map((row) => row.id));
  const candidateRows = [...page.rows, ...discoveredRows].sort(newestFirst);
  const rowsReadAt = markVaultPositionRowsRead();
  const addresses = new Map(wallets.map((wallet) => [wallet.id, wallet.publicKey]));
  const holdings: WalletHolding[] = candidateRows.map((row) => {
    const ownerAddress = row.custody_wallet_id
      ? addresses.get(row.custody_wallet_id)
      : row.owner_address;
    if (!ownerAddress || !row.vault_address || !row.token_mint || !row.share_mint)
      throw internalError("Earn position is missing its instrument identity");
    return {
      id: row.id,
      provider: row.provider,
      vaultAddress: row.vault_address,
      label: row.label,
      ownerAddress,
      tokenMint: row.token_mint,
      shareMint: row.share_mint,
      shareAtaRentFunder: row.share_ata_rent_funder,
      costBasisKnown: row.cost_basis_known !== false,
      createdAt: row.created_at,
      closedAt: row.closed_at,
      updatedAt: row.updated_at,
    };
  });
  // Both owner shapes share provider batching and identity validation. The kind
  // affects telemetry only; no provider admission gate belongs on this read.
  const discoveryObservations = {
    completedScopes: new Set<string>(),
    rejectedPositionIds: new Set<string>(),
  };
  const live = await hydrateVaultPositions(
    c,
    holdings.map((holding) => ({
      id: holding.id,
      provider: holding.provider,
      providerReference: holding.vaultAddress,
      ownerAddress: holding.ownerAddress,
      tokenMint: holding.tokenMint,
      shareMint: holding.shareMint,
    })),
    {
      sourceType: includeAddress ? "address" : "wallet",
      rowsReadAt,
      minimumSlotByPositionId: balanceContext?.minimumSlotByPositionId,
      discoverAll: query.discover,
      discoveryObservations: query.discover ? discoveryObservations : undefined,
    }
  );
  await closeEmptyHydratedPositions(
    (positionId, observedUpdatedAt) =>
      repo.closeVaultPositionIfEmpty({
        positionId,
        organizationId: auth.organizationId,
        observedUpdatedAt,
      }),
    holdings.filter((holding) => !discoveredIds.has(holding.id)),
    live
  );
  // One DB lookup for stable strategy IDs, including delisted metadata. Missing
  // catalogue entries never hide a position or prevent an exit.
  const strategyIds = new Map(
    strategies.flatMap((strategy) =>
      strategy.deposit_mints.map(
        (mint) =>
          [
            JSON.stringify([
              strategy.provider,
              strategy.provider_reference,
              strategy.share_mint,
              mint,
            ]),
            strategy.id,
          ] as const
      )
    )
  );
  const holdingsById = new Map(holdings.map((holding) => [holding.id, holding]));
  const observedRows = candidateRows.filter((row) => {
    if (!discoveredIds.has(row.id)) return true;
    const observed = live.get(row.id);
    return observed !== undefined && !isEarnVaultHoldingEmpty(observed);
  });
  const observedIds = new Set(observedRows.map((row) => row.id));
  const eligible =
    query.includeSummary || query.discover
      ? observedRows.filter(
          (row) =>
            before === null ||
            row.created_at < before.createdAt ||
            (row.created_at === before.createdAt && row.id < before.id)
        )
      : observedRows;
  const visible = eligible.slice(0, query.limit);
  const hasMore = page.hasMore || eligible.length > query.limit;
  const feeSponsored = isEarnVaultSponsorshipEnabled(c.env, cluster);
  const positions: EarnCorePosition[] = visible.map((row) => {
    const holding = holdingsById.get(row.id);
    if (!holding) throw internalError("Earn position is missing its instrument identity");
    const hydrated = live.get(row.id);
    return {
      id: row.id,
      source: row.custody_wallet_id
        ? { walletId: row.custody_wallet_id }
        : { ownerAddress: holding.ownerAddress },
      strategyId:
        row.strategy_id ??
        strategyIds.get(
          JSON.stringify([row.provider, holding.vaultAddress, holding.shareMint, holding.tokenMint])
        ),
      provider: row.provider,
      providerReference: holding.vaultAddress,
      label: row.label,
      tokenMint: holding.tokenMint,
      shareMint: holding.shareMint,
      createdAt: discoveredIds.has(row.id) ? null : row.created_at,
      discovered: discoveredIds.has(row.id) || undefined,
      costBasisKnown: row.cost_basis_known !== false,
      closedAt: row.closed_at,
      feeSponsored: row.custody_wallet_id !== null && feeSponsored,
      shares: hydrated?.shares,
      withdrawableShares: hydrated?.withdrawableShares,
      unlockTimestamp: hydrated?.unlockTimestamp,
      tokenValue: hydrated?.tokenValue,
      parIntermediate: hydrated?.parIntermediate,
    };
  });
  const last = visible.at(-1);
  return {
    positions,
    hasMore,
    nextCursor: hasMore && last ? encodeVaultPositionCursor(last.created_at, last.id) : null,
    balanceReadContext: balanceContext
      ? {
          afterMovementIds: balanceContext.afterMovementIds,
          minimumSlot: balanceContext.minimumSlot,
        }
      : undefined,
    summary: positionSummary(holdings, live, discoveredIds, observedIds, query),
    coverage: query.discover ? "integrated_catalogue_positions" : "sdp_tracked_positions",
    discovery: query.discover
      ? {
          strategyCount: strategies.length,
          unavailableStrategyCount: discoveredRows.filter((row) => {
            const holding = holdingsById.get(row.id);
            return (
              !holding ||
              discoveryObservations.rejectedPositionIds.has(row.id) ||
              !discoveryObservations.completedScopes.has(
                vaultPositionDiscoveryScope(row.provider, holding.ownerAddress)
              )
            );
          }).length,
        }
      : undefined,
  };
}

/** GET /v1/earn/positions. */
export async function listEarnPositions(c: AppContext) {
  return success(c, await readEarnPositions(c, parseQuery(c, earnPositionsQuerySchema)));
}
