import type { HeliusRingsError } from "@sdp/helius-rings";
import { describe, expect, it } from "vitest";
import { buildWithdrawal } from "./spend.js";

describe("buildWithdrawal", () => {
  it("refuses SPL withdrawals", async () => {
    await expect(
      buildWithdrawal({} as never, {
        recipient: "11111111111111111111111111111112",
        mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        amountRaw: "1",
      })
    ).rejects.toMatchObject({
      code: "invalid_input",
    } satisfies Partial<HeliusRingsError>);
  });
});
