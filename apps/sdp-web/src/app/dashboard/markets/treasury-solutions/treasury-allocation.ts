import {
  decimalScale,
  formatDecimalAmount,
  isDecimalString,
  parseDecimalAmount,
} from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { compareUnsignedDecimals } from "../earn/earn-decimal";
import { sumDecimalStrings } from "../earn/earn-market-presentation";

/**
 * Portfolio-level allocation for the Treasury overview (PRO-1723): available
 * cash in custody wallets, value deployed into vault positions, and the two
 * shares those make of the float.
 *
 * Only USD-stable tokens (`isUsdStable` in the well-known catalogue — "priced
 * at $1 without a feed") participate. A SOL gas balance is not treasury cash,
 * so it is EXCLUDED from the cash figure; but a vault position denominated in
 * a token this rule cannot price makes the deployed figure UNAVAILABLE rather
 * than being dropped, because omitting deployed money would misstate the very
 * share a treasurer acts on.
 *
 * Unavailability is poisonous by design: one unreadable wallet balance or one
 * unhydratable position makes the affected figure `undefined`, never `0` and
 * never a fabricated share.
 */

/** The slice of a funding wallet the allocation summary reads. */
export interface TreasuryAllocationWallet {
  id: string;
  balances?: readonly { mint: string; uiAmount: string }[];
}

/** The slice of a vault position the allocation summary reads. */
export interface TreasuryAllocationPosition {
  closedAt: string | null;
  custodyWalletId: string;
  shareMint: string;
  shares?: string;
  tokenMint: string;
  tokenValue?: string;
}

/**
 * A position is open while it is not closed and its shares are not provably
 * zero. Shared with the Active-positions table so the summary and the rows
 * beneath it always describe the same set.
 */
export function isOpenVaultPosition(position: TreasuryAllocationPosition): boolean {
  return (
    position.closedAt === null &&
    (position.shares === undefined || compareUnsignedDecimals(position.shares, "0") !== 0)
  );
}

export interface TreasuryAllocationSummary {
  /** USD-stable cash across wallets; undefined when any wallet read is unavailable. */
  availableCash: string | undefined;
  /** Value of open vault positions; undefined when any open position cannot be valued. */
  deployedValue: string | undefined;
  /**
   * Shares as decimal RATE strings ("0.05" = 5%), quantized to tenths of a
   * percent so the pair always totals exactly 100%. Undefined when either
   * figure is unavailable or the float is zero.
   */
  deployedShare: string | undefined;
  remainingShare: string | undefined;
}

function availableStableCash(
  wallets: readonly TreasuryAllocationWallet[] | undefined
): string | undefined {
  if (wallets === undefined) return undefined;
  const amounts: string[] = [];
  for (const wallet of wallets) {
    // One wallet whose balances could not be read makes the TOTAL unknowable.
    if (wallet.balances === undefined) return undefined;
    for (const balance of wallet.balances) {
      if (!WELL_KNOWN_TOKEN_BY_MINT.get(balance.mint)?.isUsdStable) continue;
      amounts.push(balance.uiAmount);
    }
  }
  // No stable balances is a real zero; `sumDecimalStrings` reserves undefined
  // for a malformed amount, which is an unavailable read, not an empty one.
  return amounts.length === 0 ? "0" : sumDecimalStrings(amounts);
}

/**
 * Value deployed across the open positions in `positions` — the whole
 * portfolio for the summary, or one wallet's slice for its "deployed in
 * vaults" line. Undefined when any open position cannot be honestly valued.
 */
export function deployedVaultValue(
  positions: readonly TreasuryAllocationPosition[] | undefined
): string | undefined {
  if (positions === undefined) return undefined;
  const amounts: string[] = [];
  for (const position of positions.filter(isOpenVaultPosition)) {
    if (position.tokenValue === undefined) return undefined;
    if (!WELL_KNOWN_TOKEN_BY_MINT.get(position.tokenMint)?.isUsdStable) return undefined;
    amounts.push(position.tokenValue);
  }
  return amounts.length === 0 ? "0" : sumDecimalStrings(amounts);
}

/**
 * The vault share mints one wallet actually holds.
 *
 * THE single definition of "holds shares", shared by the summary and by the
 * per-wallet line, because two copies of this predicate is how the two
 * surfaces drift into contradicting each other.
 *
 * A provably-zero balance is not a holding: an emptied share account can
 * outlive the position it belonged to (this payload appends the SOL row at
 * zero, so a zero row is a shape the client must handle rather than an
 * upstream invariant to lean on), and counting one would keep a fully exited
 * treasury permanently unavailable. Anything NOT provably zero counts, so an
 * unparseable amount reads as held: it is not evidence of an empty account.
 */
export function heldVaultShareMints(
  wallet: TreasuryAllocationWallet,
  vaultShareMints: ReadonlySet<string>
): string[] {
  const held: string[] = [];
  for (const balance of wallet.balances ?? []) {
    if (!vaultShareMints.has(balance.mint)) continue;
    if (compareUnsignedDecimals(balance.uiAmount, "0") === 0) continue;
    held.push(balance.mint);
  }
  return held;
}

/**
 * Does every vault share token any wallet holds have an open position behind
 * it? A wallet balance is the independent witness here: a position opened
 * outside SDP leaves shares in the wallet with no recorded row.
 *
 * Recorded mints are tracked PER WALLET. Two wallets can hold the same vault's
 * shares while only one of them has a recorded position, and a portfolio-wide
 * mint set would accept the other's holding as covered.
 */
