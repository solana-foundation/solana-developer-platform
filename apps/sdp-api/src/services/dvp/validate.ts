/**
 * Client-side pre-flight for DvP trade terms.
 *
 * Every rule here is one the on-chain program enforces itself, so this changes no
 * outcome. What it changes is the error: without it a bad expiry costs a
 * round-trip and comes back as `custom program error: 0x5`, which tells a caller
 * nothing. The program's README puts these obligations on the client explicitly.
 *
 * Deliberately does NOT cover the checks that need chain state: blocked mint
 * extensions (error 10), party signer-capability (error 22), or a preloaded
 * escrow (error 18). Those need account reads and are handled where the trade is
 * built, not here.
 */

/** Seconds in a year, matching the program's expiry cap. */
const ONE_YEAR_SECONDS = 365n * 24n * 60n * 60n;

/** Maximum bytes of `ref_string`, which is stored zero-padded at a fixed width. */
const MAX_REF_STRING_BYTES = 64;

export interface DvpTradeTerms {
  userA: string;
  userB: string;
  settlementAuthority: string;
  mintA: string;
  mintB: string;
  amountA: bigint;
  amountB: bigint;
  expiryTimestamp: bigint;
  earliestSettlementTimestamp: bigint | null;
  refString: string | null;
}

/**
 * Returns every problem with the terms, empty when they are sound. Reports all
 * of them rather than the first so a caller fixes one payload instead of
 * discovering the next failure on the next request.
 *
 * @param terms - The trade as the caller wants it created.
 * @param nowSeconds - Unix seconds to judge the time bounds against.
 */
export function validateDvpTerms(terms: DvpTradeTerms, nowSeconds: number): string[] {
  const problems: string[] = [];
  const now = BigInt(nowSeconds);

  if (terms.userA === terms.userB) {
    problems.push("userA and userB must differ");
  }
  if (terms.mintA === terms.mintB) {
    problems.push("mintA and mintB must differ");
  }
  if (terms.settlementAuthority === terms.userA || terms.settlementAuthority === terms.userB) {
    problems.push("settlementAuthority must not be userA or userB");
  }
  if (terms.amountA <= 0n) {
    problems.push("amountA must be greater than 0");
  }
  if (terms.amountB <= 0n) {
    problems.push("amountB must be greater than 0");
  }
  if (terms.expiryTimestamp <= now) {
    problems.push("expiryTimestamp must be in the future");
  }
  if (terms.expiryTimestamp > now + ONE_YEAR_SECONDS) {
    problems.push("expiryTimestamp must be within one year");
  }
  if (
    terms.earliestSettlementTimestamp !== null &&
    terms.earliestSettlementTimestamp > terms.expiryTimestamp
  ) {
    problems.push("earliestSettlementTimestamp must not be after expiryTimestamp");
  }
  // Bytes, not characters: the field is a fixed 64-byte array, so any multi-byte
  // UTF-8 makes a .length check wrong in the caller's favour.
  if (
    terms.refString !== null &&
    Buffer.byteLength(terms.refString, "utf8") > MAX_REF_STRING_BYTES
  ) {
    problems.push(`refString must be at most ${MAX_REF_STRING_BYTES} bytes`);
  }

  return problems;
}
