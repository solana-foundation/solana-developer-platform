/**
 * Token Terms: a mint's state at one instant, and the pure rules that say what
 * an amount moves under it (ADR 0012).
 *
 * The fee rules are the Token-2022 program's exact integer math
 * (`solana-program/token-2022`, `interface/src/extension/transfer_fee/mod.rs`).
 * A mint's display rule (scaled or interest-bearing) is decoded so every path
 * can refuse it; SDP computes no display value while display units are
 * deferred (ADR 0012, open decision 7).
 *
 * Client-safe: no RPC and no Node-only import.
 */

import {
  SOL_DECIMALS,
  SPL_TOKEN_PROGRAMS,
  type TokenProgramKind,
} from "@sdp/types/well-known-tokens";
import {
  type Address,
  decodeAccount,
  type EncodedAccount,
  type Epoch,
  type Slot,
  type UnixTimestamp,
  unixTimestamp,
  unwrapOption,
} from "@solana/kit";
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  AccountState,
  decodeMint,
  type Extension,
  type ExtensionArgs,
  type Mint,
  type TransferFee,
} from "@solana-program/token-2022";
import { AmountError } from "./amount";
import { NATIVE_ASSET, type NativeAsset, type TokenAsset, type UnreadMint } from "./asset-ref";
import { type BaseUnits, baseUnits, U64_MAX } from "./token-amount";

/** The Clock sysvar read in the same request as the mint. */
export type TermsReadAt = Readonly<{ slot: Slot; unixTimestamp: UnixTimestamp; epoch: Epoch }>;

/** One transfer-fee entry, as the program's `TransferFee`. */
export type TransferFeeRate = Readonly<{
  /** First epoch this entry applies in. */
  epoch: Epoch;
  /** Fee rate in hundredths of a percent, at most 10 000. */
  basisPoints: number;
  /** Cap on the fee of one transfer, in base units. */
  maximumFee: BaseUnits;
}>;

/**
 * A mint's two fee entries. `newer` applies from its epoch on, `older` before
 * it. A fee change takes effect two epochs after it is set.
 */
export type TransferFeeSchedule = Readonly<{ older: TransferFeeRate; newer: TransferFeeRate }>;

export type PlainDisplayRule = Readonly<{ kind: "plain" }>;

/** `display = trunc(raw × multiplier) ÷ 10^decimals`; `newMultiplier` applies from its timestamp. */
export type ScaledDisplayRule = Readonly<{
  kind: "scaled";
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveAt: UnixTimestamp;
}>;

/** `display = raw × e^(rate·t) ÷ 10^decimals`, compounded continuously; rates may be negative. */
export type InterestDisplayRule = Readonly<{
  kind: "interest";
  initializedAt: UnixTimestamp;
  lastUpdateAt: UnixTimestamp;
  /** Average rate in basis points from `initializedAt` to `lastUpdateAt`. */
  preUpdateAverageRate: number;
  /** Rate in basis points from `lastUpdateAt` on. */
  currentRate: number;
}>;

/** How a wallet shows a raw amount. Base units never change with it. */
export type DisplayRule = PlainDisplayRule | ScaledDisplayRule | InterestDisplayRule;

/** The state every token account of the mint starts in. */
export type DefaultAccountState = "initialized" | "frozen";

/** Account extensions the program adds to every token account of a mint. */
export type RequiredAccountExtension = Extract<
  ExtensionArgs,
  {
    __kind:
      | "TransferFeeAmount"
      | "NonTransferableAccount"
      | "ImmutableOwner"
      | "TransferHookAccount"
      | "PausableAccount";
  }
>;

type TokenTermsFields = Readonly<{
  decimals: number;
  /** The hook program, or null when the extension is absent or its program is unset. */
  transferHookProgram: Address | null;
  /** May set or change the hook program; null when the extension is absent or immutable. */
  transferHookAuthority: Address | null;
  paused: boolean;
  nonTransferable: boolean;
  defaultAccountState: DefaultAccountState;
  /** May move any holder's balance, so balances can change outside SDP. */
  permanentDelegate: Address | null;
  /** The mint allows confidential transfers, which move balances SDP does not see. */
  confidentialTransfers: boolean;
  /** May close the mint when its supply is zero; a new mint can then appear at the address. */
  mintCloseAuthority: Address | null;
  freezeAuthority: Address | null;
  /**
   * What a new token account of this mint needs, as `getTokenSize` takes it.
   * An associated token account also carries `ImmutableOwner`.
   */
  requiredAccountExtensions: readonly RequiredAccountExtension[];
}>;

