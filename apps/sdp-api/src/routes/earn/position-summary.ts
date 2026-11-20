import { sumDecimalAmounts } from "@sdp/payments/decimal";
import type {
  EarnWalletPosition,
  EarnWalletPositionSummary,
  EarnWalletTokenTotal,
} from "@sdp/types/earn";
import { isEarnVaultHoldingEmpty } from "@sdp/types/earn";
import type { EarnPositionRow } from "@/db/repositories/earn-movements.repository";
import { internalError } from "@/lib/errors";
import type { VaultPositionCursor } from "./handlers/vault-position-cursor";
import {
  type HydratedVaultPositionValue,
  hydratedHoldingTokenValue,
} from "./handlers/vault-position-hydration";

/** Scan every page, refusing repeated or non-advancing bounds. */
export async function collectAllEarnPositionRows(
  readPage: (
    before: VaultPositionCursor | null
  ) => Promise<{ rows: EarnPositionRow[]; hasMore: boolean }>
): Promise<EarnPositionRow[]> {
  const rows: EarnPositionRow[] = [];
  const seenBounds = new Set<string>();
  let before: VaultPositionCursor | null = null;

  while (true) {
    const result = await readPage(before);
    rows.push(...result.rows);
    if (!result.hasMore) return rows;

    const last = result.rows.at(-1);
    if (!last) {
      throw internalError("Wallet position pagination ended before completion");
    }
    const next = { createdAt: last.created_at, id: last.id };
    const key = JSON.stringify(next);
    if ((before && !cursorStrictlyPrecedes(next, before)) || seenBounds.has(key)) {
      throw internalError("Wallet position pagination did not advance");
    }
    seenBounds.add(key);
    before = next;
  }
}

function cursorStrictlyPrecedes(next: VaultPositionCursor, before: VaultPositionCursor): boolean {
  return (
    next.createdAt < before.createdAt ||
    (next.createdAt === before.createdAt && next.id < before.id)
  );
}

/** One wallet holding with its owner and instrument columns proven present. */
export interface EarnPositionHolding {
  id: string;
  provider: string;
  providerReference: string;
  label: string;
  ownerAddress: string;
  tokenMint: string;
  shareMint: string;
  shareAtaRentFunder: string | null;
  costBasisKnown?: boolean;
  createdAt: string;
  closedAt: string | null;
  /** Snapshot boundary for the read-path close-out; see closeEmptyHydratedPositions. */
  updatedAt: string;
}

function toWalletPositionWire(
  holding: EarnPositionHolding,
  hydrated: HydratedVaultPositionValue | undefined
): EarnWalletPosition {
  return {
    id: holding.id,
    ownerAddress: holding.ownerAddress,
    provider: holding.provider,
    providerReference: holding.providerReference,
    label: holding.label,
    tokenMint: holding.tokenMint,
    shareMint: holding.shareMint,
    createdAt: holding.createdAt,
    closedAt: holding.closedAt,
    shares: hydrated?.shares,
    withdrawableShares: hydrated?.withdrawableShares,
    unlockTimestamp: hydrated?.unlockTimestamp,
    tokenValue: hydrated?.tokenValue,
    parIntermediate: hydrated?.parIntermediate,
  };
}

interface MutableTokenTotal {
  tokenMint: string;
  owners: Set<string>;
  values: string[];
  positionCount: number;
  unavailablePositionCount: number;
}

interface MutableStrategyTotal {
  provider: string;
  providerReference: string;
  label: string;
  owners: Set<string>;
  positions?: EarnWalletPosition[];
  positionCount: number;
  tokens: Map<string, MutableTokenTotal>;
}

