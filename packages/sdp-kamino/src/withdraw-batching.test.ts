import { createHash } from "node:crypto";
import type { AddressesByLookupTableAddress, Instruction } from "@solana/kit";
import { AccountRole, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  decodeKvaultWithdrawShares,
  KVAULT_BURN_ALL_SHARES_SENTINEL,
  KVAULT_SHARE_REDEEMING_DISCRIMINATORS,
  measureTransactionBytes,
  planWithdrawBatches,
  type RoleTaggedInstruction,
  resolveBurnAllSentinel,
  SOLANA_TRANSACTION_SIZE_LIMIT_BYTES,
} from "./withdraw-batching";

/** Mainnet kvault id — any well-formed address works; decode matches by string. */
const KVAULT_PROGRAM = address("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
const OWNER = address("11111111111111111111111111111112");
const LOOKUP_TABLE = address("7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx");

/** Distinct throwaway addresses, deterministic per index. */
function syntheticAddress(index: number) {
  // 32 bytes of (index+1) encodes to a valid base58 address; precomputed via
  // kit's own address codec would be overkill for a test — reuse real mints.
  const pool = [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "So11111111111111111111111111111111111111112",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "ComputeBudget111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  ];
  return address(pool[index % pool.length]);
}

function withdrawData(sharesBaseUnits: bigint, discriminator = 0): Uint8Array {
  const data = new Uint8Array(16);
  data.set(KVAULT_SHARE_REDEEMING_DISCRIMINATORS[discriminator], 0);
  let value = sharesBaseUnits;
  for (let index = 0; index < 8; index += 1) {
    data[8 + index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return data;
}

function instruction(input: {
  program?: ReturnType<typeof address>;
  data?: Uint8Array;
  accountCount?: number;
}): Instruction {
  return {
    programAddress: input.program ?? KVAULT_PROGRAM,
    accounts: Array.from({ length: input.accountCount ?? 0 }, (_unused, index) => ({
      address: syntheticAddress(index),
      role: AccountRole.READONLY,
    })),
    data: input.data ?? new Uint8Array(0),
  } as Instruction;
}

function withdrawIx(shares: bigint, accountCount = 2): RoleTaggedInstruction {
  return {
    instruction: instruction({ data: withdrawData(shares), accountCount }),
    role: "withdraw",
    sharesBaseUnits: shares,
  };
}

function taggedIx(
  role: RoleTaggedInstruction["role"],
  accountCount = 2,
  dataBytes = 8
): RoleTaggedInstruction {
  return {
    instruction: instruction({ data: new Uint8Array(dataBytes), accountCount }),
    role,
    sharesBaseUnits: null,
  };
}

const NO_TABLES: AddressesByLookupTableAddress = {};

describe("decodeKvaultWithdrawShares", () => {
  it("pins the discriminators to their anchor derivation", () => {
    const derive = (name: string) =>
      Uint8Array.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
    expect(KVAULT_SHARE_REDEEMING_DISCRIMINATORS[0]).toEqual(derive("withdraw"));
    expect(KVAULT_SHARE_REDEEMING_DISCRIMINATORS[1]).toEqual(derive("withdraw_from_available"));
  });

  it("decodes the u64 shares argument little-endian from both redeeming instructions", () => {
    const shares = 0x0102030405060708n;
    for (const discriminator of [0, 1]) {
      const ix = instruction({ data: withdrawData(shares, discriminator) });
      expect(decodeKvaultWithdrawShares(ix, String(KVAULT_PROGRAM))).toBe(shares);
    }
  });

  it("answers null for other programs, short data, and unknown discriminators", () => {
    expect(
      decodeKvaultWithdrawShares(
        instruction({ program: syntheticAddress(0), data: withdrawData(5n) }),
        String(KVAULT_PROGRAM)
      )
    ).toBeNull();
    expect(
      decodeKvaultWithdrawShares(
        instruction({ data: withdrawData(5n).slice(0, 12) }),
        String(KVAULT_PROGRAM)
      )
    ).toBeNull();
    const unknown = withdrawData(5n);
    unknown[0] ^= 0xff;
    expect(
      decodeKvaultWithdrawShares(instruction({ data: unknown }), String(KVAULT_PROGRAM))
    ).toBeNull();
  });
});

describe("resolveBurnAllSentinel", () => {
  const SENTINEL = KVAULT_BURN_ALL_SHARES_SENTINEL;

  it("passes literal-amount bundles through untouched", () => {
    const legs = [withdrawIx(3n), withdrawIx(4n)];
    const resolved = resolveBurnAllSentinel({
      instructions: legs,
      requestedBaseUnits: 7n,
      walletShareBaseUnits: 100n,
    });
    expect(resolved.map((leg) => leg.sharesBaseUnits)).toEqual([3n, 4n]);
  });

  it("resolves a full exit's sentinel to the requested quantity", () => {
    const resolved = resolveBurnAllSentinel({
      instructions: [taggedIx("prepare"), withdrawIx(SENTINEL), taggedIx("post")],
      requestedBaseUnits: 150_000_000n,
      walletShareBaseUnits: 150_000_000n,
    });
    expect(resolved[1].sharesBaseUnits).toBe(150_000_000n);
  });

  it("refuses a sentinel for a request that is not the wallet's exact balance", () => {
    // An over-balance request ALSO encodes the sentinel, and would burn fewer
    // shares than requested — no honest number exists for that row.
    expect(() =>
      resolveBurnAllSentinel({
        instructions: [withdrawIx(SENTINEL)],
        requestedBaseUnits: 200_000_000n,
        walletShareBaseUnits: 150_000_000n,
      })
    ).toThrow(/current share balance/);
  });

  it("refuses mixed sentinel and literal amounts, and multiple sentinels", () => {
    expect(() =>
      resolveBurnAllSentinel({
        instructions: [withdrawIx(SENTINEL), withdrawIx(5n)],
        requestedBaseUnits: 10n,
        walletShareBaseUnits: 10n,
      })
    ).toThrow(/mixes burn-all and literal/);
    expect(() =>
      resolveBurnAllSentinel({
        instructions: [withdrawIx(SENTINEL), withdrawIx(SENTINEL)],
        requestedBaseUnits: 10n,
        walletShareBaseUnits: 10n,
      })
    ).toThrow(/more than one burn-all/);
  });
});

describe("measureTransactionBytes", () => {
  it("stays within the packet limit for a small message and grows with payload", () => {
    const small = measureTransactionBytes({
      instructions: [instruction({ data: new Uint8Array(8), accountCount: 2 })],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    const large = measureTransactionBytes({
      instructions: [instruction({ data: new Uint8Array(200), accountCount: 6 })],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    expect(small).toBeLessThan(large);
    expect(small).toBeLessThan(SOLANA_TRANSACTION_SIZE_LIMIT_BYTES);
  });

  it("compresses accounts that appear in a lookup table", () => {
    const accounts = 8;
    const uncompressed = measureTransactionBytes({
      instructions: [instruction({ accountCount: accounts })],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    const compressed = measureTransactionBytes({
      instructions: [instruction({ accountCount: accounts })],
      feePayer: OWNER,
      lookupTables: {
        [LOOKUP_TABLE]: Array.from({ length: accounts }, (_unused, index) =>
          syntheticAddress(index)
        ),
      },
    });
    expect(compressed).toBeLessThan(uncompressed);
  });
});

describe("planWithdrawBatches", () => {
  it("keeps a fitting exit in one batch and reports its exact shares", () => {
    const batches = planWithdrawBatches({
      instructions: [taggedIx("unstake"), withdrawIx(3n), withdrawIx(4n), taggedIx("post")],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
      maxTransactionBytes: SOLANA_TRANSACTION_SIZE_LIMIT_BYTES,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].instructions).toHaveLength(4);
    expect(batches[0].sharesBaseUnits).toBe(7n);
  });

  it("splits at withdraw boundaries, preserving order and per-batch shares", () => {
    const legs = [withdrawIx(1n, 4), withdrawIx(2n, 4), withdrawIx(3n, 4)];
    const single = measureTransactionBytes({
      instructions: [legs[0].instruction],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    const pair = measureTransactionBytes({
      instructions: [legs[0].instruction, legs[1].instruction],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    // A budget that admits two withdraws but not three forces a 2+1 split.
    const triple = measureTransactionBytes({
      instructions: legs.map((leg) => leg.instruction),
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    expect(single).toBeLessThan(pair);
    expect(pair).toBeLessThan(triple);

    const batches = planWithdrawBatches({
      instructions: legs,
      feePayer: OWNER,
      lookupTables: NO_TABLES,
      maxTransactionBytes: pair,
    });
    expect(batches.map((batch) => batch.sharesBaseUnits)).toEqual([3n, 3n]);
    expect(batches.map((batch) => batch.instructions.length)).toEqual([2, 1]);
  });

  it("keeps the unstake prefix in the first redeeming batch", () => {
    const unstake = taggedIx("unstake", 3);
    const legs = [unstake, withdrawIx(5n, 4), withdrawIx(6n, 4)];
    const firstTwo = measureTransactionBytes({
      instructions: [unstake.instruction, legs[1].instruction],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    const batches = planWithdrawBatches({
      instructions: legs,
      feePayer: OWNER,
      lookupTables: NO_TABLES,
      maxTransactionBytes: firstTwo,
    });
    expect(batches).toHaveLength(2);
    expect(batches[0].instructions[0]).toBe(unstake.instruction);
    expect(batches[0].sharesBaseUnits).toBe(5n);
    expect(batches[1].sharesBaseUnits).toBe(6n);
  });

  it("refuses a plan whose unstake cannot ride with any withdraw", () => {
    const unstake = taggedIx("unstake", 8);
    const leg = withdrawIx(5n, 8);
    const unstakeAlone = measureTransactionBytes({
      instructions: [unstake.instruction],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    expect(() =>
      planWithdrawBatches({
        instructions: [unstake, leg],
        feePayer: OWNER,
        lookupTables: NO_TABLES,
        maxTransactionBytes: unstakeAlone,
      })
    ).toThrow(/redeem no shares/);
  });

  it("refuses a trailing cleanup-only transaction", () => {
    const leg = withdrawIx(5n, 4);
    const post = taggedIx("post", 4);
    const legAlone = measureTransactionBytes({
      instructions: [leg.instruction],
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    expect(() =>
      planWithdrawBatches({
        instructions: [leg, post],
        feePayer: OWNER,
        lookupTables: NO_TABLES,
        maxTransactionBytes: legAlone,
      })
    ).toThrow(/redeem no shares/);
  });

  it("refuses a single instruction larger than the budget, and an empty bundle", () => {
    const oversized = withdrawIx(1n, 20);
    expect(() =>
      planWithdrawBatches({
        instructions: [oversized],
        feePayer: OWNER,
        lookupTables: NO_TABLES,
        maxTransactionBytes: 64,
      })
    ).toThrow(/single instruction/);
    expect(() =>
      planWithdrawBatches({
        instructions: [],
        feePayer: OWNER,
        lookupTables: NO_TABLES,
        maxTransactionBytes: SOLANA_TRANSACTION_SIZE_LIMIT_BYTES,
      })
    ).toThrow(/no instructions/);
  });

  it("fits more withdraws per batch when the lookup table covers their accounts", () => {
    const legs = Array.from({ length: 4 }, (_unused, index) => withdrawIx(BigInt(index + 1), 6));
    const lookupTables: AddressesByLookupTableAddress = {
      [LOOKUP_TABLE]: Array.from({ length: 8 }, (_unused, index) => syntheticAddress(index)),
    };
    // One budget for both plans: two UNCOMPRESSED withdraws' worth. All four
    // legs fit it compressed; uncompressed they must split.
    const budget = measureTransactionBytes({
      instructions: legs.slice(0, 2).map((leg) => leg.instruction),
      feePayer: OWNER,
      lookupTables: NO_TABLES,
    });
    expect(
      measureTransactionBytes({
        instructions: legs.map((leg) => leg.instruction),
        feePayer: OWNER,
        lookupTables,
      })
    ).toBeLessThanOrEqual(budget);

    const compressed = planWithdrawBatches({
      instructions: legs,
      feePayer: OWNER,
      lookupTables,
      maxTransactionBytes: budget,
    });
    expect(compressed).toHaveLength(1);

    const uncompressed = planWithdrawBatches({
      instructions: legs,
      feePayer: OWNER,
      lookupTables: NO_TABLES,
      maxTransactionBytes: budget,
    });
    expect(uncompressed.length).toBeGreaterThan(1);
  });
});
