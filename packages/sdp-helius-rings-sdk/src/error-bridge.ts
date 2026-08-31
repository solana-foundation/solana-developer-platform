import {
  ClientError,
  type ClientErrorCode,
  type ClientErrorDetailsMap,
} from "@heliuslabs/zolana/client";
import { InterfaceError, type InterfaceErrorCode } from "@heliuslabs/zolana/interface";
import { RingError, type RingErrorCode } from "@heliuslabs/zolana/ring";
import { TransactionError, type TransactionErrorCode } from "@heliuslabs/zolana/transaction";
import { WalletError, type WalletErrorCode } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError, type HeliusRingsErrorCode } from "@sdp/helius-rings";
import {
  isSolanaError,
  SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS,
  SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH,
  SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE,
  SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE,
} from "@solana/kit";

type BridgedErrorCode = Extract<
  HeliusRingsErrorCode,
  "config_error" | "conflict" | "gateway_unavailable" | "insufficient_balance" | "invalid_input"
>;

const SAFE_MESSAGES = {
  config_error: "the Rings gateway configuration is invalid",
  conflict: "the Rings wallet state conflicts with the requested operation",
  gateway_unavailable: "a Rings upstream service is unavailable",
  insufficient_balance: "the Rings wallet has insufficient spendable balance",
  invalid_input: "the Rings request contains invalid input",
} satisfies Record<BridgedErrorCode, string>;

/**
 * Total over Zolana's public interface boundary. Input construction failures
 * belong to the caller; malformed decoded account data and primitives came
 * from an upstream response or protocol codec.
 */
const INTERFACE_ERROR_CODES_TO_DOMAIN = {
  INTERFACE_INVALID_ADDRESS: "invalid_input",
  INTERFACE_INVALID_LENGTH: "invalid_input",
  INTERFACE_INVALID_INTEGER: "invalid_input",
  INTERFACE_INVALID_DISCRIMINATOR: "invalid_input",
  INTERFACE_INVALID_ACCOUNT_DATA: "gateway_unavailable",
  INTERFACE_INVALID_SHAPE: "invalid_input",
  INTERFACE_TRANSACTION_TOO_LARGE: "invalid_input",
  INTERFACE_HASH: "gateway_unavailable",
  INTERFACE_CODEC: "gateway_unavailable",
} satisfies Record<InterfaceErrorCode, BridgedErrorCode>;

/**
 * Total by construction: a new public WalletError code in Zolana must be
 * classified before this package typechecks.
 */