/** Native SOL: fixed by the runtime, so nothing is read. */
export type NativeTokenTerms = TokenTermsFields &
  Readonly<{ asset: NativeAsset; readAt: null; transferFee: null; display: PlainDisplayRule }>;

/** A mint as one read saw it. */
export type MintTokenTerms = TokenTermsFields &
  Readonly<{
    asset: TokenAsset;
    readAt: TermsReadAt;
    transferFee: TransferFeeSchedule | null;
    display: DisplayRule;
  }>;

export type TokenTerms = NativeTokenTerms | MintTokenTerms;

export const NATIVE_TOKEN_TERMS: NativeTokenTerms = {
  asset: NATIVE_ASSET,
  decimals: SOL_DECIMALS,
  readAt: null,
  transferFee: null,
  display: { kind: "plain" },
  transferHookProgram: null,
  transferHookAuthority: null,
  paused: false,
  nonTransferable: false,
  defaultAccountState: "initialized",
  permanentDelegate: null,
  confidentialTransfers: false,
  mintCloseAuthority: null,
  freezeAuthority: null,
  requiredAccountExtensions: [],
};

export const TOKEN_TERMS_REFUSALS = {
  notMint: "not_a_mint",
  unsupportedProgram: "unsupported_program",
  programMismatch: "program_mismatch",
  invalidExtension: "invalid_extension",
} as const satisfies Record<string, string>;

export type TokenTermsRefusal = (typeof TOKEN_TERMS_REFUSALS)[keyof typeof TOKEN_TERMS_REFUSALS];

/** The account at a requested mint address is not a mint SDP can move. */
export class TokenTermsError extends Error {
  readonly reason: TokenTermsRefusal;

  constructor(reason: TokenTermsRefusal, message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "TokenTermsError";
    this.reason = reason;
  }
}

/** A classic SPL mint, and the base of a Token-2022 mint. */
const MINT_BASE_SIZE = 82;

/** Where a Token-2022 account with extensions stores its account type. */
const ACCOUNT_TYPE_OFFSET = 165;

/** `MAX_FEE_BASIS_POINTS` in the program. */
const MAX_FEE_BASIS_POINTS = 10_000;

const ONE_IN_BASIS_POINTS = 10_000n;

/** A `MaybeNull<Address>` with no value is the zero address. */
const UNSET_ADDRESS = "11111111111111111111111111111111";

/** The smallest normal f64; the program accepts only positive normal multipliers. */
const MIN_NORMAL_F64 = 2 ** -1022;

function tokenProgramOf(owner: Address): TokenProgramKind | null {
  if (owner === SPL_TOKEN_PROGRAMS["spl-token"]) return "spl-token";
  if (owner === SPL_TOKEN_PROGRAMS["token-2022"]) return "token-2022";
  return null;
}

function setOrNull(value: Address): Address | null {
  return value === UNSET_ADDRESS ? null : value;
}

function invalidExtension(message: string): TokenTermsError {
  return new TokenTermsError(TOKEN_TERMS_REFUSALS.invalidExtension, message);
}

function feeRate(fee: TransferFee): TransferFeeRate {
  if (fee.transferFeeBasisPoints > MAX_FEE_BASIS_POINTS) {
    throw invalidExtension("Transfer fee is above 100%");
  }
  return {
    epoch: fee.epoch,
    basisPoints: fee.transferFeeBasisPoints,
    maximumFee: baseUnits(fee.maximumFee),
  };
}

