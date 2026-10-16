import type { SdpModule } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";

const channelMocks = vi.hoisted(() => ({
  isModuleInDeploymentReleaseChannel: vi.fn<(module: SdpModule) => boolean>(),
}));

vi.mock("@/flags/release-channel", () => channelMocks);
vi.mock("next/navigation", () => import("@/test/next-navigation"));

import CustodyLayout from "./custody/layout";
import IssuanceLayout from "./issuance/layout";
import EarnAliasLayout from "./markets/earn/layout";
import EmbeddedYieldLayout from "./markets/embedded-yield/layout";
import TokensLayout from "./tokens/layout";
import WalletsLayout from "./wallets/layout";

describe("dashboard module feature gates", () => {
  it("404s every Custody route when the release channel leaves Custody out", async () => {
    channelMocks.isModuleInDeploymentReleaseChannel.mockImplementation(
      (module) => module !== "custody"
    );

    await expect(CustodyLayout({ children: <div>Custody</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s every Wallets alias route when the release channel leaves Custody out", async () => {
    channelMocks.isModuleInDeploymentReleaseChannel.mockImplementation(
      (module) => module !== "custody"
    );

    await expect(WalletsLayout({ children: <div>Wallets</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s the wallet-derived Tokens route when the release channel leaves Custody out", async () => {
    channelMocks.isModuleInDeploymentReleaseChannel.mockImplementation(
      (module) => module !== "custody"
    );

    await expect(TokensLayout({ children: <div>Tokens</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s every Issuance route when the release channel leaves Issuance out", async () => {
    channelMocks.isModuleInDeploymentReleaseChannel.mockImplementation(
      (module) => module !== "issuance"
    );

    await expect(IssuanceLayout({ children: <div>Issuance</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s every Embedded Yield route when the release channel leaves Earn out", async () => {
    channelMocks.isModuleInDeploymentReleaseChannel.mockImplementation(
      (module) => module !== "earn"
    );

    await expect(EmbeddedYieldLayout({ children: <div>Earn</div> })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("404s the Earn alias route when the release channel leaves Earn out", async () => {
    channelMocks.isModuleInDeploymentReleaseChannel.mockImplementation(
      (module) => module !== "earn"
    );

    await expect(EarnAliasLayout({ children: <div>Earn</div> })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
