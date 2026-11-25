import type { EarnCorePosition } from "@sdp/types/earn-core";
import { getDb } from "@/db/client";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import {
  createPostgresEarnMovementsRepository,
  type EarnPositionRow,
} from "@/db/repositories/earn-movements.repository";
import { getAuth } from "@/lib/auth";
import { internalError } from "@/lib/errors";
import type { AppContext } from "@/routes/earn/context";
import {
  closeEmptyHydratedPositions,
  type HydratedVaultPositionValue,
  hydrateVaultPositions,
  markVaultPositionRowsRead,
  type VaultPositionHydrationOptions,
} from "@/routes/earn/handlers/vault-position-hydration";
import type { EarnPositionHolding } from "@/routes/earn/position-summary";

/** List and detail resolve the same identities before one batched provider read. */
export async function hydrateEarnPositionRows(
  c: AppContext,
  rows: readonly EarnPositionRow[],
  walletAddresses: ReadonlyMap<string, string>,
  options: Omit<VaultPositionHydrationOptions, "rowsReadAt"> & {
    discoveredIds?: ReadonlySet<string>;
  }
): Promise<{
  holdings: EarnPositionHolding[];
  live: Map<string, HydratedVaultPositionValue>;
}> {
  const rowsReadAt = markVaultPositionRowsRead();
  const { discoveredIds, ...hydrationOptions } = options;
  const holdings = rows.map((row): EarnPositionHolding => {
    const ownerAddress = row.custody_wallet_id
      ? walletAddresses.get(row.custody_wallet_id)
      : row.owner_address;
    if (!ownerAddress || !row.vault_address || !row.token_mint || !row.share_mint)
      throw internalError("Earn position is missing its instrument identity");
    return {
      id: row.id,
      provider: row.provider,
      providerReference: row.vault_address,
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
  const live = await hydrateVaultPositions(
    c,
    holdings.map((holding) => ({
      id: holding.id,
      provider: holding.provider,
      providerReference: holding.providerReference,
      ownerAddress: holding.ownerAddress,
      tokenMint: holding.tokenMint,
      shareMint: holding.shareMint,
    })),
    { ...hydrationOptions, rowsReadAt }
  );
  const repository = createPostgresEarnMovementsRepository(getDb(c.env));
  await closeEmptyHydratedPositions(
    (positionId, observedUpdatedAt) =>
      repository.closeVaultPositionIfEmpty({
        positionId,
        organizationId: getAuth(c).organizationId,
        observedUpdatedAt,
      }),
    holdings.filter((holding) => !discoveredIds?.has(holding.id)),
    live
  );
  return { holdings, live };
}

function instrumentKey(input: {
  provider: string;
  providerReference: string;
  shareMint: string;
  tokenMint: string;
}): string {
  return JSON.stringify([
    input.provider,
    input.providerReference,
    input.shareMint,
    input.tokenMint,
  ]);
}

/** Retained catalogue metadata can name a holding even after delisting. */
export function earnStrategyIdsByInstrument(
  strategies: readonly EarnStrategyRow[]
): ReadonlyMap<string, string> {
  return new Map(
    strategies.flatMap((strategy) => {
      const shareMint = strategy.share_mint;
      if (shareMint === null) return [];
      return strategy.deposit_mints.map(
        (tokenMint) =>
          [
            instrumentKey({
              provider: strategy.provider,
              providerReference: strategy.provider_reference,
              shareMint,
              tokenMint,
            }),
            strategy.id,
          ] as const
      );
    })
  );
}

/** Every position surface preserves the same source, units and unknown values. */
export function projectEarnCorePosition(
  row: EarnPositionRow,
  holding: EarnPositionHolding,
  live: HydratedVaultPositionValue | undefined,
  input: {
    discovered: boolean;
    feeSponsored: boolean;
    strategyIds: ReadonlyMap<string, string>;
  }
): EarnCorePosition {
  return {
    id: row.id,
    source: row.custody_wallet_id
      ? { walletId: row.custody_wallet_id }
      : { ownerAddress: holding.ownerAddress },
    strategyId: row.strategy_id ?? input.strategyIds.get(instrumentKey(holding)),
    provider: row.provider,
    providerReference: holding.providerReference,
    label: row.label,
    tokenMint: holding.tokenMint,
    shareMint: holding.shareMint,
    createdAt: input.discovered ? null : row.created_at,
    discovered: input.discovered || undefined,
    costBasisKnown: row.cost_basis_known !== false,
    closedAt: row.closed_at,
    feeSponsored: row.custody_wallet_id !== null && input.feeSponsored,
    shares: live?.shares,
    withdrawableShares: live?.withdrawableShares,
    unlockTimestamp: live?.unlockTimestamp,
    tokenValue: live?.tokenValue,
    parIntermediate: live?.parIntermediate,
  };
}
