import { createHash } from "node:crypto";
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
  decodeVaultPositionCursor,
  encodeVaultPositionCursor,
  type VaultPositionCursor,
} from "@/routes/earn/handlers/vault-position-cursor";
import {
  type HydratedVaultPositionValue,
  vaultPositionDiscoveryScope,
} from "@/routes/earn/handlers/vault-position-hydration";
import {
  collectAllEarnPositionRows,
  type EarnPositionHolding,
  summarizeEarnPositions,
} from "@/routes/earn/position-summary";
import {
  isEarnStrategyInExecutionShelf,
  mapToEarnStrategy,
  readEarnStrategyPage,
} from "@/routes/earn/strategy-catalogue";
import { listReadableEarnWallets } from "@/routes/earn/wallet-scope";
import { earnProviderEndpointUrls } from "@/services/earn/cluster-rpc";
import {
  isEarnDirectWithdrawalConfigured,
  resolveEarnExecutionClient,
} from "@/services/earn/execution-registry";
import { resolveVaultBalanceReadContext } from "@/services/earn/vault-balance-read-context";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import type { Env } from "@/types/env";
import { parseDiscoveredEarnPositionLocator } from "./discovered-position";
import { buildDiscoveredEarnPositionRows } from "./position-discovery";
import {
  earnStrategyIdsByInstrument,
  hydrateEarnPositionRows,
  projectEarnCorePosition,
} from "./position-hydration";
import { earnDiscoveryQuerySchema, earnPositionsQuerySchema } from "./read-schemas";

/** Why a catalogue row takes no new deposits: retained for discovery, or no adapter can build one. */
function depositUnavailableReason(
  row: Parameters<typeof isEarnStrategyInExecutionShelf>[0],
  capability: Pick<EarnCoreStrategy["capabilities"], "deposit">
): EarnCoreStrategy["capabilities"]["depositUnavailableReason"] {
  if (!isEarnStrategyInExecutionShelf(row)) return "catalogue_only";
  if (!capability.deposit) return "adapter_unavailable";
  return undefined;
}

