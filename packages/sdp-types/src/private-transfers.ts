export const PRIVATE_TRANSFER_PROVIDERS = ["magicblock"] as const;
export type PrivateTransferProviderId = (typeof PRIVATE_TRANSFER_PROVIDERS)[number];

export type MagicBlockPrivateTransferBalance = "base" | "shielded";
export type MagicBlockPrivateTransferSettlement = "base" | "shielded";

/**
 * MagicBlock options for building a private SPL transfer.
 *
 * The public API uses SDP product terminology for base and shielded balances;
 * the API adapter maps those fields to MagicBlock's provider-facing request
 * shape.
 */
export interface MagicBlockPrivateTransferOptions {
  /**
   * Where the sender funds come from. Defaults to `base`, the normal Solana
   * token balance. `shielded` means the sender is spending from MagicBlock's
   * private ephemeral-rollup balance.
   */
  sourceBalance?: MagicBlockPrivateTransferBalance;

  /**
   * Where the recipient receives funds. `base` settles to the normal Solana
   * token balance; `shielded` leaves the funds in MagicBlock's private balance.
   */
  settlement: MagicBlockPrivateTransferSettlement;

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
   * Kept as a string because MagicBlock accepts this field as an integer string.
   */
  minDelayMs?: string;

  /**
   * Latest settlement delay in milliseconds. Must be greater than or equal to
   * `minDelayMs`. Kept as a string because MagicBlock accepts this field as an
   * integer string.
   */
  maxDelayMs?: string;

  /**
   * Client reference encrypted by MagicBlock for payment correlation. Kept as
   * a string because MagicBlock accepts this field as an integer string.
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
  magicBlock: MagicBlockPrivateTransferOptions;
}

export type PrivateTransferRequest = MagicBlockPrivateTransferRequest;
