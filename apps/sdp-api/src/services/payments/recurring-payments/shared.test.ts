import { runInClusterScope } from "@sdp/rpc/scope";
import { type SdpEnvironment, WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { assertRecurringPaymentTokenMint } from "./shared";

describe("assertRecurringPaymentTokenMint", () => {
  it.each([
    ["sandbox", WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address],
    ["production", WELL_KNOWN_TOKENS.USDC.mints.devnet.address],
  ] as const satisfies readonly (readonly [SdpEnvironment, string])[])(
    "refuses the other cluster's USDC mint in a %s scope",
    async (environment, foreignMint) => {
      await expect(
        runInClusterScope({ projectId: null, environment }, () =>
          assertRecurringPaymentTokenMint(
            foreignMint,
            "org_recurring_token",
            "prj_recurring_token",
            env
          )
        )
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message:
          "Recurring payments support USD stablecoins and tokens issued in this project; native SOL is not supported",
      });
    }
  );
});