/** The one source a positions read discovers holdings for, when it names one. */
function discoverySourceOf(
  query: Pick<z.output<typeof earnPositionsQuerySchema>, "walletId" | "ownerAddress">
): { walletId: string } | { ownerAddress: string } | null {
  if (query.walletId) return { walletId: query.walletId };
  if (query.ownerAddress) return { ownerAddress: query.ownerAddress };
  return null;
}

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
          depositUnavailableReason: depositUnavailableReason(row, capability),
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
  holdings: readonly EarnPositionHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>,
  discoveredIds: ReadonlySet<string>,
  observedIds: ReadonlySet<string>,
  query: z.output<typeof earnPositionsQuerySchema>
): EarnCorePositionSummary | undefined {
  if (!query.includeSummary) return undefined;
  // Historical wallet-ID and owner-address claims can name one physical holding.
  const unique = new Map<string, EarnPositionHolding>();
  for (const holding of holdings) {
    if (discoveredIds.has(holding.id) && !observedIds.has(holding.id)) continue;
    const identity = JSON.stringify([
      holding.ownerAddress,
      holding.provider,
      holding.providerReference,
      holding.tokenMint,
      holding.shareMint,
    ]);
    const existing = unique.get(identity);
    if (!existing) unique.set(identity, holding);
    else if (holding.costBasisKnown === false) existing.costBasisKnown = false;
  }
  const summary = summarizeEarnPositions([...unique.values()], live, {
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

const MAX_IN_FLIGHT_POSITION_SUMMARIES = 256;
const inFlightPositionSummaries = new WeakMap<Env, Map<string, Promise<EarnPositionsResponse>>>();
type ReadableWallets = Awaited<ReturnType<typeof listReadableEarnWallets>>;

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
  const allWallets = includeCustody ? await listReadableEarnWallets(c, auth, projectId) : [];
  const wallets = query.walletId
    ? allWallets.filter((wallet) => wallet.id === query.walletId)
    : allWallets;
  if (query.walletId && wallets.length === 0) throw notFound("Earn wallet");
  // Authorize each caller before joining. A confirmation-aware refresh keeps
  // its own provider read and observed-slot floor.
  if (!query.includeSummary || query.afterMovementIds !== undefined) {
    return loadEarnPositions(c, query, wallets, before);
  }
  const key = JSON.stringify([
    auth.organizationId,
    projectId,
    environment,
    auth.walletAccess,
    createHash("sha256")
      .update(JSON.stringify(earnProviderEndpointUrls(cluster)))
      .digest("hex"),
    query,
    wallets
      .map(({ id, publicKey }) => [id, publicKey] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    isEarnVaultSponsorshipEnabled(c.env, cluster),
  ]);
  let reads = inFlightPositionSummaries.get(c.env);
  if (!reads) {
    reads = new Map();
    inFlightPositionSummaries.set(c.env, reads);
  }
  const existing = reads.get(key);
  if (existing) return existing;
  const read = loadEarnPositions(c, query, wallets, before);
  if (reads.size >= MAX_IN_FLIGHT_POSITION_SUMMARIES) return read;
  reads.set(key, read);
  const clear = () => {
    if (reads.get(key) === read) reads.delete(key);
  };
  void read.then(clear, clear);
  return read;
}

async function loadEarnPositions(
  c: AppContext,
  query: z.output<typeof earnPositionsQuerySchema>,
  wallets: ReadableWallets,
  before: VaultPositionCursor | null
): Promise<EarnPositionsResponse> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { environment, cluster } = currentClusterScope();
  const includeAddress = query.sourceType !== "wallet" && query.walletId === undefined;
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
  let page =
    query.includeSummary || query.discover
      ? {
          rows: await collectAllEarnPositionRows((cursor) => readPage(cursor, 100)),
          hasMore: false,
        }
      : await readPage(before, query.limit);
  // Retained catalogue metadata gives discovered selectors a stable instrument
  // identity; deprecated strategies remain readable for existing holdings.
  const strategies = await getEarnRepository(c).listShareMintedStrategies({
    environment,
    hostCluster: cluster,
  });
  const discoverySource = discoverySourceOf(query);
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
  const addresses = new Map(wallets.map((wallet) => [wallet.id, wallet.publicKey]));
  const discoveryObservations = {
    completedScopes: new Set<string>(),
    rejectedPositionIds: new Set<string>(),
  };
  const hydrate = (rows: readonly EarnPositionRow[]) =>
    hydrateEarnPositionRows(c, rows, addresses, {
      sourceType: includeAddress ? "address" : "wallet",
      minimumSlotByPositionId: balanceContext?.minimumSlotByPositionId,
      discoveredIds,
      discoverAll: query.discover,
      discoveryObservations: query.discover ? discoveryObservations : undefined,
    });
  const { holdings, live, closedPositionIds } = await hydrate(candidateRows);
  const observedRows = candidateRows.filter((row) => {
    if (closedPositionIds.has(row.id)) return false;
    if (!discoveredIds.has(row.id)) return true;
    const observed = live.get(row.id);
    return observed !== undefined && !isEarnVaultHoldingEmpty(observed);
  });
  // A closure can empty a selected page. Advance past scanned rows and read
  // a full batch of unseen holdings to avoid one-at-a-time closure reads.
  while (page.hasMore && observedRows.length < query.limit) {
    const lastScanned = page.rows.at(-1);
    if (!lastScanned) throw internalError("Earn position page has no continuation row");
    page = await readPage({ createdAt: lastScanned.created_at, id: lastScanned.id }, query.limit);
    const next = await hydrate(page.rows);
    holdings.push(...next.holdings);
    for (const [id, value] of next.live) live.set(id, value);
    observedRows.push(...page.rows.filter((row) => !next.closedPositionIds.has(row.id)));
  }
  const strategyIds = earnStrategyIdsByInstrument(strategies);
  const holdingsById = new Map(holdings.map((holding) => [holding.id, holding]));
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
    return projectEarnCorePosition(row, holding, live.get(row.id), {
      discovered: discoveredIds.has(row.id),
      feeSponsored,
      strategyIds,
    });
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
