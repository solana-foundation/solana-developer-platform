import type { SolanaCluster } from "@sdp/types";
import type { Address, Instruction, Slot, TransactionSigner } from "@solana/kit";

/**
 * The boundary contract for `@sdp/kamino`.
 *
 * TWO RULES HOLD FOR EVERY TYPE IN THIS FILE, and both are load-bearing:
 *
 * 1. **Money is a decimal string, never a float and never a `Decimal`.** The
 *    repo-wide rule (`@sdp/earn` CLAUDE.md → Contracts) is that USD/amount
 *    values in contract types are decimal strings, converted at the provider
 *    boundary. `decimal.js` is klend-sdk's currency, so it lives strictly inside
 *    `./sdk.ts` — a `Decimal` crossing this boundary would also drag in the
 *    instance-identity hazard (two physical copies of decimal.js make
 *    klend-sdk's `instanceof` checks fail as NaN rather than as a type error).
 * 2. **Nothing here references a klend-sdk type.** Every type is either from
 *    `@solana/kit` (the version THIS repo pins) or from `@sdp/types`. That is
 *    what makes `./sdk.ts` a firewall rather than a convention.
 */

/** Which cluster a call runs against, and how to reach it. */
export interface KaminoRuntime {
  cluster: SolanaCluster;
  /**
   * RPC endpoint for `cluster`. Supplied by the caller rather than read from
   * env: `syncEarnCatalogue` walks both environments inside ONE process with
   * one env object, so a process-level `SOLANA_RPC_URL` cannot be trusted to
   * match the cluster being served — the mistake `listKaminoDevnetVaults` guards
   * with a genesis-hash check.
   */
  rpcUrl: string;
}

/**
 * A built, unsigned unit of work: instructions plus what the caller needs to
 * compile them.
 *
 * `instructions` is the complete sequence for one transaction.
 */
export interface KaminoInstructionPlan {
  cluster: SolanaCluster;
  instructions: readonly Instruction[];
  /**
   * Address lookup tables the caller SHOULD apply when compiling. Kamino
   * publishes a per-vault LUT precisely because these account lists are large.
   */
  lookupTables: readonly Address[];
  /** Asset mints observed from the same live vault state used to build. */
  assetIdentity: KaminoVaultAssetIdentity;
  /** What the instructions above actually encode. See `KaminoAcceptedAmounts`. */
  accepted: KaminoAcceptedAmounts;
  /**
   * True when these instructions create the owner's share ATA, charging its
   * rent to `rentPayer`. See `EarnVaultTransactionPlan.createsShareAccount`.
   */
  createsShareAccount?: boolean;
}

/** Live K-Vault asset identity carried with a built instruction plan. */
export interface KaminoVaultAssetIdentity {
  /** Mint consumed by a deposit. */
  depositTokenMint: Address;
  /** Mint issued as the vault receipt/share token. */
  shareMint: Address;
}

/**
 * The amounts as ENCODED, canonicalised to each mint's own precision.
 *
 * Exists because the requested amount and the encoded amount are not
 * necessarily the same number: klend-sdk converts every `Decimal` to mint atoms
 * and FLOORS. This package refuses anything that would lose value to that floor
 * (`amountTooPrecise`), so these values are always exactly equal to the request
 * in magnitude — but they are re-serialised from the mint's decimals, so
 * `"1.500"` comes back as `"1.5"`. The ledger should persist THESE, not the raw
 * request string: a movement row is a claim about what moved on chain, and only
 * this side of the boundary knows the mint's precision.
 */
export interface KaminoAcceptedAmounts {
  /** Deposit amount, canonical to the vault token mint's decimals. */
  amount?: string;
  /** Share floor, canonical to the share mint's decimals. */
  minSharesOut?: string;
  /** Shares redeemed, canonical to the share mint's decimals. */
  shares?: string;
}

