import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  type EncodedAccount,
  getAddressDecoder,
  lamports,
  type ReadonlyUint8Array,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { type ExtensionArgs, getMintEncoder } from "@solana-program/token-2022";
import { findProblems } from "./check-well-known-mints";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const MINT = testAddress(1);
const AUTHORITY = testAddress(2);
const HOOK_PROGRAM = testAddress(3);
const UNSET = address("11111111111111111111111111111111");
const EPOCH = 700n;

function account(
  address: Address,
  programAddress: Address,
  data: ReadonlyUint8Array
): EncodedAccount {
  return { address, data, executable: false, lamports: lamports(1n), programAddress, space: 0n };
}

const clock = account(
  SYSVAR_CLOCK_ADDRESS,
  address("Sysvar1111111111111111111111111111111111111"),
  getSysvarClockEncoder().encode({
    slot: 284_617_079n,
    epochStartTimestamp: unixTimestamp(1_799_990_000n),
    epoch: EPOCH,
    leaderScheduleEpoch: EPOCH + 1n,
    unixTimestamp: unixTimestamp(1_800_000_000n),
  })
);

/** A 6-decimal Token-2022 mint with a fee config whose newer entry starts at `EPOCH + 2`. */
function problemsOf(newer: { bps: number; max: bigint }, hookProgram: Address): string[] {
  const rate = (epoch: bigint, bps: number, max: bigint) => ({
    epoch,
    maximumFee: max,
    transferFeeBasisPoints: bps,
  });
  const extensions: ExtensionArgs[] = [
    {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: AUTHORITY,
      withdrawWithheldAuthority: AUTHORITY,
      withheldAmount: 0n,
      olderTransferFee: rate(0n, 0, 0n),
      newerTransferFee: rate(EPOCH + 2n, newer.bps, newer.max),
    },
    { __kind: "TransferHook", authority: AUTHORITY, programId: hookProgram },
  ];
  const data = getMintEncoder().encode({
    mintAuthority: AUTHORITY,
    supply: 1_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: AUTHORITY,
    extensions,
  });
  const mint = account(MINT, address(SPL_TOKEN_PROGRAMS["token-2022"]), data);
  return findProblems({ mint, clock }, { address: MINT, decimals: 6 }, "token-2022").problems;
}

describe("findProblems", () => {
  it("fails a fee set for a later epoch, before it takes effect", () => {
    assert.deepEqual(problemsOf({ bps: 10, max: 1_000n }, UNSET), [
      "the newer fee entry (epoch 702) takes 1000 base units from a 1000-token transfer",
    ]);
  });

  it("passes a fee config whose maximum is 0, whatever its basis points", () => {
    assert.deepEqual(problemsOf({ bps: 50, max: 0n }, UNSET), []);
  });

  it("fails a transfer hook program", () => {
    assert.deepEqual(problemsOf({ bps: 0, max: 0n }, HOOK_PROGRAM), [
      `a transfer hook program is set: ${HOOK_PROGRAM}`,
    ]);
  });
});
