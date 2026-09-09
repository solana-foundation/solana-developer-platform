import type { HeliusRingsError } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { buildMerge } from "./merge.js";
import { SDP_USDC_MINT } from "./mint.js";
import { buildRingWithdrawalTx } from "./ring-spend.js";
import { buildTransfer, buildWithdrawal } from "./spend.js";

/** Neither native SOL nor the one SPL asset this build settles. */
const UNKNOWN_MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const RECIPIENT = "11111111111111111111111111111112";

const invalidInput = { code: "invalid_input" } satisfies Partial<HeliusRingsError>;

/**
 * The mint gate runs before note selection, so these reach it with no deps at
 * all: anything that gets past it fails on the wallet instead.
 */
describe("the spend mint gate", () => {
  it.each([
    [
      "withdraw",
      () =>
        buildWithdrawal({} as never, { recipient: RECIPIENT, mint: UNKNOWN_MINT, amountRaw: "1" }),
    ],
    [
      "transfer",
      () =>
        buildTransfer({} as never, { recipient: {} as never, mint: UNKNOWN_MINT, amountRaw: "1" }),
    ],
    ["merge", () => buildMerge({} as never, { mint: UNKNOWN_MINT })],
  ])("refuses an unallowlisted mint on a %s", async (_op, build) => {
    await expect(build()).rejects.toMatchObject(invalidInput);
  });

  it.each([
    [
      "withdraw",
      () =>
        buildWithdrawal({} as never, { recipient: RECIPIENT, mint: SDP_USDC_MINT, amountRaw: "1" }),
    ],
    [
      "transfer",
      () =>
        buildTransfer({} as never, { recipient: {} as never, mint: SDP_USDC_MINT, amountRaw: "1" }),
    ],
    ["merge", () => buildMerge({} as never, { mint: SDP_USDC_MINT })],
  ])("lets USDC through on a %s", async (_op, build) => {
    // Past the gate the build fails reading the wallet these deps do not have,
    // which is exactly how far this assertion needs it to get.
    await expect(build()).rejects.toThrow(TypeError);
  });
});

describe("buildRingWithdrawalTx", () => {
  it("holds a ring spend to the same two mints", async () => {
    await expect(
      buildRingWithdrawalTx({} as never, {
        ringProgramId: RECIPIENT,
        lookupTable: RECIPIENT,
        recipient: RECIPIENT,
        mint: UNKNOWN_MINT,
        amountRaw: "1",
      })
    ).rejects.toMatchObject(invalidInput);
  });
});
