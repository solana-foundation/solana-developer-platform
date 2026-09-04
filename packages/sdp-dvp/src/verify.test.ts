import { type Address, address, type EncodedAccount, none, some } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getSwapDvpEncoder, type SwapDvp } from "./generated/accounts/swapDvp";
import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "./generated/programs/dvpSwapProgram";
import {
  decodeSwapDvpChecked,
  findSwapDvpPda,
  SWAP_DVP_ACCOUNT_SIZE,
  SwapDvpVerificationError,
} from "./verify";

const ANY = address("So11111111111111111111111111111111111111112");

function swapDvp(overrides: Partial<SwapDvp> = {}): SwapDvp {
  return {
    bump: 254,
    userA: ANY,
    userB: ANY,
    mintA: ANY,
    mintB: ANY,
    settlementAuthority: ANY,
    tokenProgramA: ANY,
    tokenProgramB: ANY,
    amountA: 1n,
    amountB: 2n,
    expiryTimestamp: 1_800_000_000n,
    nonce: 7n,
    refString: Array.from({ length: 64 }, () => 0),
    userASettlementDestination: ANY,
    userBSettlementDestination: ANY,
    mintAAuthority: ANY,
    mintBAuthority: ANY,
    earliestSettlementTimestamp: none(),
    ...overrides,
  };
}

// `decodeSwapDvpChecked` runs kit's `assertAccountExists` first, which reads
// the `exists` discriminant off a MaybeEncodedAccount — so the fixture has to
// carry it or every case fails as "account not found" instead of on the check
// under test.
function encodedAccount(data: Uint8Array, programAddress: Address): EncodedAccount {
  return {
    exists: true,
    address: ANY,
    data,
    programAddress,
    executable: false,
    lamports: 0n as never,
    space: BigInt(data.length) as never,
  } as unknown as EncodedAccount;
}

describe("SwapDvp codec layout", () => {
  // Guards the constant `decodeSwapDvpChecked` enforces. If regeneration
  // changes the layout, this fails here rather than rejecting every real
  // account at runtime.
  it("encodes to exactly SWAP_DVP_ACCOUNT_SIZE bytes", () => {
    expect(getSwapDvpEncoder().encode(swapDvp())).toHaveLength(SWAP_DVP_ACCOUNT_SIZE);
  });

  // The reason `setFixedAccountOptionFields` exists: a variable-width option
  // would make the None layout shorter, and the program rejects that size.
  it("encodes the same size whether earliest-settlement is set or not", () => {
    const withNone = getSwapDvpEncoder().encode(swapDvp());
    const withSome = getSwapDvpEncoder().encode(
      swapDvp({ earliestSettlementTimestamp: some(1_799_000_000n) })
    );

    expect(withSome).toHaveLength(withNone.length);
  });
});

describe("decodeSwapDvpChecked", () => {
  it("rejects an account owned by something other than the DvP program", () => {
    const data = getSwapDvpEncoder().encode(swapDvp());

    expect(() => decodeSwapDvpChecked(encodedAccount(data as Uint8Array, ANY))).toThrow(
      SwapDvpVerificationError
    );
  });

  it("rejects a program-owned account of the wrong size", () => {
    const truncated = new Uint8Array(SWAP_DVP_ACCOUNT_SIZE - 1);

    expect(() =>
      decodeSwapDvpChecked(encodedAccount(truncated, DVP_SWAP_PROGRAM_PROGRAM_ADDRESS))
    ).toThrow(/exactly 458 bytes/);
  });

  it("accepts a program-owned account of the right size", () => {
    const data = getSwapDvpEncoder().encode(swapDvp({ amountA: 123n }));

    const decoded = decodeSwapDvpChecked(
      encodedAccount(data as Uint8Array, DVP_SWAP_PROGRAM_PROGRAM_ADDRESS)
    );

    expect(decoded.data.amountA).toBe(123n);
  });
});

describe("findSwapDvpPda", () => {
  // The seeds are encoded before the async derivation starts, so the guard
  // throws synchronously rather than rejecting the returned promise.
  it("refuses a number nonce, which would round above 2^53 and derive elsewhere", () => {
    expect(() =>
      findSwapDvpPda({
        settlementAuthority: ANY,
        userA: ANY,
        userB: ANY,
        mintA: ANY,
        mintB: ANY,
        nonce: 42 as unknown as bigint,
      })
    ).toThrow(TypeError);
  });

  it("derives a canonical PDA for a bigint nonce", async () => {
    const [pda, bump] = await findSwapDvpPda({
      settlementAuthority: ANY,
      userA: ANY,
      userB: ANY,
      mintA: ANY,
      mintB: ANY,
      nonce: 42n,
    });

    expect(pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(bump).toBeLessThanOrEqual(255);
  });
});