const WALLET_ERROR_CODES_TO_DOMAIN = {
  WALLET_BUILD_DEPOSIT: "gateway_unavailable",
  WALLET_BUILD_MERGE: "gateway_unavailable",
  WALLET_BUILD_REGISTRATION: "gateway_unavailable",
  WALLET_BUILD_SET_MERGING_ENABLED: "gateway_unavailable",
  WALLET_BUILD_SPLIT: "gateway_unavailable",
  WALLET_BUILD_TRANSFER: "gateway_unavailable",
  WALLET_BUILD_WITHDRAWAL: "gateway_unavailable",
  WALLET_CREATE_DEPOSIT: "gateway_unavailable",
  WALLET_CREATE_TRANSFER: "gateway_unavailable",
  WALLET_DUPLICATE_INPUT_UTXO: "invalid_input",
  WALLET_FETCH_USER_RECORD: "gateway_unavailable",
  WALLET_INPUT_UTXO_TREE_MISMATCH: "conflict",
  WALLET_INPUT_UTXO_UNAVAILABLE: "conflict",
  WALLET_INSUFFICIENT_BALANCE: "insufficient_balance",
  WALLET_INVALID_ADDRESS: "invalid_input",
  WALLET_INVALID_AMOUNT: "invalid_input",
  WALLET_INVALID_BASE64: "invalid_input",
  WALLET_INVALID_LENGTH: "invalid_input",
  WALLET_INVALID_SYNC_CONFIG: "config_error",
  WALLET_INVALID_USER_RECORD: "conflict",
  WALLET_MERGE_DISABLED: "conflict",
  WALLET_MERGE_NULLIFIER_KEY_MISMATCH: "conflict",
  WALLET_MERGE_SIGNING_KEY_MISMATCH: "conflict",
  WALLET_MERGE_TREE_MISMATCH: "gateway_unavailable",
  WALLET_MERGE_VIEWING_KEY_MISMATCH: "conflict",
  WALLET_MISSING_SPL_TOKEN_ACCOUNT: "invalid_input",
  WALLET_MULTIPLE_INPUT_TREES: "conflict",
  WALLET_NO_INPUTS: "invalid_input",
  WALLET_NOTHING_TO_MERGE: "invalid_input",
  WALLET_P256_REGISTRATION_UNSUPPORTED: "invalid_input",
  WALLET_PDA_DERIVATION: "invalid_input",
  WALLET_REGISTERED_KEYPAIR_MISMATCH: "conflict",
  WALLET_RECIPIENT_CLIENT_REQUIRED: "invalid_input",
  WALLET_RECIPIENT_NOT_REGISTERED: "invalid_input",
  WALLET_SELECTED_BALANCE_OVERFLOW: "invalid_input",
  WALLET_SPLIT_INPUT_HAS_DATA: "invalid_input",
  WALLET_SPLIT_INPUT_RING_MISMATCH: "invalid_input",
  WALLET_SPLIT_INVALID_PART_COUNT: "invalid_input",
  WALLET_SPLIT_NOT_DIVISIBLE: "invalid_input",
  WALLET_SYNC: "gateway_unavailable",
  WALLET_TOO_MANY_INPUTS: "invalid_input",
  WALLET_UNSIGNED_INPUT_UNAVAILABLE: "conflict",
  WALLET_USER_RECORD_BUMP_MISMATCH: "conflict",
  WALLET_USER_RECORD_OWNER_MISMATCH: "conflict",
  WALLET_USER_RECORD_PROGRAM_MISMATCH: "conflict",
  WALLET_USER_REGISTRY_RECORD_NOT_FOUND: "conflict",
} satisfies Record<WalletErrorCode, BridgedErrorCode>;

/**
 * ClientError can carry a canonical TransactionError code. Keeping this total
 * preserves balance and unsafe-recovery classifications through that wrapper.
 */
