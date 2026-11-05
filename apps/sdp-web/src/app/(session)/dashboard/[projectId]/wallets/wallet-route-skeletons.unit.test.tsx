import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WalletCardsSkeleton,
  WalletDetailSkeleton,
  WalletSetupSkeleton,
  WalletsOnboardingSkeleton,
  WalletsOverviewSkeleton,
} from "./wallet-route-skeletons";

const routeLoaders = [
  ["wallets overview", WalletsOverviewSkeleton, "wallets-overview"],
  ["wallet setup", WalletSetupSkeleton, "wallet-setup"],
  ["wallet detail", WalletDetailSkeleton, "wallet-detail"],
] as const;

describe("wallet route loading states", () => {
  it.each(routeLoaders)("maps %s to its final-page geometry", (_name, Loader, layout) => {
    const html = renderToStaticMarkup(<Loader />);

    expect(html).toContain(`data-wallet-loading-layout="${layout}"`);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).not.toContain("bg-white");
  });

  it("keeps every wallet-detail section in place while data loads", () => {
    const html = renderToStaticMarkup(<WalletDetailSkeleton />);

    expect(html).toContain('data-skeleton-section="wallet-state"');
    expect(html).toContain('data-skeleton-section="wallet-balance"');
    expect(html).toContain('data-skeleton-section="wallet-tokens"');
    expect(html).toContain('data-skeleton-section="wallet-activity"');
  });

  it("reserves the two-column wallet card grid while the list loads", () => {
    const html = renderToStaticMarkup(<WalletCardsSkeleton />);

    expect(html).toContain('data-wallet-grid-skeleton="true"');
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("bg-surface-tile");
  });

  it("uses the organization-sync card geometry for the onboarding fallback", () => {
    const html = renderToStaticMarkup(<WalletsOnboardingSkeleton />);

    expect(html).toContain('data-wallet-loading-layout="wallets-onboarding"');
    expect(html).toContain("rounded-[24px]");
    expect(html).not.toContain("grid-cols-3");
  });
});
