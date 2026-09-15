import { address, none, some } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { SwapDvp } from "./generated/accounts/swapDvp";
import { assertSwapDvpTerms, SwapDvpTermsMismatchError } from "./terms";

const SETTLEMENT_AUTHORITY = address("So11111111111111111111111111111111111111112");
const USER_A = address("11111111111111111111111111111111");
const USER_B = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MINT_A = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_B = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATTACKER = address("SysvarRent111111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const agreedTerms = {
  settlementAuthority: SETTLEMENT_AUTHORITY,
  userA: USER_A,
  userB: USER_B,
  mintA: MINT_A,
  mintB: MINT_B,
  nonce: 42n,
  amountA: 1_000_000n,
  amountB: 250_000_000n,
  expiryTimestamp: 1_800_000_000n,
  earliestSettlementTimestamp: null,
};

/** An on-chain SwapDvp that matches `agreedTerms` exactly. */
function honestAccount(overrides: Partial<SwapDvp> = {}): SwapDvp {
  return {
    bump: 254,
    userA: USER_A,
    userB: USER_B,
    mintA: MINT_A,
    mintB: MINT_B,
    settlementAuthority: SETTLEMENT_AUTHORITY,
    tokenProgramA: TOKEN_PROGRAM,
    tokenProgramB: TOKEN_PROGRAM,
    amountA: 1_000_000n,
    amountB: 250_000_000n,
    expiryTimestamp: 1_800_000_000n,
    nonce: 42n,
    refString: Array.from({ length: 64 }, () => 0),
    userASettlementDestination: USER_A,
    userBSettlementDestination: USER_B,
    mintAAuthority: SETTLEMENT_AUTHORITY,
    mintBAuthority: SETTLEMENT_AUTHORITY,
    earliestSettlementTimestamp: none(),
    ...overrides,
  };
}

describe("assertSwapDvpTerms", () => {
  it("accepts a trade whose stored terms match what was agreed", () => {
    expect(() => assertSwapDvpTerms(honestAccount(), agreedTerms)).not.toThrow();
  });

  it("rejects a redirected settlement destination, which the PDA does not bind", () => {
    const forged = honestAccount({ userBSettlementDestination: ATTACKER });

    expect(() => assertSwapDvpTerms(forged, agreedTerms)).toThrow(SwapDvpTermsMismatchError);
  });

  it("rejects an amount that does not match the agreed leg size", () => {
    const short = honestAccount({ amountB: 1n });

    expect(() => assertSwapDvpTerms(short, agreedTerms)).toThrow(/amountB/);
  });

  it("reports every mismatched field, not just the first", () => {
    const forged = honestAccount({ amountA: 1n, userASettlementDestination: ATTACKER });

    expect(() => assertSwapDvpTerms(forged, agreedTerms)).toThrow(
      /amountA[\s\S]*userASettlementDestination/
    );
  });

  it("rejects an earliest-settlement bound the agreed deal did not carry", () => {
    const gated = honestAccount({ earliestSettlementTimestamp: some(1_799_000_000n) });

    expect(() => assertSwapDvpTerms(gated, agreedTerms)).toThrow(/earliestSettlementTimestamp/);
  });

  it("accepts a matching earliest-settlement bound", () => {
    const gated = honestAccount({ earliestSettlementTimestamp: some(1_799_000_000n) });

    expect(() =>
      assertSwapDvpTerms(gated, { ...agreedTerms, earliestSettlementTimestamp: 1_799_000_000n })
    ).not.toThrow();
  });

  it("defaults an omitted settlement destination to the party's own address, as the program does", () => {
    expect(() =>
      assertSwapDvpTerms(honestAccount(), {
        ...agreedTerms,
        userASettlementDestination: undefined,
        userBSettlementDestination: undefined,
      })
    ).not.toThrow();
  });

  it("rejects a swapped counterparty", () => {
    const forged = honestAccount({ userB: ATTACKER });

    expect(() => assertSwapDvpTerms(forged, agreedTerms)).toThrow(/userB/);
  });
});
