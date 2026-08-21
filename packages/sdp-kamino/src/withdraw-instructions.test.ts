import { createHash } from "node:crypto";
import type { Instruction } from "@solana/kit";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  decodeKvaultWithdrawShares,
  KVAULT_BURN_ALL_SHARES_SENTINEL,
  KVAULT_SHARE_REDEEMING_DISCRIMINATORS,
  type RoleTaggedInstruction,
  resolveBurnAllSentinel,
} from "./withdraw-instructions";

const KVAULT_PROGRAM = address("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");

function withdrawData(shares: bigint, discriminator = 0): Uint8Array {
  const data = new Uint8Array(16);
  data.set(KVAULT_SHARE_REDEEMING_DISCRIMINATORS[discriminator], 0);
  let value = shares;
  for (let index = 0; index < 8; index += 1) {
    data[8 + index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return data;
}

function instruction(shares: bigint): Instruction {
  return {
    programAddress: KVAULT_PROGRAM,
    data: withdrawData(shares),
  } as Instruction;
}

function withdraw(shares: bigint): RoleTaggedInstruction {
  return { instruction: instruction(shares), role: "withdraw", sharesBaseUnits: shares };
}

describe("decodeKvaultWithdrawShares", () => {
  it("pins both discriminators to their Anchor derivation", () => {
    const derive = (name: string) =>
      Uint8Array.from(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8));
    expect(KVAULT_SHARE_REDEEMING_DISCRIMINATORS[0]).toEqual(derive("withdraw"));
    expect(KVAULT_SHARE_REDEEMING_DISCRIMINATORS[1]).toEqual(derive("withdraw_from_available"));
  });

  it("decodes the little-endian u64 from both redeeming instructions", () => {
    const shares = 0x0102030405060708n;
    for (const discriminator of [0, 1]) {
      const ix = { ...instruction(shares), data: withdrawData(shares, discriminator) };
      expect(decodeKvaultWithdrawShares(ix, String(KVAULT_PROGRAM))).toBe(shares);
    }
  });

  it("ignores other programs and unknown instruction data", () => {
    const otherProgram = {
      ...instruction(5n),
      programAddress: address("11111111111111111111111111111112"),
    };
    expect(decodeKvaultWithdrawShares(otherProgram, String(KVAULT_PROGRAM))).toBeNull();
    expect(
      decodeKvaultWithdrawShares(
        { ...instruction(5n), data: new Uint8Array(8) },
        String(KVAULT_PROGRAM)
      )
    ).toBeNull();
  });
});

describe("resolveBurnAllSentinel", () => {
  const sentinel = KVAULT_BURN_ALL_SHARES_SENTINEL;

  it("leaves literal instructions unchanged", () => {
    const resolved = resolveBurnAllSentinel({
      instructions: [withdraw(3n), withdraw(4n)],
      requestedBaseUnits: 7n,
    });
    expect(resolved.map((entry) => entry.sharesBaseUnits)).toEqual([3n, 4n]);
  });

  it("rewrites the final burn-all sentinel to the exact remaining shares", () => {
    const resolved = resolveBurnAllSentinel({
      instructions: [withdraw(40n), withdraw(sentinel)],
      requestedBaseUnits: 100n,
    });
    expect(resolved.map((entry) => entry.sharesBaseUnits)).toEqual([40n, 60n]);
    expect(decodeKvaultWithdrawShares(resolved[1].instruction, String(KVAULT_PROGRAM))).toBe(60n);
  });

  it("refuses ambiguous sentinel placement", () => {
    expect(() =>
      resolveBurnAllSentinel({
        instructions: [withdraw(sentinel), withdraw(5n)],
        requestedBaseUnits: 10n,
      })
    ).toThrow(/burn-all before a later/);
    expect(() =>
      resolveBurnAllSentinel({
        instructions: [withdraw(sentinel), withdraw(sentinel)],
        requestedBaseUnits: 10n,
      })
    ).toThrow(/more than one burn-all/);
  });
});
