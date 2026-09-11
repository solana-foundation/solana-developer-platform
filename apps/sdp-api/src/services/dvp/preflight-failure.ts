import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";
import { type AppError, transactionFailed } from "@/lib/errors";

const DIAGNOSTIC_LOG_LINE = /^Program (?:log: Error: |.* failed: )/;
const PROGRAM_ERROR_LINE = /^Program log: Error: /;

/**
 * Converts a Solana send-transaction simulation rejection into an API error
 * while preserving the program diagnostic and simulation logs.
 *
 * @param error - The value thrown while submitting a signed transaction.
 * @param what - Human-readable description of the transaction being submitted.
 * @returns A transaction-failed API error for a preflight rejection, otherwise null.
 */
export function preflightFailure(error: unknown, what: string): AppError | null {
  if (
    !isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
  ) {
    return null;
  }

  const logs = error.context.logs;
  const diagnosticLines =
    logs === null ? [] : logs.filter((line) => DIAGNOSTIC_LOG_LINE.test(line));
  const programErrorLines = diagnosticLines.filter((line) => PROGRAM_ERROR_LINE.test(line));
  const lastProgramError = programErrorLines.at(-1);
  const lastDiagnostic = diagnosticLines.at(-1);
  let diagnostic = error.message;
  if (lastProgramError !== undefined) {
    diagnostic = lastProgramError;
  } else if (lastDiagnostic !== undefined) {
    diagnostic = lastDiagnostic;
  }

  return transactionFailed(`${what} was rejected in simulation: ${diagnostic}`, { logs });
}
