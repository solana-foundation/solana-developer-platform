import type { SolanaCluster } from "@sdp/types";
import type { Address, Instruction } from "@solana/kit";

/**
 * The boundary contract for `@sdp/veda`.
 *
 * TWO RULES HOLD FOR EVERY TYPE IN THIS FILE, and both are load-bearing:
 *
 * 1. **Money is a decimal string at this boundary, never a float and never an
 *    atomic `bigint`.** The repo-wide rule (`@sdp/earn` CLAUDE.md → Contracts)
 *    is that amount values in contract types are decimal strings, converted at
 *    the provider boundary. Veda's SDK speaks atomic `bigint` throughout, so
 *    the conversion — and the refusal to lose precision doing it — happens
 *    inside `./sdk.ts`.
 * 2. **Nothing here references a `@vedatech/svm-sdk` type.** Every type is
 *    either from `@solana/kit` (the version THIS repo pins, 6.8) or from
 *    `@sdp/types`. That is what makes `./sdk.ts` a firewall rather than a
 *    convention: the SDK is built against `@solana/kit` 7 and pnpm nests its
 *    own copy, so a leaked type would put two kit majors in one signature.
 */

/** Which cluster a call runs against, and how to reach it. */
export interface VedaRuntime {
  cluster: SolanaCluster;
  /**
   * RPC endpoint for `cluster`. Supplied by the caller rather than read from
   * env: one API process serves BOTH SDP environments, so a process-level
   * `SOLANA_RPC_URL` cannot be trusted to match the cluster being served. The
   * API proves the endpoint's genesis before handing it over.
   */
  rpcUrl: string;
}

/**
 * A built, unsigned unit of work: instructions plus what the caller needs to
 * compile them.
 *
 * `instructions` is the complete sequence for one transaction. A Veda deposit
 * always fits one: it touches one vault and creates at most two idempotent
 * associated token accounts.
 *
 * ORDER IS SIGNIFICANT. Veda's plans can carry `protectedInstructionGroups` —
 * an Ed25519 compliance verification that must sit immediately before the
 * deposit instruction — so a caller may append to the sequence but must never
 * reorder or split it.
 */
export interface VedaInstructionPlan {
  cluster: SolanaCluster;
  instructions: readonly Instruction[];
  /**
   * Address lookup tables the caller should apply when compiling. Always empty
   * today: a Veda deposit fits one packet, and the field exists so callers
   * compile against the shape an exit will need.
   */
  lookupTables: readonly Address[];
  /** Asset mints observed from the same live vault state used to build. */
  assetIdentity: VedaVaultAssetIdentity;
  /** What the instructions above actually encode. See `VedaAcceptedAmounts`. */
  accepted: VedaAcceptedAmounts;
  /**
   * True when these instructions CREATE the owner's share token account, so
   * its rent is charged on this transaction — read from the chain at build
   * time, because the create is idempotent and its mere presence proves
   * nothing. Absent when the plan carries no share-account create at all.
   * Same contract (and same pre-execution residual) as
   * `EarnVaultTransactionPlan.createsShareAccount` in `@sdp/earn`.
   */
  createsShareAccount?: boolean;
}

/** Live Veda vault asset identity carried with a built instruction plan. */
export interface VedaVaultAssetIdentity {
  /** Mint consumed by the deposit — the vault asset SDP resolved. */
  depositTokenMint: Address;
  /** Mint of the vault's Token-2022 share token. */
  shareMint: Address;
}

/**
 * The amounts as ENCODED, canonicalised to each mint's own precision.
 *
 * Exists because the requested amount and the encoded amount need not be the
 * same number in general — a chain SDK converting decimals to atoms typically
 * floors. This package refuses anything that would lose value to that
 * conversion, so these values always equal the request in magnitude, but they
 * are re-serialised from the mint's decimals: `"1.500"` comes back as `"1.5"`.
 * The ledger should persist THESE, not the raw request string; only this side
 * of the boundary knows the mint's precision.
 */
export interface VedaAcceptedAmounts {
  /** Deposit amount, canonical to the deposit mint's decimals. */
  amount?: string;
  /** Share floor, canonical to the share mint's decimals. */
  minSharesOut?: string;
  /** Shares redeemed, canonical to the share mint's decimals. */
  shares?: string;
  /** Exit floor, canonical to the deposit mint's decimals. */
  minAmountOut?: string;
}

