import type { PrivateChannelTokenEligibility } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { enabledTokenSymbols, shortenAddress } from "./private-channels-view-data";

const token: PrivateChannelTokenEligibility = {
  decimals: 6,
  enabled: true,
  exclusionReasons: [],
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  symbol: "USDC",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
};

describe("private channel view data", () => {
  it("lists only enabled token symbols", () => {
    expect(enabledTokenSymbols([token, { ...token, enabled: false, symbol: "USDT" }])).toEqual([
      "USDC",
    ]);
  });

  it("shortens addresses to the requested width and preserves short values", () => {
    expect(shortenAddress("1234567890abcdef", 6)).toBe("123456…abcdef");
    expect(shortenAddress("1234567890abcdefghijklmnop", 8)).toBe("12345678…ijklmnop");
    expect(shortenAddress("short-address", 6)).toBe("short-address");
  });
});
