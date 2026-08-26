import { createHash } from "node:crypto";
import type { Instruction } from "@solana/kit";
import { address, createNoopSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  buildMaximumWithdrawalBalanceGuard,
  buildShareAccountCloseInstruction,
  buildShareAccountConsolidation,
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

  it("requires an atomic balance guard for an exact maximum-u64 remainder", () => {
    expect(() =>
      resolveBurnAllSentinel({
        instructions: [withdraw(sentinel)],
        requestedBaseUnits: sentinel,
      })
    ).toThrow(/requires an atomic share-balance guard/);

    const guarded = resolveBurnAllSentinel({
      instructions: [withdraw(sentinel)],
      requestedBaseUnits: sentinel,
      maximumBalanceGuarded: true,
    });
    expect(guarded[0].sharesBaseUnits).toBe(sentinel);
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

describe("buildMaximumWithdrawalBalanceGuard", () => {
  it("builds a no-op self-transfer that atomically requires the maximum balance", async () => {
    const owner = createNoopSigner(address("11111111111111111111111111111112"));
    const guard = await buildMaximumWithdrawalBalanceGuard({
      requestedBaseUnits: KVAULT_BURN_ALL_SHARES_SENTINEL,
      shareMint: address("So11111111111111111111111111111111111111112"),
      shareDecimals: 6,
      owner,
    });
    expect(guard?.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(guard?.accounts?.[0].address).toBe(guard?.accounts?.[2].address);
    expect(guard?.accounts?.[3].address).toBe(owner.address);
    expect(guard?.data?.[0]).toBe(12);
    expect(guard?.data?.slice(1, 9)).toEqual(Uint8Array.from({ length: 8 }, () => 255));
    expect(guard?.data?.[9]).toBe(6);
  });

  it("adds no instruction for ordinary exact withdrawals", async () => {
    await expect(
      buildMaximumWithdrawalBalanceGuard({
        requestedBaseUnits: 1n,
        shareMint: address("So11111111111111111111111111111111111111112"),
        shareDecimals: 6,
        owner: createNoopSigner(address("11111111111111111111111111111112")),
      })
    ).resolves.toBeNull();
  });
});

describe("buildShareAccountConsolidation", () => {
  it("moves only the missing shares from auxiliary accounts into the ATA", async () => {
    const owner = createNoopSigner(address("11111111111111111111111111111112"));
    const mint = address("So11111111111111111111111111111111111111112");
    const [shareAta] = await findAssociatedTokenPda({
      owner: owner.address,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const auxiliary = address("11111111111111111111111111111113");
    const result = await buildShareAccountConsolidation({
      requestedBaseUnits: 9n,
      shareMint: mint,
      shareDecimals: 6,
      owner,
      accounts: [
        { address: shareAta, amount: 4n },
        { address: auxiliary, amount: 10n },
      ],
    });

    expect(result.totalBaseUnits).toBe(14n);
    expect(result.postConsolidationAtaBaseUnits).toBe(9n);
    expect(result.instructions).toHaveLength(2);
    expect(result.instructions[1].accounts?.[0].address).toBe(auxiliary);
    expect(result.instructions[1].accounts?.[2].address).toBe(shareAta);
    expect(result.instructions[1].data?.slice(1, 9)).toEqual(
      Uint8Array.from([5, 0, 0, 0, 0, 0, 0, 0])
    );
  });

  it("consolidates a split maximum-u64 position before its atomic guard", async () => {
    const owner = createNoopSigner(address("11111111111111111111111111111112"));
    const mint = address("So11111111111111111111111111111111111111112");
    const result = await buildShareAccountConsolidation({
      requestedBaseUnits: KVAULT_BURN_ALL_SHARES_SENTINEL,
      shareMint: mint,
      shareDecimals: 6,
      owner,
      accounts: [
        { address: address("11111111111111111111111111111113"), amount: 10n },
        {
          address: address("11111111111111111111111111111114"),
          amount: KVAULT_BURN_ALL_SHARES_SENTINEL - 10n,
        },
      ],
    });

    expect(result.totalBaseUnits).toBe(KVAULT_BURN_ALL_SHARES_SENTINEL);
    expect(result.postConsolidationAtaBaseUnits).toBe(KVAULT_BURN_ALL_SHARES_SENTINEL);
    expect(result.instructions).toHaveLength(3);
  });
});

describe("buildShareAccountCloseInstruction", () => {
  const OWNER = createNoopSigner(address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"));
  const SHARE_ATA = address("7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx");
  const SPONSOR = address("4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q");

  function close(overrides: Record<string, unknown> = {}) {
    return buildShareAccountCloseInstruction({
      shareAta: SHARE_ATA,
      owner: OWNER,
      ataBaseUnitsBeforeExit: 500n,
      redeemedBaseUnits: 500n,
      ownerTotalBaseUnits: 500n,
      ...overrides,
    } as Parameters<typeof buildShareAccountCloseInstruction>[0]);
  }

  it("refunds the recorded funder when the exit empties the account", () => {
    const instruction = close({ refundTo: SPONSOR });

    expect(instruction).not.toBeNull();
    const accounts = (instruction?.accounts ?? []).map((account) => String(account.address));
    // SPL CloseAccount orders them account, destination, owner.
    expect(accounts).toEqual([SHARE_ATA, SPONSOR, OWNER.address]);
    expect(String(instruction?.programAddress)).toBe(String(TOKEN_PROGRAM_ADDRESS));
  });

  it("refunds the owner when no funder was recorded", () => {
    expect((close()?.accounts ?? []).map((account) => String(account.address))[1]).toBe(
      OWNER.address
    );
  });

  /**
   * `CloseAccount` fails on a non-zero balance and rides the same transaction as
   * the redemptions, so closing on a partial exit would not strand rent, it would
   * fail the customer's withdrawal.
   */
  it.each([
    [
      "a partial exit leaves shares in the ATA",
      { ataBaseUnitsBeforeExit: 500n, redeemedBaseUnits: 200n, ownerTotalBaseUnits: 500n },
    ],
    [
      "redeeming more than the ATA holds",
      { ataBaseUnitsBeforeExit: 200n, redeemedBaseUnits: 500n, ownerTotalBaseUnits: 500n },
    ],
  ])("returns null when %s", (_case, overrides) => {
    expect(close({ ...overrides, refundTo: SPONSOR })).toBeNull();
  });

  /**
   * The case Greptile flagged, and the reason the condition is not just
   * "is the ATA empty". Consolidation can leave the ATA holding exactly the
   * request while auxiliary accounts still hold shares. Closing there would be
   * closing an account the NEXT withdrawal has to recreate and pay rent for, at
   * which point the funder recorded against the position describes a previous
   * instance of the account and its refund goes to the wrong party.
   */
  it("returns null when auxiliary accounts still hold shares", () => {
    expect(
      close({
        ataBaseUnitsBeforeExit: 500n,
        redeemedBaseUnits: 500n,
        ownerTotalBaseUnits: 900n,
        refundTo: SPONSOR,
      })
    ).toBeNull();
  });

  it("closes a zero-balance account that redeems nothing", () => {
    expect(
      close({ ataBaseUnitsBeforeExit: 0n, redeemedBaseUnits: 0n, ownerTotalBaseUnits: 0n })
    ).not.toBeNull();
  });
});
