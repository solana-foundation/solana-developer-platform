/**
 * Mosaic Utilities
 *
 * Pure functions for Mosaic operations.
 * Extracted from MosaicService for testability.
 */

/**
 * JSON stringify replacer that handles BigInt values by converting them to strings.
 * Solana RPC responses often contain bigints (slots, lamports) that JSON.stringify can't handle.
 */
export function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Safely stringify a value that may contain BigInt values.
 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, bigIntReplacer);
}