function scaledRule(extension: Extension & { __kind: "ScaledUiAmountConfig" }): ScaledDisplayRule {
  for (const multiplier of [extension.multiplier, extension.newMultiplier]) {
    if (!(Number.isFinite(multiplier) && multiplier >= MIN_NORMAL_F64)) {
      throw invalidExtension("Scaled UI amount multiplier is not a positive normal number");
    }
  }
  return {
    kind: "scaled",
    multiplier: extension.multiplier,
    newMultiplier: extension.newMultiplier,
    newMultiplierEffectiveAt: unixTimestamp(extension.newMultiplierEffectiveTimestamp),
  };
}

function interestRule(
  extension: Extension & { __kind: "InterestBearingConfig" }
): InterestDisplayRule {
  return {
    kind: "interest",
    initializedAt: unixTimestamp(extension.initializationTimestamp),
    lastUpdateAt: unixTimestamp(extension.lastUpdateTimestamp),
    preUpdateAverageRate: extension.preUpdateAverageRate,
    currentRate: extension.currentRate,
  };
}

/**
 * A mint has one display rule: the program refuses a mint that is both scaled
 * and interest-bearing (`check_for_invalid_mint_extension_combinations`).
 */
function onlyDisplayRule(current: DisplayRule, next: DisplayRule): DisplayRule {
  if (current.kind !== "plain") {
    throw invalidExtension("Mint is both scaled and interest-bearing");
  }
  return next;
}

function decodeMintAccount(account: EncodedAccount, program: TokenProgramKind): Mint {
  const size = account.data.length;
  const sizeFits =
    size === MINT_BASE_SIZE || (program === "token-2022" && size > ACCOUNT_TYPE_OFFSET);
  if (!sizeFits) {
    throw new TokenTermsError(TOKEN_TERMS_REFUSALS.notMint, "Account is not a token mint");
  }
  let mint: Mint;
  try {
    mint = decodeMint(account).data;
  } catch (cause) {
    throw new TokenTermsError(
      TOKEN_TERMS_REFUSALS.notMint,
      "Account data does not decode as a token mint",
      { cause }
    );
  }
  if (!mint.isInitialized) {
    throw new TokenTermsError(TOKEN_TERMS_REFUSALS.notMint, "Token mint is not initialized");
  }
  return mint;
}

/**
 * The extension fields of the terms, folded from the mint's TLV entries.
 * Extensions that do not change what a movement does (metadata, groups,
 * permissioned burn) leave the terms unchanged.
 */
