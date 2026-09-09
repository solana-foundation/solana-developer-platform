/**
 * Agreed-terms check for a `SwapDvp`, the half `verifySwapDvp` cannot cover.
 *
 * `CreateDvp` is permissionless and only the payer signs, so anyone can open a
 * trade naming any two parties on any terms. Only six fields are PDA seeds —
 * settlement authority, both users, both mints, and the nonce — so verifying
 * the account is program-owned, exact-size and at its canonical PDA still
 * leaves the amounts, the time bounds and both settlement destinations
 * unbound. A forged create at the canonical PDA that redirects proceeds to an
 * attacker passes `verifySwapDvp` and fails only here.
 *
 * That matters because escrow addresses derive from the PDA and mint, never
 * from the terms: a raw funding transfer lands happily against terms nobody
 * agreed to. Call this before funding a leg and before settling one.
 */

import { type Address, unwrapOption } from "@solana/kit";
import type { SwapDvp } from "./generated/accounts/swapDvp";

/**
 * The deal as agreed off-chain, to be checked against what is actually
 * stored on-chain.
 *
 * Settlement destinations are optional: `CreateDvp` records an omitted
 * destination as the party's own address, so leaving them out asserts the
 * default (proceeds go to the counterparty themselves) rather than skipping
 * the check.
 */
export type ExpectedSwapDvpTerms = {
  settlementAuthority: Address;
  userA: Address;
  userB: Address;
  mintA: Address;
  mintB: Address;
  nonce: bigint;
  amountA: bigint;
  amountB: bigint;
  expiryTimestamp: bigint;
  /** `null` asserts the trade carries no lower bound on settlement. */
  earliestSettlementTimestamp: bigint | null;
  userASettlementDestination?: Address;
  userBSettlementDestination?: Address;
};

export class SwapDvpTermsMismatchError extends Error {
  /** Field names that differ, in the order checked. */
  readonly fields: readonly string[];

  constructor(mismatches: readonly string[], detail: string) {
    super(
      `On-chain SwapDvp terms do not match the agreed deal ` +
        `(${mismatches.length} field(s)):\n${detail}\n` +
        `Refusing to treat this trade as agreed. Do not fund it.`
    );
    // biome-ignore lint/security/noSecrets: error class name, not a credential.
    this.name = "SwapDvpTermsMismatchError";
    this.fields = mismatches;
  }
}

function describe(value: bigint | string | null): string {
  return value === null ? "none" : String(value);
}

/**
 * Throws `SwapDvpTermsMismatchError` unless every agreed term matches what the
 * program stored. Reports all mismatches at once rather than the first, so a
 * caller sees the whole shape of a forgery instead of peeling it one field at
 * a time.
 */
export function assertSwapDvpTerms(actual: SwapDvp, expected: ExpectedSwapDvpTerms): void {
  const expectedDestinationA = expected.userASettlementDestination ?? expected.userA;
  const expectedDestinationB = expected.userBSettlementDestination ?? expected.userB;

  const comparisons: ReadonlyArray<[string, bigint | string | null, bigint | string | null]> = [
    ["settlementAuthority", actual.settlementAuthority, expected.settlementAuthority],
    ["userA", actual.userA, expected.userA],
    ["userB", actual.userB, expected.userB],
    ["mintA", actual.mintA, expected.mintA],
    ["mintB", actual.mintB, expected.mintB],
    ["nonce", actual.nonce, expected.nonce],
    ["amountA", actual.amountA, expected.amountA],
    ["amountB", actual.amountB, expected.amountB],
    ["expiryTimestamp", actual.expiryTimestamp, expected.expiryTimestamp],
    [
      "earliestSettlementTimestamp",
      unwrapOption(actual.earliestSettlementTimestamp),
      expected.earliestSettlementTimestamp,
    ],
    ["userASettlementDestination", actual.userASettlementDestination, expectedDestinationA],
    ["userBSettlementDestination", actual.userBSettlementDestination, expectedDestinationB],
  ];

  const mismatches: string[] = [];
  const detail: string[] = [];
  for (const [field, onChain, agreed] of comparisons) {
    if (onChain !== agreed) {
      mismatches.push(field);
      detail.push(`  ${field}: on-chain ${describe(onChain)}, agreed ${describe(agreed)}`);
    }
  }

  if (mismatches.length > 0) {
    throw new SwapDvpTermsMismatchError(mismatches, detail.join("\n"));
  }
}
