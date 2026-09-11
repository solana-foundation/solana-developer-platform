import { SPL_TOKEN_PROGRAM_ID } from "@heliuslabs/zolana/interface";
import type { Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildRingTransferTransaction = vi.fn();
const buildRingWithdrawalTransaction = vi.fn();
const buildRingEntryTransaction = vi.fn();
const buildRingExitTransaction = vi.fn();

vi.mock("@heliuslabs/zolana/ring", () => ({
  buildRingTransferTransaction: (...args: unknown[]) => buildRingTransferTransaction(...args),
  buildRingWithdrawalTransaction: (...args: unknown[]) => buildRingWithdrawalTransaction(...args),
  buildRingEntryTransaction: (...args: unknown[]) => buildRingEntryTransaction(...args),
  buildRingExitTransaction: (...args: unknown[]) => buildRingExitTransaction(...args),
}));

const { buildRingEntryTx, buildRingExitTx, buildRingTransferTx, buildRingWithdrawalTx } =
  await import("./ring-spend.js");

const OWNER = "GsbwXfJraMomNxBcjK1DiP5Mth8ZmQpDUFTmKfhtiHgo" as Address;
const RECIPIENT = "6Ecs4vFmtiZ7WeQMWZibhFPQF3q3Pmqrb7CQGRJJKQTM";
const RING_PROGRAM = "Stake11111111111111111111111111111111111111";
const LOOKUP_TABLE = "LookupTab1e11111111111111111111111111111111";
const SDP_SOL = "So11111111111111111111111111111111111111112";
/** How the protocol spells native SOL: the system program, not the wrapped mint. */
const PROTOCOL_SOL = "11111111111111111111111111111111";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
// Mainnet USDC: a real mint, deliberately outside this build's spend set.
const UNKNOWN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function deps() {
  return {
    client: { fake: "client" } as never,
    wallet: { fake: "wallet" } as never,
    keys: { fake: "keys" } as never,
    owner: OWNER,
  };
}

function withdrawalInput(overrides: Record<string, string> = {}) {
  return {
    ringProgramId: RING_PROGRAM,
    lookupTable: LOOKUP_TABLE,
    mint: SDP_SOL,
    amountRaw: "1000000",
    recipient: RECIPIENT,
    ...overrides,
  };
}

describe("ring-spend flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildRingWithdrawalTransaction.mockResolvedValue({ fake: "tx" });
    buildRingTransferTransaction.mockResolvedValue({ fake: "tx" });
    buildRingEntryTransaction.mockResolvedValue({ fake: "tx" });
    buildRingExitTransaction.mockResolvedValue({ fake: "tx" });
  });

  it("hands the one-call withdrawal builder the pinned ring, its table, and no CU override", async () => {
    await buildRingWithdrawalTx(deps(), withdrawalInput());

    expect(buildRingWithdrawalTransaction).toHaveBeenCalledTimes(1);
    const [input] = buildRingWithdrawalTransaction.mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({
      ringProgramId: RING_PROGRAM,
      lookupTable: LOOKUP_TABLE,
      keys: { fake: "keys" },
      feePayer: OWNER,
      recipient: RECIPIENT,
      amount: 1_000_000n,
    });
    // SOL as the protocol spells it, named rather than left to the builder's
    // default, and no SPL settlement to reach. No `computeUnitLimit` either:
    // the 1.4M default is byte-for-byte what the wire policy expects.
    expect(input.asset).toBe(PROTOCOL_SOL);
    expect(input).not.toHaveProperty("splTokenProgram");
    expect(input).not.toHaveProperty("computeUnitLimit");
  });

  it("names the mint and the legacy Token program for a USDC withdrawal", async () => {
    await buildRingWithdrawalTx(deps(), withdrawalInput({ mint: USDC }));

    const [input] = buildRingWithdrawalTransaction.mock.calls[0] as [Record<string, unknown>];
    // Devnet USDC is not Token-2022, and the builder settles into the
    // recipient's associated token account for this program.
    expect(input.asset).toBe(USDC);
    expect(input.splTokenProgram).toBe(SPL_TOKEN_PROGRAM_ID);
  });

  it("carries the asset into a ring transfer, which settles nothing publicly", async () => {
    await buildRingTransferTx(deps(), {
      ...withdrawalInput({ mint: USDC }),
      recipient: { fake: "shielded-address" } as never,
    });

    const [input] = buildRingTransferTransaction.mock.calls[0] as [Record<string, unknown>];
    // The asset picks the sender's note slot, so it is needed even though no
    // token account is touched; the transfer builder takes no token program.
    expect(input.asset).toBe(USDC);
    expect(input).not.toHaveProperty("splTokenProgram");
  });

  it("refuses a mint outside the spend set before reaching either builder", async () => {
    await expect(
      buildRingWithdrawalTx(deps(), withdrawalInput({ mint: UNKNOWN_MINT }))
    ).rejects.toMatchObject({ name: "HeliusRingsError", code: "invalid_input" });
    await expect(
      buildRingTransferTx(deps(), {
        ...withdrawalInput({ mint: UNKNOWN_MINT }),
        recipient: {} as never,
      })
    ).rejects.toMatchObject({ name: "HeliusRingsError", code: "invalid_input" });
    expect(buildRingWithdrawalTransaction).not.toHaveBeenCalled();
    expect(buildRingTransferTransaction).not.toHaveBeenCalled();
  });

  it("surfaces a malformed persisted ring or table as config_error, never echoing it", async () => {
    // Persisted state, not caller input: the operator fixes the row, and the
    // stored text must never travel back through an error message.
    const cases: Record<string, string>[] = [
      { ringProgramId: "not-an-address" },
      { lookupTable: "also bad" },
    ];
    for (const overrides of cases) {
      const error = await buildRingWithdrawalTx(deps(), withdrawalInput(overrides)).then(
        () => null,
        (thrown: unknown) => thrown as Error
      );
      expect(error).toMatchObject({ name: "HeliusRingsError", code: "config_error" });
      expect(error?.message).not.toContain("not-an-address");
      expect(error?.message).not.toContain("also bad");
    }
    expect(buildRingWithdrawalTransaction).not.toHaveBeenCalled();
  });

  it("hands the entry builder the pinned ring, its table, and the amount, with no recipient and no CU override", async () => {
    await buildRingEntryTx(deps(), {
      ringProgramId: RING_PROGRAM,
      lookupTable: LOOKUP_TABLE,
      mint: SDP_SOL,
      amountRaw: "1000000",
    });

    expect(buildRingEntryTransaction).toHaveBeenCalledTimes(1);
    const [input] = buildRingEntryTransaction.mock.calls[0] as [Record<string, unknown>];
    expect(input).toMatchObject({
      ringProgramId: RING_PROGRAM,
      lookupTable: LOOKUP_TABLE,
      keys: { fake: "keys" },
      feePayer: OWNER,
      amount: 1_000_000n,
      // Named rather than left to the builder's default, like every other ring
      // spend. A move is SOL-only, so the value is that default either way.
      asset: PROTOCOL_SOL,
    });
    // No `recipient` exists to pass: the builder always sends to its own keys'
    // address, which is what makes entry self-only by construction.
    expect(input).not.toHaveProperty("recipient");
    expect(input).not.toHaveProperty("computeUnitLimit");
  });

  it("hands the exit builder the caller-lifted self shielded address as the recipient", async () => {
    const self = { fake: "own-shielded-address" };
    await buildRingExitTx(deps(), {
      ringProgramId: RING_PROGRAM,
      lookupTable: LOOKUP_TABLE,
      mint: SDP_SOL,
      amountRaw: "7",
      recipient: self as never,
    });

    const [input] = buildRingExitTransaction.mock.calls[0] as [Record<string, unknown>];
    // The full object, object-identical: the self-only rule is enforced by the
    // caller lifting its own address, and the builder skips its registry read.
    expect(input.recipient).toBe(self);
    expect(input.amount).toBe(7n);
    expect(input).not.toHaveProperty("computeUnitLimit");
  });

  it("refuses a non-SOL mint before reaching the entry or exit builder", async () => {
    await expect(
      buildRingEntryTx(deps(), {
        ringProgramId: RING_PROGRAM,
        lookupTable: LOOKUP_TABLE,
        mint: USDC,
        amountRaw: "1",
      })
    ).rejects.toMatchObject({ name: "HeliusRingsError", code: "invalid_input" });
    await expect(
      buildRingExitTx(deps(), {
        ringProgramId: RING_PROGRAM,
        lookupTable: LOOKUP_TABLE,
        mint: USDC,
        amountRaw: "1",
        recipient: {} as never,
      })
    ).rejects.toMatchObject({ name: "HeliusRingsError", code: "invalid_input" });
    expect(buildRingEntryTransaction).not.toHaveBeenCalled();
    expect(buildRingExitTransaction).not.toHaveBeenCalled();
  });

  it("passes the transfer recipient through as the caller-lifted shielded address", async () => {
    const shieldedAddress = { fake: "shielded-address" };
    await buildRingTransferTx(deps(), {
      ringProgramId: RING_PROGRAM,
      lookupTable: LOOKUP_TABLE,
      mint: SDP_SOL,
      amountRaw: "5",
      recipient: shieldedAddress as never,
    });

    const [input] = buildRingTransferTransaction.mock.calls[0] as [Record<string, unknown>];
    // The full object, not a bare address: same-tenant resolution stays
    // upstream and the builder skips its on-chain registry lookup.
    expect(input.recipient).toBe(shieldedAddress);
    expect(input.amount).toBe(5n);
  });
});
