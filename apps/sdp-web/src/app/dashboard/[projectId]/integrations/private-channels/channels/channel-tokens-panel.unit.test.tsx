import type { PrivateChannelTokenEligibility } from "@sdp/types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/token-mark", () => ({
  TokenMark: ({ symbol }: { symbol: string }) => <span>{symbol}-mark</span>,
}));

vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    values?.channel ? `${key}:${values.channel}` : key,
}));

import { ChannelTokensPanel } from "./channel-tokens-panel";

const allowedToken: PrivateChannelTokenEligibility = {
  symbol: "USDC",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  decimals: 6,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  enabled: true,
  exclusionReasons: [],
};

async function render(
  tokens: PrivateChannelTokenEligibility[],
  loadError = false
): Promise<string> {
  return renderToStaticMarkup(
    await ChannelTokensPanel({ channelName: "Treasury", tokens, loadError })
  );
}

describe("ChannelTokensPanel", () => {
  it("shows only allowed tokens with their channel metadata", async () => {
    const blockedToken: PrivateChannelTokenEligibility = {
      ...allowedToken,
      symbol: "BLOCKED",
      mint: "short-mint",
      enabled: false,
      exclusionReasons: [{ code: "NOT_ALLOWED_BY_INSTANCE", message: "Not allowed" }],
    };

    const markup = await render([allowedToken, blockedToken]);

    expect(markup).toContain("USDC-mark");
    expect(markup).toContain("4zMMC9…JDncDU");
    expect(markup).toContain(">6<");
    expect(markup).not.toContain("BLOCKED");
  });

  it("shows the empty state when no token is allowed", async () => {
    const markup = await render([{ ...allowedToken, enabled: false }]);

    expect(markup).toContain("DashboardPrivateChannels.channelDetail.tokensEmpty");
  });

  it("prioritizes the load error over token content", async () => {
    const markup = await render([allowedToken], true);

    expect(markup).toContain("DashboardPrivateChannels.channelDetail.tokensLoadError");
    expect(markup).not.toContain("USDC-mark");
  });
});
