import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { EarnPositionSource } from "@sdp/types/earn-core";
import { isEarnProviderSurfaced } from "@sdp/types/provider-access";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import type { EarnPositionRow } from "@/db/repositories/earn-movements.repository";
import { encodeDiscoveredEarnPositionLocator } from "./discovered-position";

/**
 * In-memory candidates for live reads, never database claims. The caller emits
 * a candidate only after its owner, instrument and nonzero balance are verified.
 */
interface DiscoveredPositionScope {
  source: EarnPositionSource;
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
}

/** Exit projection ignores browsing and deposit-admission policy. */
export function discoveredEarnPositionRow(
  strategy: EarnStrategyRow,
  input: DiscoveredPositionScope
): EarnPositionRow | null {
  const tokenMint = strategy.deposit_mints[0];
  if (!tokenMint || !strategy.share_mint) return null;
  return {
    id: encodeDiscoveredEarnPositionLocator({ strategyId: strategy.id, source: input.source }),
    strategy_id: strategy.id,
    cost_basis_known: false,
    organization_id: input.organizationId,
    project_id: input.projectId,
    environment: input.environment,
    provider: strategy.provider,
    kind: "vault_direct",
    custody_wallet_id: "walletId" in input.source ? input.source.walletId : null,
    owner_address: "ownerAddress" in input.source ? input.source.ownerAddress : null,
    vault_address: strategy.provider_reference,
    strategy_reference: strategy.provider_reference,
    share_mint: strategy.share_mint,
    token_mint: tokenMint,
    label: strategy.name,
    created_by: null,
    created_at: strategy.created_at,
    updated_at: strategy.updated_at,
    activated_at: null,
    closed_at: null,
    share_ata_rent_funder: null,
  };
}

/** Candidates are verified live before any untracked holding is emitted. */
export function buildDiscoveredEarnPositionRows(
  strategies: readonly EarnStrategyRow[],
  input: DiscoveredPositionScope,
  knownRows: readonly EarnPositionRow[]
): EarnPositionRow[] {
  const known = new Set(
    knownRows.map((row) =>
      JSON.stringify([row.provider, row.vault_address, row.token_mint, row.share_mint])
    )
  );
  return strategies.flatMap((strategy) => {
    if (!isEarnProviderSurfaced(strategy.provider)) return [];
    const candidate = discoveredEarnPositionRow(strategy, input);
    if (
      candidate === null ||
      known.has(
        JSON.stringify([
          candidate.provider,
          candidate.vault_address,
          candidate.token_mint,
          candidate.share_mint,
        ])
      )
    )
      return [];
    return [candidate];
  });
}