function heldShareMintsRecorded({
  positions,
  vaultShareMints,
  wallets,
}: {
  positions: readonly TreasuryAllocationPosition[];
  vaultShareMints: ReadonlySet<string>;
  wallets: readonly TreasuryAllocationWallet[] | undefined;
}): boolean {
  const recordedByWallet = new Map<string, Set<string>>();
  for (const position of positions.filter(isOpenVaultPosition)) {
    const recorded = recordedByWallet.get(position.custodyWalletId) ?? new Set<string>();
    recorded.add(position.shareMint);
    recordedByWallet.set(position.custodyWalletId, recorded);
  }
  return (wallets ?? []).every((wallet) =>
    heldVaultShareMints(wallet, vaultShareMints).every(
      (mint) => recordedByWallet.get(wallet.id)?.has(mint) === true
    )
  );
}

/**
 * What one wallet's "deployed in vaults" line may claim.
 *
 * `unavailable` exists because a receipt-token balance is independent evidence
 * of vault ownership: the wallet demonstrably holds shares SDP cannot value
 * (the positions read failed, or the position was opened outside SDP and has no
 * recorded row). Rendering nothing there would present a deployed wallet as
 * idle, which is the same lie as rendering `0`.
 */
export type WalletDeploymentDisplay =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "value"; value: string };

/**
 * Takes the WHOLE position list and scopes it here, rather than trusting a
 * caller to pre-filter by wallet: a caller that filtered differently from the
 * summary is how these two surfaces drifted apart before.
 */
export function walletDeployment({
  positions,
  vaultShareMints,
  wallet,
}: {
  /** Every position, or undefined when the read is unavailable. */
  positions: readonly TreasuryAllocationPosition[] | undefined;
  vaultShareMints: ReadonlySet<string>;
  wallet: TreasuryAllocationWallet;
}): WalletDeploymentDisplay {
  const heldShareMints = heldVaultShareMints(wallet, vaultShareMints);
  if (positions === undefined) {
    return heldShareMints.length > 0 ? { kind: "unavailable" } : { kind: "none" };
  }

  const open = positions.filter(
    (position) => position.custodyWalletId === wallet.id && isOpenVaultPosition(position)
  );
  const covered = new Set(open.map((position) => position.shareMint));
  // A held share mint no open position accounts for means the recorded total
  // is incomplete, so it must not be presented as this wallet's deployment.
  if (heldShareMints.some((mint) => !covered.has(mint))) return { kind: "unavailable" };
  if (open.length === 0) return { kind: "none" };

  const value = deployedVaultValue(open);
  return value === undefined ? { kind: "unavailable" } : { kind: "value", value };
}

function allocationShares(
  cash: string | undefined,
  deployed: string | undefined
): { deployed: string; remaining: string } | undefined {
  if (cash === undefined || deployed === undefined) return undefined;
  const scale = Math.max(decimalScale(cash), decimalScale(deployed));
  const cashUnits = parseDecimalAmount(cash, scale);
  const deployedUnits = parseDecimalAmount(deployed, scale);
  const total = cashUnits + deployedUnits;
  // 0/0 is not a share; rendering 0%/100% would fabricate an allocation.
  if (total === 0n) return undefined;
  // Round-half-up to tenths of a percent, then take the complement so the two
  // rendered figures always total exactly 100.
  const deployedTenths = (deployedUnits * 2000n + total) / (2n * total);
  return {
    deployed: formatDecimalAmount(deployedTenths, 3),
    remaining: formatDecimalAmount(1000n - deployedTenths, 3),
  };
}

export function summarizeTreasuryAllocation({
  positions,
  vaultShareMints,
  wallets,
}: {
  positions: readonly TreasuryAllocationPosition[] | undefined;
  /** Known vault share mints, so held-but-unrecorded shares can be detected. */
  vaultShareMints?: ReadonlySet<string>;
  wallets: readonly TreasuryAllocationWallet[] | undefined;
}): TreasuryAllocationSummary {
  const availableCash = availableStableCash(wallets);
  // A wallet holding shares that no recorded position accounts for makes the
  // deployed TOTAL incomplete. Reporting the recorded sum as the total would
  // understate deployed money and overstate the idle share.
  const everyHeldShareRecorded =
    positions === undefined ||
    vaultShareMints === undefined ||
    heldShareMintsRecorded({ positions, vaultShareMints, wallets });
  const deployedValue = everyHeldShareRecorded ? deployedVaultValue(positions) : undefined;
  // Shares additionally require the float to be fully OBSERVED. The wallet
  // read serves active wallets only, so an open position custodied by a wallet
  // absent from it (deactivated, say) means idle cash this read cannot see.
  // The deployed dollar figure still counts that position; only the split
  // would be fabricated, so only the shares go unavailable.
  const observedWalletIds = new Set((wallets ?? []).map((wallet) => wallet.id));
  const openPositionsObserved = (positions ?? [])
    .filter(isOpenVaultPosition)
    .every((position) => observedWalletIds.has(position.custodyWalletId));
  const shares = openPositionsObserved ? allocationShares(availableCash, deployedValue) : undefined;
  return {
    availableCash,
    deployedValue,
    deployedShare: shares?.deployed,
    remainingShare: shares?.remaining,
  };
}

function isIntlDecimalLiteral(value: string): value is Intl.StringNumericLiteral {
  return isDecimalString(value);
}

/**
 * Render an allocation share at exactly one fraction digit. The share is
 * already quantized to tenths of a percent, so this formatting never rounds —
 * the displayed pair keeps totalling 100.0%.
 */
export function formatAllocationShare(share: string | undefined, locale: string): string {
  if (share === undefined || !isIntlDecimalLiteral(share)) return "—";
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(share);
}