function foldExtensions(extensions: readonly Extension[]) {
  let transferFee: TransferFeeSchedule | null = null;
  let display: DisplayRule = { kind: "plain" };
  let transferHookProgram: Address | null = null;
  let transferHookAuthority: Address | null = null;
  let paused = false;
  let nonTransferable = false;
  let defaultAccountState: DefaultAccountState = "initialized";
  let permanentDelegate: Address | null = null;
  let confidentialTransfers = false;
  let mintCloseAuthority: Address | null = null;
  const requiredAccountExtensions: RequiredAccountExtension[] = [];

  for (const extension of extensions) {
    switch (extension.__kind) {
      case "TransferFeeConfig":
        transferFee = {
          older: feeRate(extension.olderTransferFee),
          newer: feeRate(extension.newerTransferFee),
        };
        requiredAccountExtensions.push({ __kind: "TransferFeeAmount", withheldAmount: 0n });
        break;
      // biome-ignore lint/security/noSecrets: an extension name, not a secret.
      case "ScaledUiAmountConfig":
        display = onlyDisplayRule(display, scaledRule(extension));
        break;
      case "InterestBearingConfig":
        display = onlyDisplayRule(display, interestRule(extension));
        break;
      case "TransferHook":
        transferHookProgram = setOrNull(extension.programId);
        transferHookAuthority = setOrNull(extension.authority);
        requiredAccountExtensions.push({ __kind: "TransferHookAccount", transferring: false });
        break;
      case "PausableConfig":
        paused = extension.paused;
        requiredAccountExtensions.push({ __kind: "PausableAccount" });
        break;
      case "NonTransferable":
        nonTransferable = true;
        requiredAccountExtensions.push(
          { __kind: "NonTransferableAccount" },
          { __kind: "ImmutableOwner" }
        );
        break;
      case "DefaultAccountState":
        if (extension.state === AccountState.Uninitialized) {
          throw invalidExtension("Default account state is uninitialized");
        }
        defaultAccountState = extension.state === AccountState.Frozen ? "frozen" : "initialized";
        break;
      case "PermanentDelegate":
        permanentDelegate = setOrNull(extension.delegate);
        break;
      case "MintCloseAuthority":
        mintCloseAuthority = setOrNull(extension.closeAuthority);
        break;
      case "ConfidentialTransferMint":
      case "ConfidentialTransferFee":
      case "ConfidentialMintBurn":
        confidentialTransfers = true;
        break;
      case "MetadataPointer":
      case "TokenMetadata":
      case "GroupPointer":
      case "TokenGroup":
      case "GroupMemberPointer":
      case "TokenGroupMember":
      case "PermissionedBurn":
        break;
      case "Uninitialized":
      case "TransferFeeAmount":
      case "ConfidentialTransferAccount":
      case "ImmutableOwner":
      case "MemoTransfer":
      case "NonTransferableAccount":
      case "CpiGuard":
      case "TransferHookAccount":
      case "ConfidentialTransferFeeAmount":
      case "PausableAccount":
        throw invalidExtension(`Mint carries the account extension ${extension.__kind}`);
      default: {
        const exhaustive: never = extension;
        throw new Error(`Unknown mint extension: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return {
    transferFee,
    display,
    transferHookProgram,
    transferHookAuthority,
    paused,
    nonTransferable,
    defaultAccountState,
    permanentDelegate,
    confidentialTransfers,
    mintCloseAuthority,
    requiredAccountExtensions,
  };
}

/**
 * Decodes Token Terms from a mint account and the Clock sysvar read in the
 * same `getMultipleAccounts` request. Pure: the caller makes the read.
 *
 * @param request - The mint the caller asked for. A catalogue entry names its
 * token program, and the account's owner must match it.
 * @param accounts - The base64 mint account and the Clock sysvar account.
 * @returns The terms at the slot of the read.
 * @throws {TokenTermsError} When the account is not an initialized mint of a
 * token program SDP supports, is owned by another program than `request`
 * names, or carries an extension state the program would refuse.
 * @throws {Error} When the accounts are not the requested mint and the Clock
 * sysvar: the caller passed the wrong accounts.
 */
export function decodeTokenTerms(
  request: TokenAsset | UnreadMint,
  accounts: { mint: EncodedAccount; clock: EncodedAccount }
): MintTokenTerms {
  if (accounts.mint.address !== request.mint) {
    throw new Error(`Expected the mint account ${request.mint}, got ${accounts.mint.address}`);
  }
  if (accounts.clock.address !== SYSVAR_CLOCK_ADDRESS) {
    throw new Error(`Expected the Clock sysvar, got ${accounts.clock.address}`);
  }

  const program = tokenProgramOf(accounts.mint.programAddress);
  if (program === null) {
    throw new TokenTermsError(
      TOKEN_TERMS_REFUSALS.unsupportedProgram,
      "Unsupported token program for mint"
    );
  }
  if (request.kind === "token" && request.program !== program) {
    throw new TokenTermsError(
      TOKEN_TERMS_REFUSALS.programMismatch,
      `Mint ${request.mint} is owned by ${program}, not ${request.program}`
    );
  }

  const mint = decodeMintAccount(accounts.mint, program);
  const clock = decodeAccount(accounts.clock, getSysvarClockDecoder()).data;
  // A classic mint, and a Token-2022 mint without extensions, has no TLV region.
  const extensions = unwrapOption(mint.extensions);
  return {
    asset: { kind: "token", mint: request.mint, program },
    decimals: mint.decimals,
    readAt: { slot: clock.slot, unixTimestamp: clock.unixTimestamp, epoch: clock.epoch },
    freezeAuthority: unwrapOption(mint.freezeAuthority),
    ...foldExtensions(extensions === null ? [] : extensions),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Transfer fee: `transfer_fee/mod.rs`
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The fee entry that applies in `epoch`, as `TransferFeeConfig::get_epoch_fee`:
 * `newer` once `epoch >= newer.epoch`, `older` before.
 *
 * @returns The entry, or null when the mint has no fee config.
 */
export function epochFee(terms: TokenTerms, epoch: Epoch): TransferFeeRate | null {
  if (terms.transferFee === null) {
    return null;
  }
  const { older, newer } = terms.transferFee;
  return epoch >= newer.epoch ? newer : older;
}

/** `TransferFee::calculate_fee`: `min(ceil(amount × bps ÷ 10 000), maximumFee)`, 0 at 0 bps or 0 amount. */
function calculateFee(rate: TransferFeeRate, preFeeAmount: bigint): bigint {
  if (rate.basisPoints === 0 || preFeeAmount === 0n) {
    return 0n;
  }
  const numerator = preFeeAmount * BigInt(rate.basisPoints);
  const rawFee = (numerator + ONE_IN_BASIS_POINTS - 1n) / ONE_IN_BASIS_POINTS;
  return rawFee < rate.maximumFee ? rawFee : rate.maximumFee;
}

/**
 * `TransferFee::calculate_pre_fee_amount`: the program's own inverse of the
 * fee. Null where the program returns `None` (the debit would pass u64).
 */
function calculatePreFeeAmount(rate: TransferFeeRate, postFeeAmount: bigint): bigint | null {
  const maximumFee: bigint = rate.maximumFee;
  const basisPoints = BigInt(rate.basisPoints);
  let preFeeAmount: bigint;
  if (basisPoints === 0n) {
    preFeeAmount = postFeeAmount;
  } else if (postFeeAmount === 0n) {
    preFeeAmount = 0n;
  } else if (basisPoints === ONE_IN_BASIS_POINTS) {
    preFeeAmount = maximumFee + postFeeAmount;
  } else {
    const numerator = postFeeAmount * ONE_IN_BASIS_POINTS;
    const denominator = ONE_IN_BASIS_POINTS - basisPoints;
    const rawPreFeeAmount = (numerator + denominator - 1n) / denominator;
    preFeeAmount =
      rawPreFeeAmount - postFeeAmount >= maximumFee ? postFeeAmount + maximumFee : rawPreFeeAmount;
  }
  return preFeeAmount > U64_MAX ? null : preFeeAmount;
}

/**
 * The fee the program withholds from a transfer that debits `debit` in
 * `epoch`. 0 when the mint has no fee config.
 */
export function feeFor(terms: TokenTerms, debit: BaseUnits, epoch: Epoch): BaseUnits {
  const rate = epochFee(terms, epoch);
  return rate === null ? baseUnits(0n) : baseUnits(calculateFee(rate, debit));
}

/**
 * The smallest debit whose transfer in `epoch` credits exactly `credit`.
 *
 * The credit `debit − fee(debit)` never decreases as the debit grows, and it
 * grows by 0 or 1 per base unit, so every credit is reached exactly, and the
 * first debit that reaches it is the answer. The program's
 * `calculate_pre_fee_amount` gives the first guess; the forward rule confirms
 * it, and a binary search over `[credit, credit + maximumFee]` (the fee never
 * passes `maximumFee`) finds the answer when the guess is not minimal.
 *
 * @throws {AmountError} When no debit in the u64 range credits `credit`.
 */
export function debitForCredit(terms: TokenTerms, credit: BaseUnits, epoch: Epoch): BaseUnits {
  const rate = epochFee(terms, epoch);
  if (rate === null) {
    return credit;
  }
  const creditOf = (debit: bigint) => debit - calculateFee(rate, debit);
  const delivers = (debit: bigint) => creditOf(debit) >= credit;

  const guess = calculatePreFeeAmount(rate, credit);
  if (
    guess !== null &&
    creditOf(guess) === credit &&
    (guess === credit || creditOf(guess - 1n) < credit)
  ) {
    return baseUnits(guess);
  }

  const ceiling = credit + rate.maximumFee;
  let low: bigint = credit;
  let high = ceiling < U64_MAX ? ceiling : U64_MAX;
  if (!delivers(high)) {
    throw new AmountError("No debit within the u64 range credits this amount");
  }
  while (low < high) {
    const middle = (low + high) / 2n;
    if (delivers(middle)) {
      high = middle;
    } else {
      low = middle + 1n;
    }
  }
  return baseUnits(low);
}