const TRANSACTION_ERROR_CODES_TO_DOMAIN = {
  TRANSACTION_BAD_DISCRIMINATOR: "invalid_input",
  TRANSACTION_DATA_WITHOUT_OUTPUT: "invalid_input",
  TRANSACTION_DESERIALIZE: "invalid_input",
  TRANSACTION_DUMMY_INPUT_NOT_ALLOWED: "invalid_input",
  TRANSACTION_DUPLICATE_ASSET_ID: "invalid_input",
  TRANSACTION_DUPLICATE_DATA_RECORD: "invalid_input",
  TRANSACTION_DUPLICATE_MINT: "invalid_input",
  TRANSACTION_DUPLICATE_OUTPUT: "invalid_input",
  TRANSACTION_ED25519_PAYER_MISMATCH: "invalid_input",
  TRANSACTION_EXCESS_OUTPUT_SLOTS: "invalid_input",
  TRANSACTION_INPUT_OWNER_MISMATCH: "conflict",
  TRANSACTION_INSUFFICIENT_BALANCE: "insufficient_balance",
  TRANSACTION_INVALID_ADDRESS: "invalid_input",
  TRANSACTION_INVALID_AMOUNT: "invalid_input",
  TRANSACTION_INVALID_ASSET_ID: "invalid_input",
  TRANSACTION_INVALID_BLINDING: "invalid_input",
  TRANSACTION_INVALID_DATA_LENGTH: "invalid_input",
  TRANSACTION_INVALID_INTEGER: "invalid_input",
  TRANSACTION_INVALID_LENGTH: "invalid_input",
  TRANSACTION_INVALID_POSITION: "invalid_input",
  TRANSACTION_INVALID_OUTPUT_COUNT: "invalid_input",
  TRANSACTION_INVALID_OUTPUT_POSITION: "invalid_input",
  TRANSACTION_KEYPAIR: "invalid_input",
  TRANSACTION_MERGE_INPUT_ASSET_MISMATCH: "conflict",
  TRANSACTION_MERGE_INPUT_HAS_DATA: "conflict",
  TRANSACTION_MERGE_INPUT_NULLIFIER_KEY_MISMATCH: "conflict",
  TRANSACTION_MERGE_INPUT_OWNER_MISMATCH: "conflict",
  TRANSACTION_MERGE_INPUT_RAIL_MISMATCH: "conflict",
  TRANSACTION_MERGE_INPUT_RING_MISMATCH: "conflict",
  TRANSACTION_MISSING_CURRENT_VIEWING_KEY: "conflict",
  TRANSACTION_MISSING_OUTPUT: "invalid_input",
  TRANSACTION_MISSING_PUBLIC_SPL_ASSET: "invalid_input",
  TRANSACTION_MISSING_RING_PROGRAM_ID: "invalid_input",
  TRANSACTION_MULTIPLE_PUBLIC_SPL_ASSETS: "invalid_input",
  TRANSACTION_NON_CANONICAL_DATA_ORDER: "invalid_input",
  TRANSACTION_NONCANONICAL_DUMMY_INPUT: "invalid_input",
  TRANSACTION_NO_INPUTS: "invalid_input",
  TRANSACTION_ADDRESS_HASH_COUNT_MISMATCH: "invalid_input",
  TRANSACTION_OUTPUT_TAG_MISMATCH: "conflict",
  TRANSACTION_OUTPUT_AMOUNT_MISMATCH: "conflict",
  TRANSACTION_OUTPUT_ASSET_MISMATCH: "conflict",
  TRANSACTION_OUTPUT_BLINDING_MISMATCH: "conflict",
  TRANSACTION_OUTPUT_DATA_MISMATCH: "conflict",
  TRANSACTION_OUTPUT_OWNER_MISMATCH: "conflict",
  TRANSACTION_OUTPUT_SLOT_OVERFLOW: "invalid_input",
  TRANSACTION_OUTPUT_RING_MISMATCH: "conflict",
  TRANSACTION_P256_TRANSACT_UNSUPPORTED: "invalid_input",
  TRANSACTION_POSEIDON: "gateway_unavailable",
  TRANSACTION_PUBLIC_SOL_ALREADY_SET: "invalid_input",
  TRANSACTION_PUBLIC_SPL_ALREADY_SET: "invalid_input",
  TRANSACTION_RESERVED_ASSET_ID: "invalid_input",
  TRANSACTION_SELECTED_BALANCE_OVERFLOW: "invalid_input",
  TRANSACTION_WALLET_BALANCE_OVERFLOW: "invalid_input",
  TRANSACTION_SERIALIZE: "gateway_unavailable",
  TRANSACTION_SIGNATURE_OWNER_MISMATCH: "conflict",
  TRANSACTION_SPLIT_AMOUNT_MISMATCH: "conflict",
  TRANSACTION_SPLIT_INPUT_ASSET_MISMATCH: "conflict",
  TRANSACTION_SPLIT_INPUT_HAS_DATA: "conflict",
  TRANSACTION_SPLIT_INPUT_IS_DUMMY: "conflict",
  TRANSACTION_SPLIT_INPUT_NULLIFIER_KEY_MISMATCH: "conflict",
  TRANSACTION_SPLIT_INPUT_OWNER_MISMATCH: "conflict",
  TRANSACTION_SPLIT_INPUT_RING_MISMATCH: "conflict",
  TRANSACTION_SPLIT_INVALID_PART_COUNT: "invalid_input",
  TRANSACTION_TOO_MANY_INPUTS: "invalid_input",
  TRANSACTION_TOO_MANY_INTERFACE_TRANSFERS: "invalid_input",
  TRANSACTION_TOO_MANY_OUTPUTS: "invalid_input",
  TRANSACTION_TOO_MANY_OUTPUTS_FOR_SHAPE: "invalid_input",
  TRANSACTION_TRAILING_BYTES: "invalid_input",
  TRANSACTION_UNKNOWN_ASSET: "invalid_input",
  TRANSACTION_UNKNOWN_ASSET_FIELD: "invalid_input",
  TRANSACTION_UNKNOWN_MINT: "invalid_input",
  TRANSACTION_UNSUPPORTED_SHAPE: "invalid_input",
  TRANSACTION_WALLET_AUTHORITY_MISMATCH: "conflict",
  TRANSACTION_WITHDRAWAL_ALREADY_SET: "invalid_input",
  TRANSACTION_WITHDRAWAL_ASSET_MISMATCH: "conflict",
  TRANSACTION_ZERO_INTERFACE_TRANSFER_AMOUNT: "invalid_input",
} satisfies Record<TransactionErrorCode, BridgedErrorCode>;

