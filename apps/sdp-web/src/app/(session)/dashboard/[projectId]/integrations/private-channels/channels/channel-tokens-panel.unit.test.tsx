import type { PrivateChannelTokenEligibility } from "@sdp/types/private-channels";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/token-mark", () => ({
  TokenMark: ({ symbol }: { symbol: string }) => <span>{symbol}-mark</span>,
}));

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
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

function render(tokens: PrivateChannelTokenEligibility[], loadError: boolean): string {
  return renderToStaticMarkup(
    <ChannelTokensPanel channelName="Treasury" tokens={tokens} loadError={loadError} />
  );
}

describe("ChannelTokensPanel", () => {
  it("shows only allowed tokens with their channel metadata", () => {
    const blockedToken: PrivateChannelTokenEligibility = {
      ...allowedToken,
      symbol: "BLOCKED",
      mint: "short-mint",
      enabled: false,
      exclusionReasons: [{ code: "NOT_ALLOWED_BY_INSTANCE", message: "Not allowed" }],
    };

    const markup = render([allowedToken, blockedToken], false);

    expect(markup).toContain("USDC-mark");
    expect(markup).toContain("4zMMC9…JDncDU");
    expect(markup).toContain(">6<");
    expect(markup).not.toContain("BLOCKED");
  });

  it("shows the empty state when no token is allowed", () => {
    const markup = render([{ ...allowedToken, enabled: false }], false);

    expect(markup).toContain("DashboardPrivateChannels.channelDetail.tokensEmpty");
  });

  it("prioritizes the load error over token content", () => {
    const markup = render([allowedToken], true);

    expect(markup).toContain("DashboardPrivateChannels.channelDetail.tokensLoadError");
    expect(markup).not.toContain("USDC-mark");
  });
});