/** Exact live totals with explicit disclosure of owner addresses and positions. */
export function summarizeEarnPositions(
  holdings: readonly EarnPositionHolding[],
  live: ReadonlyMap<string, HydratedVaultPositionValue>,
  options: { includeOwnerAddresses: boolean; includePositions: boolean } = {
    includeOwnerAddresses: false,
    includePositions: false,
  }
): EarnWalletPositionSummary {
  const owners = new Set<string>();
  const strategies = new Map<string, MutableStrategyTotal>();
  const tokens = new Map<string, MutableTokenTotal>();
  let unavailablePositionCount = 0;
  let positionCount = 0;

  for (const holding of holdings) {
    const hydrated = live.get(holding.id);
    // A holding the live read proves empty holds nothing to count: its first
    // deposit has not landed, or it exited while a movement keeps the close-out
    // waiting. An unreadable holding still counts, as unavailable, never as zero.
    if (hydrated !== undefined && isEarnVaultHoldingEmpty(hydrated)) continue;
    positionCount += 1;
    owners.add(holding.ownerAddress);
    const value = hydratedHoldingTokenValue(hydrated);
    if (value === undefined) unavailablePositionCount += 1;

    const strategyKey = JSON.stringify([holding.provider, holding.providerReference]);
    let strategy = strategies.get(strategyKey);
    if (!strategy) {
      // Rows are collected newest first, so the first claim intentionally owns
      // the display label when old deposits for one strategy used different copy.
      strategy = {
        provider: holding.provider,
        providerReference: holding.providerReference,
        label: holding.label,
        owners: new Set(),
        ...(options.includePositions ? { positions: [] } : {}),
        positionCount: 0,
        tokens: new Map(),
      };
      strategies.set(strategyKey, strategy);
    }
    strategy.owners.add(holding.ownerAddress);
    strategy.positions?.push(toWalletPositionWire(holding, hydrated));
    strategy.positionCount += 1;
    addToTokenTotal(strategy.tokens, holding, value);
    addToTokenTotal(tokens, holding, value);
  }

  return {
    walletCount: owners.size,
    positionCount,
    unavailablePositionCount,
    totalsByStrategy: [...strategies.values()]
      .map((strategy) => ({
        provider: strategy.provider,
        providerReference: strategy.providerReference,
        label: strategy.label,
        // The address list is the PII-bearing half of this read (EARN-028):
        // omitted by default and only present on an explicit opt-in. Omitted,
        // not emptied, so a consumer cannot mistake "not requested" for "no
        // owners".
        ...(options.includeOwnerAddresses
          ? { ownerAddresses: [...strategy.owners].sort(compareWireStrings) }
          : {}),
        ...(strategy.positions
          ? {
              positions: strategy.positions.sort(
                (left, right) =>
                  compareWireStrings(left.ownerAddress, right.ownerAddress) ||
                  compareWireStrings(left.id, right.id)
              ),
            }
          : {}),
        walletCount: strategy.owners.size,
        positionCount: strategy.positionCount,
        totalsByToken: [...strategy.tokens.values()].map(finalizeTokenTotal).sort(tokenTotalOrder),
      }))
      .sort(
        (left, right) =>
          compareWireStrings(left.label, right.label) ||
          compareWireStrings(left.provider, right.provider) ||
          compareWireStrings(left.providerReference, right.providerReference)
      ),
    totalsByToken: [...tokens.values()].map(finalizeTokenTotal).sort(tokenTotalOrder),
  };
}

function addToTokenTotal(
  totals: Map<string, MutableTokenTotal>,
  holding: EarnPositionHolding,
  tokenValue: string | undefined
) {
  let total = totals.get(holding.tokenMint);
  if (!total) {
    total = {
      tokenMint: holding.tokenMint,
      owners: new Set(),
      values: [],
      positionCount: 0,
      unavailablePositionCount: 0,
    };
    totals.set(holding.tokenMint, total);
  }
  total.owners.add(holding.ownerAddress);
  total.positionCount += 1;
  if (tokenValue === undefined) total.unavailablePositionCount += 1;
  else total.values.push(tokenValue);
}

function finalizeTokenTotal(total: MutableTokenTotal): EarnWalletTokenTotal {
  return {
    tokenMint: total.tokenMint,
    walletCount: total.owners.size,
    positionCount: total.positionCount,
    unavailablePositionCount: total.unavailablePositionCount,
    ...(total.unavailablePositionCount === 0
      ? { tokenValue: sumDecimalAmounts(total.values) }
      : {}),
  };
}

function tokenTotalOrder(left: EarnWalletTokenTotal, right: EarnWalletTokenTotal) {
  return compareWireStrings(left.tokenMint, right.tokenMint);
}

function compareWireStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
