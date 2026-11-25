import { currentClusterScope } from "@sdp/rpc/scope";
import { isEarnVaultHoldingEmpty } from "@sdp/types/earn";
import type { EarnCorePosition } from "@sdp/types/earn-core";
import { isAddress } from "@solana/kit";
import type { z } from "zod";
import { getDb } from "@/db/client";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import {
  createPostgresEarnMovementsRepository,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { getAuth, requireProjectId } from "@/lib/auth";
import { internalError, notFound, providerUnavailable } from "@/lib/errors";
import { isEarnVaultSponsorshipEnabled } from "@/lib/feature-flags";
import { success } from "@/lib/response";
import type { ValidatedContext } from "@/middleware/validate";
import { type AppContext, getEarnRepository } from "@/routes/earn/context";
import { parseQuery } from "@/routes/earn/handlers/shared";
import type { HydratedVaultPositionValue } from "@/routes/earn/handlers/vault-position-hydration";
import { listReadableEarnWallets } from "@/routes/earn/wallet-scope";
import { resolveVaultBalanceReadContext } from "@/services/earn/vault-balance-read-context";
import {
  DISCOVERED_EARN_POSITION_PREFIX,
  type DiscoveredEarnPositionLocator,
  parseDiscoveredEarnPositionLocator,
} from "./discovered-position";
import { discoveredEarnPositionRow } from "./position-discovery";
import {
  earnStrategyIdsByInstrument,
  hydrateEarnPositionRows,
  projectEarnCorePosition,
} from "./position-hydration";
import { type earnPositionParamsSchema, earnPositionQuerySchema } from "./read-schemas";

function positionSelector(positionId: string): DiscoveredEarnPositionLocator | null {
  if (!positionId.startsWith(DISCOVERED_EARN_POSITION_PREFIX)) return null;
  const selector = parseDiscoveredEarnPositionLocator(positionId);
  if (
    selector === null ||
    ("ownerAddress" in selector.source && !isAddress(selector.source.ownerAddress))
  )
    throw notFound("Earn position");
  return selector;
}

function requireDiscoveredHolding(value: HydratedVaultPositionValue | undefined): void {
  if (value === undefined) throw providerUnavailable("Earn position value is unavailable");
  if (isEarnVaultHoldingEmpty(value)) throw notFound("Earn position");
}

/** Read one authorized holding without scanning its owner's other positions. */
export async function readEarnPosition(
  c: AppContext,
  positionId: string,
  query: z.output<typeof earnPositionQuerySchema>
): Promise<EarnCorePosition> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const { environment, cluster } = currentClusterScope();
  const selector = positionSelector(positionId);
  let discovered = selector !== null;
  const wallets =
    selector && "ownerAddress" in selector.source
      ? []
      : await listReadableEarnWallets(c, auth, projectId);
  const addresses = new Map(wallets.map((wallet) => [wallet.id, wallet.publicKey]));
  const repository = createPostgresEarnMovementsRepository(getDb(c.env));
  const catalogue = getEarnRepository(c);
  const strategies: EarnStrategyRow[] = [];
  let row: EarnPositionRow | null;
  if (selector) {
    if ("walletId" in selector.source && !addresses.has(selector.source.walletId))
      throw notFound("Earn position");
    const strategy = await catalogue.getStrategyById(selector.strategyId);
    if (!strategy || strategy.environment !== environment || strategy.host_cluster !== cluster)
      throw notFound("Earn position");
    row = discoveredEarnPositionRow(strategy, {
      organizationId: auth.organizationId,
      projectId,
      environment,
      source: selector.source,
    });
    if (!row?.vault_address || !row.token_mint || !row.share_mint) throw notFound("Earn position");
    const tracked = await repository.getReadablePositionByInstrument({
      organizationId: auth.organizationId,
      projectId,
      environment,
      provider: row.provider,
      providerReference: row.vault_address,
      tokenMint: row.token_mint,
      shareMint: row.share_mint,
      source: selector.source,
    });
    if (tracked !== null) {
      row = tracked;
      discovered = false;
    }
    strategies.push(strategy);
  } else {
    row = await repository.getReadablePositionById({
      organizationId: auth.organizationId,
      projectId,
      environment,
      positionId,
      custodyWalletIds: wallets.map((wallet) => wallet.id),
    });
  }
  if (row === null) throw notFound("Earn position");
  if (!row.vault_address || !row.token_mint || !row.share_mint)
    throw internalError("Earn position is missing its instrument identity");
  // Most durable rows already name their strategy. A legacy row needs only its
  // exact instrument's retained metadata, never a catalogue scan.
  if (strategies.length === 0 && row.strategy_id == null) {
    const strategy = await catalogue.getStrategyByReference({
      provider: row.provider,
      providerReference: row.vault_address,
      environment,
    });
    if (strategy?.host_cluster === cluster) strategies.push(strategy);
  }
  const balanceContext = await resolveVaultBalanceReadContext(c.env, {
    movementIds: query.afterMovementIds?.split(",") ?? [],
    organizationId: auth.organizationId,
    projectId,
    custodyWalletIds: row.custody_wallet_id ? [row.custody_wallet_id] : [],
    includeAddress: row.custody_wallet_id === null,
    ownerAddress: row.owner_address ?? undefined,
    position: { id: row.id, provider: row.provider, providerReference: row.vault_address },
  });
  const { holdings, live } = await hydrateEarnPositionRows(c, [row], addresses, {
    sourceType: row.custody_wallet_id ? "wallet" : "address",
    discoveredIds: discovered ? new Set([row.id]) : undefined,
    minimumSlotByPositionId: balanceContext?.minimumSlotByPositionId,
  });
  const holding = holdings[0];
  if (!holding) throw internalError("Earn position is missing its instrument identity");
  const value = live.get(row.id);
  if (discovered) requireDiscoveredHolding(value);
  return projectEarnCorePosition(row, holding, value, {
    discovered,
    feeSponsored: isEarnVaultSponsorshipEnabled(c.env, cluster),
    strategyIds: earnStrategyIdsByInstrument(strategies),
  });
}

/** GET /v1/earn/positions/{positionId}. */
export async function getEarnPosition(
  c: ValidatedContext<{ param: typeof earnPositionParamsSchema }>
) {
  const { positionId } = c.req.valid("param");
  return success(c, await readEarnPosition(c, positionId, parseQuery(c, earnPositionQuerySchema)));
}
