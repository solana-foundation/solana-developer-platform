import { ClientError } from "@heliuslabs/zolana/client";
import { InterfaceError } from "@heliuslabs/zolana/interface";
import { TransactionError } from "@heliuslabs/zolana/transaction";
import { WalletError } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError, type HeliusRingsErrorCode } from "@sdp/helius-rings";
import {
  isSolanaError,
  SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS,
  SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH,
  SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE,
  SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE,
} from "@solana/kit";

/**
 * Turns public Zolana errors into domain codes with fixed messages. Deliberately
 * coarse: each error class gets a default, and only the codes whose default
 * would send an operator the wrong way are listed.
 */

type BridgedErrorCode = Extract<
  HeliusRingsErrorCode,
  "config_error" | "conflict" | "gateway_unavailable" | "invalid_input"
>;

/**
 * The whole message a caller ever sees. Upstream text is never forwarded: it
 * routinely quotes the endpoint it failed on, and the RPC URL carries an API key.
 */
const SAFE_MESSAGES = {
  config_error: "the Rings gateway configuration is invalid",
  conflict: "the Rings wallet state conflicts with the requested operation",
  gateway_unavailable: "a Rings upstream service is unavailable",
  invalid_input: "the Rings request contains invalid input",
} satisfies Record<BridgedErrorCode, string>;

/** Codes whose default classification would send an operator the wrong way. */
const CODE_OVERRIDES: Readonly<Record<string, BridgedErrorCode>> = {
  CLIENT_INVALID_CONFIG: "config_error",
  CLIENT_UNSUPPORTED_RPC_METHOD: "config_error",
  WALLET_INVALID_SYNC_CONFIG: "config_error",
  CLIENT_TREE_MISMATCH: "conflict",
  WALLET_INVALID_USER_RECORD: "conflict",
  WALLET_REGISTERED_KEYPAIR_MISMATCH: "conflict",
  WALLET_USER_RECORD_BUMP_MISMATCH: "conflict",
  WALLET_USER_RECORD_OWNER_MISMATCH: "conflict",
  WALLET_USER_RECORD_PROGRAM_MISMATCH: "conflict",
  WALLET_INVALID_ADDRESS: "invalid_input",
  WALLET_INVALID_AMOUNT: "invalid_input",
  WALLET_INVALID_BASE64: "invalid_input",
  WALLET_INVALID_LENGTH: "invalid_input",
  INTERFACE_INVALID_ACCOUNT_DATA: "gateway_unavailable",
  INTERFACE_CODEC: "gateway_unavailable",
  INTERFACE_HASH: "gateway_unavailable",
};

function bridgedCode(error: unknown): BridgedErrorCode | undefined {
  // Interface and transaction errors are raised constructing or decoding what we
  // asked for, so an unlisted one is our input; client and wallet errors wrap
  // upstream I/O, so an unlisted one is theirs.
  if (error instanceof InterfaceError || error instanceof TransactionError) {
    return CODE_OVERRIDES[error.code] ?? "invalid_input";
  }
  if (error instanceof WalletError) {
    // A wallet wrapper retains the more specific error when there is one.
    return bridgedCode(error.cause) ?? CODE_OVERRIDES[error.code] ?? "gateway_unavailable";
  }
  if (error instanceof ClientError) {
    return CODE_OVERRIDES[error.code] ?? "gateway_unavailable";
  }
  return undefined;
}

function bridgedError(code: BridgedErrorCode): HeliusRingsError {
  return new HeliusRingsError(code, SAFE_MESSAGES[code]);
}

/**
 * Converts only public Zolana errors. Anything else is rethrown verbatim so the
 * API's existing scrubbed fallback still sees it.
 */
export async function withZolanaErrorBridge<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = bridgedCode(error);
    if (code === undefined) throw error;
    // The cause is dropped rather than chained: it can carry endpoints, caller
    // payloads, account data or key material.
    throw bridgedError(code);
  }
}

function isConfiguredTreeAddressError(error: unknown): boolean {
  return (
    isSolanaError(error, SOLANA_ERROR__ADDRESSES__STRING_LENGTH_OUT_OF_RANGE) ||
    isSolanaError(error, SOLANA_ERROR__ADDRESSES__INVALID_BYTE_LENGTH) ||
    isSolanaError(error, SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS) ||
    isSolanaError(error, SOLANA_ERROR__CODECS__INVALID_STRING_FOR_BASE)
  );
}

/**
 * Narrows Kit address failures to the configured-tree parsing site, so a bad
 * tree reads as misconfiguration without echoing the value back.
 */
export function withConfiguredTreeErrorBridge<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!isConfiguredTreeAddressError(error)) throw error;
    throw bridgedError("config_error");
  }
}
