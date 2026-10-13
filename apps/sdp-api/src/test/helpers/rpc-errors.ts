import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";

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
