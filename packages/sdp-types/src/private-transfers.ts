export const PRIVATE_TRANSFER_PROVIDERS = ["magicblock"] as const;
export type PrivateTransferProviderId = (typeof PRIVATE_TRANSFER_PROVIDERS)[number];

/**
 * Balance location terms are provider-facing values used by MagicBlock.
 *
 * `base` means the token balance is held on base Solana. `ephemeral` means the
 * balance is held inside MagicBlock's ephemeral/private rollup.
 */
export type PrivateTransferBalanceLocation = "base" | "ephemeral";

/**
 * `private` routes the transfer through a private-transfer provider.
 * `public` leaves the transfer transparent on base Solana when the provider supports it.
 */
export type PrivateTransferVisibility = "public" | "private";

/**
 * MagicBlock-specific pass-through options for building a private SPL transfer.
 *
 * The outer `privateTransfer` object is provider-agnostic; this nested object
 * intentionally preserves MagicBlock's request terms so the API adapter can map
 * to MagicBlock without losing semantics once payments endpoints expose private
 * transfer support.
 */
export interface MagicBlockPrivateTransferOptions {
  /** Public SPL transfer or private transfer through MagicBlock's Private Ephemeral Rollup. */
  visibility?: PrivateTransferVisibility;

  /** Sender balance location: base Solana or MagicBlock ephemeral/private rollup. */
  fromBalance?: PrivateTransferBalanceLocation;

  /** Recipient balance location: base Solana or MagicBlock ephemeral/private rollup. */
  toBalance?: PrivateTransferBalanceLocation;

  /** Optional MagicBlock validator pubkey. MagicBlock can resolve this when omitted. */
  validator?: string;

  /** Initialize the MagicBlock transfer queue when it does not exist. */
  initIfMissing?: boolean;

  /** Initialize required associated token accounts when they do not exist. */
  initAtasIfMissing?: boolean;

  /** Initialize the MagicBlock vault when it does not exist. */
  initVaultIfMissing?: boolean;

  /**
   * Earliest settlement delay in milliseconds for a queued private transfer.
   * Kept as a string to preserve MagicBlock's pass-through request shape.
   */
  minDelayMs?: string;

  /**
   * Latest settlement delay in milliseconds. Must be greater than or equal to
   * `minDelayMs`. Kept as a string to preserve MagicBlock's pass-through
   * request shape.
   */
  maxDelayMs?: string;

  /**
   * Client reference encrypted by MagicBlock for payment correlation. Kept as
   * a string to preserve MagicBlock's pass-through request shape.
   */
  clientRefId?: string;

  /** Number of queue entries to split the transfer across. MagicBlock supports 1 through 15. */
  split?: number;

  /** Request MagicBlock sponsor fee-payer behavior when supported by the route. */
  gasless?: boolean;

  /** Request MagicBlock's legacy transaction mode instead of its default v0 transaction mode. */
  legacy?: boolean;
}

/**
 * Private-transfer routing request for MagicBlock.
 *
 * Future providers should add new discriminated union members instead of
 * overloading the MagicBlock-specific options.
 */
export interface MagicBlockPrivateTransferRequest {
  provider: "magicblock";
  magicBlock?: MagicBlockPrivateTransferOptions;
}

export type PrivateTransferRequest = MagicBlockPrivateTransferRequest;