/**
 * Total over both canonical Rust-parity codes and TypeScript boundary codes.
 * There is deliberately no default classification.
 */
const CLIENT_ERROR_CODES_TO_DOMAIN = {
  CLIENT_KEYPAIR: "invalid_input",
  CLIENT_TRANSACTION: "invalid_input",
  CLIENT_HASHER: "gateway_unavailable",
  CLIENT_FEE_PAYER_MISMATCH: "invalid_input",
  CLIENT_TREE_MISMATCH: "conflict",
  CLIENT_NO_INPUTS: "invalid_input",
  CLIENT_MERGE_SIGNING_KEY_MISMATCH: "conflict",
  CLIENT_MERGE_NULLIFIER_KEY_MISMATCH: "conflict",
  CLIENT_MERGE_TREE_MISMATCH: "gateway_unavailable",
  CLIENT_FIELD_TOO_LONG: "invalid_input",
  CLIENT_PROVER_SERVER: "gateway_unavailable",
  CLIENT_PROOF_PARSE: "gateway_unavailable",
  CLIENT_MISSING_INPUT_MERKLE_PROOF: "gateway_unavailable",
  CLIENT_INCOMPLETE_INPUT_PROOFS: "gateway_unavailable",
  CLIENT_STATE_PROOF_LEAF_MISMATCH: "gateway_unavailable",
  CLIENT_STATE_PROOF_TREE_MISMATCH: "gateway_unavailable",
  CLIENT_NULLIFIER_PROOF_LEAF_MISMATCH: "gateway_unavailable",
  CLIENT_NULLIFIER_PROOF_TREE_MISMATCH: "gateway_unavailable",
  CLIENT_MISSING_OUTPUT: "invalid_input",
  CLIENT_RPC: "gateway_unavailable",
  CLIENT_INDEXER: "gateway_unavailable",
  CLIENT_UNSUPPORTED_RPC_METHOD: "config_error",
  CLIENT_INDEXER_TIMEOUT: "gateway_unavailable",
  CLIENT_INDEXER_NOT_CAUGHT_UP: "gateway_unavailable",
  CLIENT_POLL_TIMED_OUT: "gateway_unavailable",
  CLIENT_PROOF_PATH_LENGTH: "gateway_unavailable",
  CLIENT_PROOF_INPUT_COUNT_MISMATCH: "gateway_unavailable",
  CLIENT_INVALID_CONFIG: "config_error",
  CLIENT_UNEXPECTED: "gateway_unavailable",
  CLIENT_INVALID_INTEGER: "invalid_input",
  CLIENT_INVALID_INPUT_CONTEXT: "invalid_input",
  CLIENT_INVALID_PROOF_INPUTS: "invalid_input",
  CLIENT_INVALID_MERGE: "invalid_input",
  CLIENT_MERGE_OUTPUT_MISMATCH: "conflict",
  CLIENT_INVALID_TRANSACTION: "invalid_input",
  CLIENT_TRANSACTION_ASSEMBLY: "gateway_unavailable",
  CLIENT_INVALID_LENGTH: "invalid_input",
  CLIENT_INVALID_FIELD: "invalid_input",
  CLIENT_INVALID_BASE58: "invalid_input",
  CLIENT_INVALID_BASE64: "gateway_unavailable",
  CLIENT_INVALID_P256_KEY: "invalid_input",
  CLIENT_INVALID_CONTEXT: "invalid_input",
  CLIENT_ABORTED: "gateway_unavailable",
  CLIENT_TIMEOUT: "gateway_unavailable",
  CLIENT_REQUEST: "gateway_unavailable",
  CLIENT_INVALID_POLL_CONFIG: "config_error",
  CLIENT_INVALID_INDEXER: "config_error",
  CLIENT_PROOF_POINT: "gateway_unavailable",
  CLIENT_PROOF_TREE_MISMATCH: "gateway_unavailable",
  CLIENT_INVALID_MERGE_OUTPUT: "conflict",
  CLIENT_INVALID_MERGE_MATERIAL: "conflict",
  CLIENT_INVALID_MERGE_SHAPE: "invalid_input",
  CLIENT_PROVER_INPUT: "invalid_input",
  CLIENT_PROVER_REQUEST: "gateway_unavailable",
  CLIENT_PROVER_HTTP: "gateway_unavailable",
  CLIENT_PROVER_JOB: "gateway_unavailable",
  CLIENT_PROVER_TIMEOUT: "gateway_unavailable",
  CLIENT_PROVER_RESPONSE_TOO_LARGE: "gateway_unavailable",
  CLIENT_PROVER_TEXT: "gateway_unavailable",
  CLIENT_PROVER_JSON: "gateway_unavailable",
  CLIENT_INVALID_RPC_RESPONSE: "gateway_unavailable",
} satisfies Record<ClientErrorCode, BridgedErrorCode>;

