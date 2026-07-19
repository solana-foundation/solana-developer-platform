import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/app/dashboard/custody/wallet-activity-section", () => ({
  WalletActivitySection: ({ isVisible }: { isVisible: boolean }) => (
    <div data-activity-fetcher="mounted" data-activity-fetcher-visible={String(isVisible)} />
  ),
}));

import { WalletActivityViewportContent } from "./wallet-activity-viewport";

describe("WalletActivityViewportContent", () => {
  it("keeps the fetcher unmounted until the near-viewport observer latches", () => {
    const deferredMarkup = renderToStaticMarkup(
      <WalletActivityViewportContent
        isNearViewport={false}
        isVisible={false}
        walletId="wallet-one"
      />
    );
    const mountedMarkup = renderToStaticMarkup(
      <WalletActivityViewportContent isNearViewport isVisible={false} walletId="wallet-one" />
    );

    expect(deferredMarkup).not.toContain('data-activity-fetcher="mounted"');
    expect(deferredMarkup).toContain("DashboardCustody.recentActivity");
    expect(mountedMarkup.match(/data-activity-fetcher="mounted"/g)).toHaveLength(1);
    expect(mountedMarkup).toContain('data-activity-fetcher-visible="false"');
  });
});
