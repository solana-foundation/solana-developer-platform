import { describe, expect, it, vi } from "vitest";

const flagMocks = vi.hoisted(() => ({
  custody: vi.fn(),
  earn: vi.fn(),
  issuance: vi.fn(),
}));

vi.mock("@/flags", () => flagMocks);
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import CustodyLayout from "./custody/layout";
import IssuanceLayout from "./issuance/layout";
import EarnAliasLayout from "./markets/earn/layout";
import EmbeddedYieldLayout from "./markets/embedded-yield/layout";
import TokensLayout from "./tokens/layout";
import WalletsLayout from "./wallets/layout";

describe("dashboard module feature gates", () => {
  it("404s every Custody route when Custody is disabled", async () => {
    flagMocks.custody.mockResolvedValue(false);

    await expect(CustodyLayout({ children: <div>Custody</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s every Wallets alias route when Custody is disabled", async () => {
    flagMocks.custody.mockResolvedValue(false);

    await expect(WalletsLayout({ children: <div>Wallets</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s the wallet-derived Tokens route when Custody is disabled", async () => {
    flagMocks.custody.mockResolvedValue(false);

    await expect(TokensLayout({ children: <div>Tokens</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s every Issuance route when Issuance is disabled", async () => {
    flagMocks.issuance.mockResolvedValue(false);

    await expect(IssuanceLayout({ children: <div>Issuance</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s every Embedded Yield route when Earn is disabled", async () => {
    flagMocks.earn.mockResolvedValue(false);

    await expect(EmbeddedYieldLayout({ children: <div>Earn</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s the Earn alias route when Earn is disabled", async () => {
    flagMocks.earn.mockResolvedValue(false);

    await expect(EarnAliasLayout({ children: <div>Earn</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
