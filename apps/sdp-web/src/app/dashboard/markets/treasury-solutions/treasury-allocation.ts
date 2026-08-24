import { decimalScale, formatDecimalAmount, parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { compareUnsignedDecimals } from "../earn/earn-decimal";
import { isIntlDecimalLiteral } from "../earn/earn-format";
import { sumDecimalStrings } from "../earn/earn-market-presentation";

/**
 * Portfolio-level allocation for the Treasury overview (PRO-1723): available
 * cash in custody wallets, value deployed into vault positions, and the two
 * shares those make of the float.
 *
 * ONE function computes every figure this page renders, including each wallet's
 * own line and the set of holdings no position records. That is deliberate:
 * every bug found in review here was two surfaces computing the same thing
 * differently, so the surfaces now read from a single result rather than being
 * kept in agreement by convention and tests.
 *
 * Unavailability is poisonous by design. One unreadable wallet balance, one
 * unhydratable position, or a share-mint vocabulary that cannot be certified
 * makes the affected figure `undefined`, never `0` and never a fabricated
 * share.
 */

/** The slice of a funding wallet the allocation reads. */
export interface TreasuryAllocationWallet {
  id: string;
  /**
   * The on-chain address. Load-bearing, not decoration: one wallet can appear
   * as SEVERAL custody rows (an org-level config and a project-level one both
   * describe it, and nothing constrains `public_key` to be unique), and the
   * balance read keys off the address, so every row carries the SAME balances.
   * Summing per row would count the same dollars once per configuration.
   */
  publicKey: string;
  balances?: readonly TreasuryAllocationBalance[];
}

export interface TreasuryAllocationBalance {
  mint: string;
  uiAmount: string;
  /**
   * The API's own price for this balance, `1` for anything it treats as
   * USD-stable. That includes SDP-ISSUED stablecoins, which a static catalogue
   * cannot know about, so this is the authority on what counts as cash.
   */
  usdPrice?: number;
}

/** The slice of a vault position the allocation reads. */
export interface TreasuryAllocationPosition {
  closedAt: string | null;
  custodyWalletId: string;
  shareMint: string;
  shares?: string;
  tokenMint: string;
  tokenValue?: string;
}

/**
 * What the page can currently say about vault share mints.
 *
 * Two facts, bundled so a caller cannot pass one without the other: WHICH
 * mints are known, and whether that knowledge is COMPLETE. They answer
 * different questions. Hiding a receipt-token tile only needs the mint to be
 * known; certifying a deployed total needs the vocabulary to be complete,
 * because for a holding with no position row the strategy catalogue is the
 * only witness that the token is a receipt at all.
 *
 * `complete` certifies the CLIENT's copy is whole: the read succeeded, is not
 * stale, and every row named its share mint. It cannot certify the SERVER's.
 * `/strategies` applies surfacing filters and delisting hard-deletes the row,
 * so a vault can hold money the catalogue never mentions. That residual is
 * PRO-1741, which is why `complete` is a floor on trust rather than a proof.
 */
export interface VaultShareMintVocabulary {
  known: ReadonlySet<string>;
  complete: boolean;
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

/**
 * What one wallet's "deployed in vaults" line may claim.
 *
 * `unavailable` exists because a receipt-token balance is independent evidence
 * of vault ownership: the wallet demonstrably holds shares SDP cannot value
 * (the positions read failed, the balances could not be read, or the position
 * was opened outside SDP and has no recorded row). Rendering nothing there
 * would present a deployed wallet as idle, which is the same lie as `0`.
 */
export type WalletDeploymentDisplay =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "value"; value: string };

/** Why the percentage split is absent, so no caption re-derives it. */
export type AllocationSharesAbsence = "unavailable" | "empty_float";

/**
 * Why the deployed figure is absent. Two genuinely different failures that a
 * reader acts on differently: a read did not come back, versus every read came
 * back and they cannot be squared with each other. Naming the second one "a
 * position value could not be read" would be false on a screen that is listing
 * those values, hydrated, in the table below.
 */
export type DeployedAbsence = "unreadable" | "unreconciled";

export interface TreasuryAllocation {
  /** USD-stable cash across wallets; undefined when any wallet read is unavailable. */
  availableCash: string | undefined;
  /** Value of open vault positions; undefined when it cannot be certified complete. */
  deployedValue: string | undefined;
  /**
   * Shares as decimal RATE strings ("0.05" = 5%), quantized to tenths of a
   * percent so the pair always totals exactly 100%.
   */
  deployedShare: string | undefined;
  remainingShare: string | undefined;
  /** Set exactly when the shares are absent. */
  sharesAbsence: AllocationSharesAbsence | undefined;
  /** Set exactly when `deployedValue` is absent. */
  deployedAbsence: DeployedAbsence | undefined;
  /** Each custody row's deployment line, keyed by wallet id. */
  deploymentByWalletId: ReadonlyMap<string, WalletDeploymentDisplay>;
  /**
   * Share mints the org demonstrably holds that no open position records, or
   * undefined when that cannot be determined. The strategy table reads this so
   * a row never claims "no active position" over a holding.
   */
  unrecordedShareMints: ReadonlySet<string> | undefined;
}

/**
 * Is this balance a dollar of treasury cash?
 *
 * The static catalogue is not the authority. The API prices everything it
 * treats as USD-stable at exactly `1`, including SDP-issued stablecoins loaded
 * from `issued_tokens`, and returns no price at all for volatile or
 * unrecognized tokens. So `usdPrice` CLASSIFIES while the summed amount stays
 * the decimal string: no `Number` touches an amount.
 */
function isUsdStableBalance(balance: TreasuryAllocationBalance): boolean {
  return WELL_KNOWN_TOKEN_BY_MINT.get(balance.mint)?.isUsdStable === true || balance.usdPrice === 1;
}

/**
 * The vault share mints one wallet holds, or `undefined` when its balances
 * could not be read.
 *
 * UNREADABLE IS NOT EMPTY, and that distinction is why this returns three
 * states rather than a list. An unread wallet may hold a receipt token with no
 * recorded position behind it, so reading it as "holds nothing" certifies a
 * total on the strength of a read that never happened.
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
): string[] | undefined {
  if (wallet.balances === undefined) return undefined;
  const held: string[] = [];
  for (const balance of wallet.balances) {
    if (!vaultShareMints.has(balance.mint)) continue;
    if (compareUnsignedDecimals(balance.uiAmount, "0") === 0) continue;
    held.push(balance.mint);
  }
  return held;
}

/** Distinct on-chain wallets, keeping the first custody row that describes each. */
function walletsByPublicKey(
  wallets: readonly TreasuryAllocationWallet[]
): Map<string, TreasuryAllocationWallet> {
  const distinct = new Map<string, TreasuryAllocationWallet>();
  for (const wallet of wallets) {
    if (!distinct.has(wallet.publicKey)) distinct.set(wallet.publicKey, wallet);
  }
  return distinct;
}

function availableStableCash(
  wallets: readonly TreasuryAllocationWallet[] | undefined
): string | undefined {
  if (wallets === undefined) return undefined;
  const amounts: string[] = [];
  for (const wallet of walletsByPublicKey(wallets).values()) {
    // One wallet whose balances could not be read makes the TOTAL unknowable.
    if (wallet.balances === undefined) return undefined;
    for (const balance of wallet.balances) {
      if (isUsdStableBalance(balance)) amounts.push(balance.uiAmount);
    }
  }
  // No stable balances is a real zero; `sumDecimalStrings` reserves undefined
  // for a malformed amount, which is an unavailable read, not an empty one.
  return amounts.length === 0 ? "0" : sumDecimalStrings(amounts);
}

/**
 * Value deployed across the open positions given. Undefined when any open
 * position cannot be honestly valued.
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
 * Open positions per on-chain wallet.
 *
 * Grouped by ADDRESS rather than by custody row, because a position records
 * exactly one row id while the same wallet may appear as several. Grouping by
 * row would read a sibling row's shares as unrecorded and park that wallet on
 * "unavailable" forever.
 */
function openPositionsByPublicKey(
  wallets: readonly TreasuryAllocationWallet[],
  positions: readonly TreasuryAllocationPosition[]
): Map<string, TreasuryAllocationPosition[]> {
  const publicKeyByWalletId = new Map(wallets.map((wallet) => [wallet.id, wallet.publicKey]));
  const grouped = new Map<string, TreasuryAllocationPosition[]>();
  for (const position of positions.filter(isOpenVaultPosition)) {
    const publicKey = publicKeyByWalletId.get(position.custodyWalletId);
    // A position whose custody wallet is absent from the read is handled by the
    // observation check in the summary, not here.
    if (publicKey === undefined) continue;
    const forWallet = grouped.get(publicKey);
    if (forWallet) forWallet.push(position);
    else grouped.set(publicKey, [position]);
  }
  return grouped;
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

/** One wallet's line, given everything already resolved about it. */
function walletDeploymentLine({
  complete,
  held,
  open,
  uncovered,
}: {
  complete: boolean;
  held: readonly string[] | undefined;
  open: readonly TreasuryAllocationPosition[] | undefined;
  uncovered: readonly string[];
}): WalletDeploymentDisplay {
  // Unreadable balances cannot rule OUT a deployment, and an unavailable
  // positions read cannot value one.
  if (held === undefined) return { kind: "unavailable" };
  if (open === undefined) return held.length > 0 ? { kind: "unavailable" } : { kind: "none" };
  // An incomplete vocabulary cannot certify this line either, and it must not
  // disagree with the summary above it.
  if (!complete) {
    return open.length > 0 || held.length > 0 ? { kind: "unavailable" } : { kind: "none" };
  }
  if (uncovered.length > 0) return { kind: "unavailable" };
  if (open.length === 0) return { kind: "none" };
  const value = deployedVaultValue(open);
  return value === undefined ? { kind: "unavailable" } : { kind: "value", value };
}

interface WalletCoverage {
  deploymentByWalletId: Map<string, WalletDeploymentDisplay>;
  /** Undefined when the witness could not be built at all. */
  unrecordedShareMints: Set<string> | undefined;
  someWalletUnreadable: boolean;
}

/**
 * Walk the wallets once, resolving each one's line and the portfolio-wide set
 * of holdings no position records. Both answers come from the same pass on
 * purpose: they are the same question asked at two scopes.
 */
function resolveWalletCoverage({
  positions,
  shareMints,
  wallets,
}: {
  positions: readonly TreasuryAllocationPosition[] | undefined;
  shareMints: VaultShareMintVocabulary;
  wallets: readonly TreasuryAllocationWallet[] | undefined;
}): WalletCoverage {
  const deploymentByWalletId = new Map<string, WalletDeploymentDisplay>();
  // No wallet inventory is the same failure as one unreadable wallet, a level
  // up: with no witness nothing can be certified. `[].every` would have
  // answered TRUE here, which is how a total once got certified with no
  // witness at all.
  if (wallets === undefined) {
    return { deploymentByWalletId, unrecordedShareMints: undefined, someWalletUnreadable: false };
  }

  const openByPublicKey =
    positions === undefined ? undefined : openPositionsByPublicKey(wallets, positions);
  let unrecordedShareMints: Set<string> | undefined =
    positions === undefined || !shareMints.complete ? undefined : new Set<string>();
  let someWalletUnreadable = false;

  for (const wallet of wallets) {
    const held = heldVaultShareMints(wallet, shareMints.known);
    const open = openByPublicKey?.get(wallet.publicKey) ?? (openByPublicKey && []);
    const recorded = new Set((open ?? []).map((position) => position.shareMint));
    const uncovered = held?.filter((mint) => !recorded.has(mint)) ?? [];

    for (const mint of uncovered) unrecordedShareMints?.add(mint);
    // A wallet we could not read leaves the whole set indeterminate.
    if (held === undefined) {
      unrecordedShareMints = undefined;
      someWalletUnreadable = true;
    }

    deploymentByWalletId.set(
      wallet.id,
      walletDeploymentLine({ complete: shareMints.complete, held, open, uncovered })
    );
  }

  return { deploymentByWalletId, unrecordedShareMints, someWalletUnreadable };
}

export function summarizeTreasuryAllocation({
  positions,
  shareMints,
  wallets,
}: {
  positions: readonly TreasuryAllocationPosition[] | undefined;
  shareMints: VaultShareMintVocabulary;
  wallets: readonly TreasuryAllocationWallet[] | undefined;
}): TreasuryAllocation {
  const availableCash = availableStableCash(wallets);
  const { deploymentByWalletId, someWalletUnreadable, unrecordedShareMints } =
    resolveWalletCoverage({ positions, shareMints, wallets });

  // A holding no position records makes the recorded sum a floor, not a total.
  const certified = unrecordedShareMints !== undefined && unrecordedShareMints.size === 0;
  const deployedValue = certified ? deployedVaultValue(positions) : undefined;

  // Shares additionally require the float to be fully OBSERVED. The wallet read
  // serves active wallets only, so an open position custodied by a wallet
  // absent from it means idle cash this read cannot see. The deployed dollar
  // figure still counts that position; only the split would be fabricated.
  const observedWalletIds = new Set((wallets ?? []).map((wallet) => wallet.id));
  const openPositionsObserved = (positions ?? [])
    .filter(isOpenVaultPosition)
    .every((position) => observedWalletIds.has(position.custodyWalletId));
  const shares = openPositionsObserved ? allocationShares(availableCash, deployedValue) : undefined;

  const readFailed = positions === undefined || wallets === undefined || someWalletUnreadable;
  return {
    availableCash,
    deployedValue,
    deployedAbsence:
      deployedValue !== undefined
        ? undefined
        : // Certified but still absent means the position VALUES are unusable,
          // which is a failed read however the reads themselves resolved.
          certified || readFailed
          ? "unreadable"
          : "unreconciled",
    deployedShare: shares?.deployed,
    remainingShare: shares?.remaining,
    sharesAbsence:
      shares !== undefined
        ? undefined
        : // Both figures read as real zeros: there is nothing to split.
          availableCash === "0" && deployedValue === "0"
          ? "empty_float"
          : "unavailable",
    deploymentByWalletId,
    unrecordedShareMints,
  };
}

/**
 * Render an allocation share at exactly one fraction digit. The share is
 * already quantized to tenths of a percent, so this formatting never rounds:
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