/**
 * Total by construction, like the wallet map: a new public RingError code in
 * Zolana must be classified before this package typechecks. Build and origin
 * failures wrap upstream I/O; definitive chain-state absences and invariant
 * failures are conflicts the tenant cannot fix by retrying.
 */
const RING_ERROR_CODES_TO_DOMAIN = {
  RING_AUDIT_KEY_MISMATCH: "conflict",
  RING_AUDIT_MESSAGE: "gateway_unavailable",
  RING_AUDIT_UNSEALED: "gateway_unavailable",
  RING_BUILD_DEPOSIT: "gateway_unavailable",
  RING_BUILD_LOOKUP_TABLE: "gateway_unavailable",
  RING_BUILD_TRANSFER: "gateway_unavailable",
  RING_BUILD_WITHDRAWAL: "gateway_unavailable",
  // A ring config that decodes but fails its invariants is chain state this
  // tenant cannot fix by retrying, like the user-record mismatches above.
  RING_CONFIG_INVALID: "conflict",
  RING_CONFIG_NOT_FOUND: "conflict",
  RING_DATA_OUTSIDE_RING: "invalid_input",
  RING_FOREIGN_RING: "invalid_input",
  RING_INSUFFICIENT_BALANCE: "insufficient_balance",
  RING_INVALID_LENGTH: "invalid_input",
  RING_LOOKUP_TABLE_INCOMPLETE: "gateway_unavailable",
  RING_LOOKUP_TABLE_NOT_FOUND: "conflict",
  RING_MULTIPLE_INPUT_TREES: "conflict",
  RING_ORIGIN_DECODE: "gateway_unavailable",
  RING_ORIGIN_STACK: "gateway_unavailable",
  RING_ORIGIN_UNAVAILABLE: "gateway_unavailable",
  RING_PADDED_CHANGE: "gateway_unavailable",
  RING_PASSKEY: "invalid_input",
  RING_PROOF_LENGTH: "invalid_input",
  RING_READ_ACCESS_RECORD_INVALID: "conflict",
  RING_READ_CURSOR: "invalid_input",
  RING_READ_LIMIT: "invalid_input",
  RING_READER_KEY: "invalid_input",
  RING_RESERVED_AUDITOR_KEY: "conflict",
  RING_RPC: "gateway_unavailable",
  RING_RPC_TRANSPORT: "gateway_unavailable",
  RING_TOO_MANY_INPUTS: "invalid_input",
} satisfies Record<RingErrorCode, BridgedErrorCode>;