export interface VedaDepositInput {
  /** The vault-state account address — its `providerReference` in the catalogue. */
  vault: Address;
  /**
   * The wallet whose tokens move and whose shares are minted.
   *
   * An ADDRESS, not a signer: custody lives in the API and a private key must
   * never reach a provider client. Veda's SDK accepts `owner` for exactly this
   * reason and substitutes a noop signer internally, so the accounts are placed
   * correctly and nothing is signed here.
   *
   * It is also the DEFAULT rent payer for the associated token accounts the
   * plan creates idempotently (the owner's share account, and the vault's
   * asset account when absent) — see `rentPayer`.
   */
  owner: Address;
  /**
   * Who funds rent for the token accounts this plan creates. Omitted means the
   * owner pays, which is what an unsponsored deposit wants.
   *
   * Veda's SDK offers no payer knob — it names the owner as the funding payer
   * of every ATA create it emits — so honoring this means REWRITING those
   * creates' funding account after the build (`./rent.ts`). NOT the
   * transaction fee payer: this address lands inside the instruction accounts
   * as writable+signer, and the API's paymaster supplies its signature after
   * compilation, exactly as on the Kamino client.
   */
  rentPayer?: Address;
  /** Deposit amount in the vault asset's own units, as a decimal string. */
  amount: string;
  /**
   * Minimum shares to accept, as a decimal string.
   *
   * REQUIRED, unlike Kamino's. Veda's SDK refuses to apply an implicit slippage
   * tolerance — `buildDeposit` throws `SLIPPAGE_PROTECTION_REQUIRED` without
   * either a floor or a bps tolerance — and SDP does not invent one on a
   * caller's behalf, so the requirement is passed through rather than papered
   * over with a default.
   */
  minSharesOut: string;
}

export interface VedaWithdrawInput {
  /** The vault-state account address — its `providerReference` in the catalogue. */
  vault: Address;
  /**
   * The wallet whose shares are burned and whose token account is paid. An
   * ADDRESS, not a signer — custody lives in the API, same as the deposit.
   */
  owner: Address;
  /**
   * Who funds rent for the token accounts this plan creates — an instant exit
   * creates the owner's ASSET account idempotently when it is missing. Same
   * semantics and same rewrite mechanism as the deposit's `rentPayer`; omitted
   * means the owner pays.
   */
  rentPayer?: Address;
  /** Shares to redeem, canonical to the share mint's decimals. */
  shares: string;
  /**
   * Minimum deposit-token amount to accept, in the vault asset's own units.
   * REQUIRED: Veda's SDK refuses an implicit slippage tolerance on the way out
   * exactly as it does on the way in, and SDP does not invent one.
   */
  minAmountOut: string;
}

export interface VedaWithdrawQuoteInput {
  /** The vault-state account address — its `providerReference` in the catalogue. */
  vault: Address;
  /** Shares to redeem, canonical to the share mint's decimals. */
  shares: string;
}

/**
 * What redeeming these shares would pay RIGHT NOW — the exit twin of
 * `VedaDepositQuote`, and the read an exit floor is derived from. The figure is
 * the vault's own accounting including its oracle and any withdraw premium.
 */
export interface VedaWithdrawQuote {
  /** Deposit-token amount at the live rate, decimal string at token scale. */
  assetsOut: string;
  /** The deposit token's decimals — the scale a floor must be quantized to. */
  assetDecimals: number;
  /** Blocking conditions the vault reports, empty when the exit would go. */
  issues: readonly VedaDepositQuoteIssue[];
}

export interface VedaDepositQuoteInput {
  /** The vault-state account address — its `providerReference` in the catalogue. */
  vault: Address;
  /** Deposit amount in the vault asset's own units, as a decimal string. */
  amount: string;
}

/** A vault-reported condition that would block the quoted deposit. */
export interface VedaDepositQuoteIssue {
  /** The SDK's stable issue code (e.g. `TELLER_PAUSED`), passed through. */
  code: string;
  message: string;
}

/**
 * What the vault would mint for an amount RIGHT NOW — the read a slippage
 * floor is derived from. Commits to nothing; the floor a caller derives from
 * it covers only the state moving between this quote and the transaction
 * landing.
 */
export interface VedaDepositQuote {
  /** Shares at the live rate, as a decimal string at the share mint's scale. */
  sharesOut: string;
  /** The share mint's decimals — the scale a floor must be quantized to. */
  shareDecimals: number;
  /** Blocking conditions the vault reports, empty when the deposit would go. */
  issues: readonly VedaDepositQuoteIssue[];
}

export interface VedaPositionInput {
  vault: Address;
  owner: Address;
}

/** One wallet's holding in one Veda vault, read live. */
export interface VedaPosition {
  vault: Address;
  owner: Address;
  cluster: SolanaCluster;
  /** Shares held, as a decimal string at the share mint's scale. */
  shares: string;
  /**
   * Shares redeemable RIGHT NOW, at the same scale. A Boring vault locks the
   * whole share account until `unlockTimestamp` after each deposit, so this is
   * `shares` once that instant passes and `0` before it — never a number in
   * between, and never a claim the chain state does not make.
   */
  withdrawableShares: string;
  /**
   * What those shares are worth in the vault's SDP-facing deposit asset, as a
   * decimal string. Undefined when the valuation could not be read — the caller
   * renders "—" rather than a fabricated figure.
   */
  tokenValue?: string;
  /** The deposit asset SDP fronts for this vault. */
  tokenMint: Address;
  shareMint: Address;
}
