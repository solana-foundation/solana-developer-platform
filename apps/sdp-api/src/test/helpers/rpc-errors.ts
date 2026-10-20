import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";

/**
 * The error `@solana/kit`'s HTTP transport throws for a non-2xx RPC response.
 *
 * @param statusCode - The HTTP status the RPC answered with.
 * @returns A kit `SolanaError` carrying the status on `context.statusCode`.
 */
export function rpcHttpError(
  statusCode: number
): SolanaError<typeof SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR> {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(),
    message: `HTTP error (${statusCode})`,
    statusCode,
  });
}

/**
 * The error `@solana/kit` throws when `sendTransaction`'s preflight simulation refuses a
 * transaction, which proves it was never broadcast.
 *
 * @param customProgramErrorCode - A custom program error to carry as the cause, if any.
 * @returns A kit `SolanaError` for the refused send.
 */
export function sendTransactionPreflightError(customProgramErrorCode?: number): SolanaError {
  const cause =
    customProgramErrorCode === undefined
      ? undefined
      : new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
          code: customProgramErrorCode,
          index: 0,
        });
  return new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    fee: null,
    loadedAccountsDataSize: null,
    loadedAddresses: null,
    logs: null,
    postBalances: null,
    postTokenBalances: null,
    preBalances: null,
    preTokenBalances: null,
    replacementBlockhash: null,
    returnData: null,
    unitsConsumed: null,
    ...(cause === undefined ? {} : { cause }),
  });
}