function clientErrorCode(error: ClientError): BridgedErrorCode {
  if (error.code === "CLIENT_TRANSACTION") {
    const details = error.details as ClientErrorDetailsMap["CLIENT_TRANSACTION"] | undefined;
    if (details) {
      return TRANSACTION_ERROR_CODES_TO_DOMAIN[details.code];
    }
  }

  return CLIENT_ERROR_CODES_TO_DOMAIN[error.code];
}

function bridgedCode(error: unknown): BridgedErrorCode | undefined {
  if (error instanceof InterfaceError) {
    return INTERFACE_ERROR_CODES_TO_DOMAIN[error.code];
  }

  if (error instanceof WalletError) {
    // Wallet wrappers retain the more specific Zolana error when one exists.
    // Its classification wins over the generic wallet build/fetch/sync code.
    if (error.cause instanceof InterfaceError) {
      return INTERFACE_ERROR_CODES_TO_DOMAIN[error.cause.code];
    }
    if (error.cause instanceof ClientError) {
      return clientErrorCode(error.cause);
    }
    if (error.cause instanceof TransactionError) {
      return TRANSACTION_ERROR_CODES_TO_DOMAIN[error.cause.code];
    }
    return WALLET_ERROR_CODES_TO_DOMAIN[error.code];
  }

  if (error instanceof RingError) {
    // Ring wrappers retain the more specific Zolana error the same way.
    if (error.cause instanceof InterfaceError) {
      return INTERFACE_ERROR_CODES_TO_DOMAIN[error.cause.code];
    }
    if (error.cause instanceof ClientError) {
      return clientErrorCode(error.cause);
    }
    if (error.cause instanceof TransactionError) {
      return TRANSACTION_ERROR_CODES_TO_DOMAIN[error.cause.code];
    }
    return RING_ERROR_CODES_TO_DOMAIN[error.code];
  }

  if (error instanceof ClientError) {
    return clientErrorCode(error);
  }

  if (error instanceof TransactionError) {
    return TRANSACTION_ERROR_CODES_TO_DOMAIN[error.code];
  }

  return undefined;
}

function bridgedError(code: BridgedErrorCode): HeliusRingsError {
  return new HeliusRingsError(code, SAFE_MESSAGES[code]);
}

function throwBridgedError(error: unknown): never {
  const code = bridgedCode(error);
  if (code === undefined) throw error;

  // Never retain the upstream cause or details: either can contain endpoints,
  // caller payloads, account data, or key material.
  throw bridgedError(code);
}

/**
 * Converts only public Zolana errors. Unknown errors are rethrown verbatim so
 * the API's existing scrubbed gateway fallback remains unchanged.
 */
export async function withZolanaErrorBridge<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throwBridgedError(error);
  }
}

/** Synchronous variant for Zolana helpers used during transaction assembly. */
export function withZolanaErrorBridgeSync<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throwBridgedError(error);
  }
}

function isConfiguredAddressError(error: unknown): boolean {
  return (
    isSolanaError(error, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE) ||
    isSolanaError(error, SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH) ||
    isSolanaError(error, SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS) ||
    isSolanaError(error, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE)
  );
}

/**
 * Narrows Kit address failures to a configured-address parsing site (the tree
 * or a pinned ring program id). The same SolanaError codes thrown elsewhere
 * remain untouched.
 */
export function withConfiguredAddressErrorBridge<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!isConfiguredAddressError(error)) throw error;
    throw bridgedError("config_error");
  }
}