export interface KaminoDepositInput {
  /** The K-Vault's own account address — its `providerReference` in the catalogue. */
  vault: Address;
  /**
   * The wallet whose tokens move and whose shares are minted. An SDP custody
   * wallet's `TransactionSigner`, resolved by the API's signing service.
   */
  owner: TransactionSigner;
  /**
   * Rent payer for any associated token account this deposit has to create.
   *
   * STILL NOT the transaction fee payer, and the distinction is the reason this
   * field has its own name: klend-sdk embeds this signer INSIDE the instruction
   * accounts as writable+signer, so whoever is named here funds ATA rent, a real
   * spend separate from the network fee. Defaults to `owner` when omitted.
   *
   * Naming SDP's Kora sponsor here IS now correct, on devnet, and deliberate.
   * This comment previously argued the opposite, so here is what changed rather
   * than a silent reversal. The objection was that a sponsor would be billed for
   * rent (a) its `FeePayerPolicy` might refuse and (b) the sponsorship budget did
   * not account for. Both were checked:
   *
   * - (a) Kora gates fee-payer-funded ATA creation on exactly one flag,
   *   `fee_payer_policy.system.allow_create_account`, which devnet already sets
   *   true and mainnet deliberately does not. Its own CI pins that asymmetry.
   * - (b) The budget prices this correctly, because the SAME flag is one of the
   *   authorities that makes the reservation `networkFee + max_allowed_lamports`
   *   rather than the fee alone. On devnet that reserves ~9.9M lamports against
   *   ~2.04M of actual ATA rent, so it over-reserves rather than under-accounts.
   *
   * The objection's remaining sting is answered by the exit rather than argued
   * away: klend never closes the share ATA, so its rent used to sit locked in a
   * zero-share account forever no matter who paid. `buildShareAccountCloseInstruction`
   * now closes it on a full exit and names the RECORDED funder as the
   * destination, which makes sponsored rent a float rather than a giveaway. The
   * caller must persist that funder at deposit time, because the fee mode may
   * differ by the time the position is exited. See
   * docs/decisions/0002-earn-provider-pluggability.md.
   */
  rentPayer?: TransactionSigner;
  /** Deposit amount in the vault token's own units, as a decimal string. */
  amount: string;
  /**
   * Minimum shares to accept, as a decimal string — slippage protection.
   * Omitted means no floor, which is what Kamino's own examples do; the API
   * should compute one from the live exchange rate rather than pass `"0"` and
   * call it protection.
   */
  minSharesOut?: string;
}

export interface KaminoWithdrawInput {
  vault: Address;
  owner: TransactionSigner;
  /**
   * As on `KaminoDepositInput`, and in V1 a no-op worth passing anyway.
   *
   * klend's exit emits an idempotent create for the owner's deposit-token ATA,
   * but that account must already exist for the deposit to have succeeded and
   * nothing closes it, so the create costs no rent. Passing the sponsor keeps
   * both directions reading the same and covers a provider whose exit DOES
   * create an account without another change at the call site.
   */
  rentPayer?: TransactionSigner;
  /** Shares to redeem, as a decimal string. */
  shares: string;
  /**
   * Where the share ATA's reclaimed rent goes when this exit empties it.
   *
   * klend's own exit never closes the account, so its rent would otherwise stay
   * locked in an account holding zero shares forever. Defaults to `owner`, which
   * is correct whenever the owner funded it. See
   * `EarnVaultWithdrawInput.rentRefundTo` for why the caller must pass the
   * RECORDED funder rather than a currently-configured sponsor.
   */
  rentRefundTo?: Address;
  /**
   * Slot the withdrawal is priced against. Required by klend-sdk and by the
   * reserve math; the caller reads it once so every reserve calculation uses
   * the same slot.
   */
  slot: Slot;
}

/** One wallet's holding in one K-Vault, read live from chain. */
export interface KaminoPosition {
  vault: Address;
  owner: Address;
  cluster: SolanaCluster;
  /** Shares held, as a decimal string. */
  shares: string;
  /** Unstaked shares available to the vault withdrawal builder. */
  withdrawableShares: string;
  /**
   * Current value of those shares in the vault's deposit token, as a decimal
   * string. Undefined when the exchange rate could not be read — the caller
   * renders "—" rather than a fabricated figure.
   */
  tokenValue?: string;
  /** The vault's deposit-token mint, so callers need no second lookup. */
  tokenMint: Address;
  sharesMint: Address;
}
