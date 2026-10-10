import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CustodyDetailLoading from "../custody/[walletId]/loading";
import CustodyLoading from "../custody/loading";
import CustodySetupLoading from "../custody/setup/loading";
import WalletDetailLoading from "./[walletId]/loading";
import WalletsLoading from "./loading";
import WalletSetupLoading from "./setup/loading";
import { WalletDetailSkeleton, WalletsOnboardingSkeleton } from "./wallet-route-skeletons";

const routeLoaders = [
  ["wallets overview", WalletsLoading, "wallets-overview"],
  ["custody overview alias", CustodyLoading, "wallets-overview"],
  ["wallet setup", WalletSetupLoading, "wallet-setup"],
  ["custody setup alias", CustodySetupLoading, "wallet-setup"],
  ["wallet detail", WalletDetailLoading, "wallet-detail"],
  ["custody detail alias", CustodyDetailLoading, "wallet-detail"],
] as const;

describe("wallet and custody route loading states", () => {
  it.each(routeLoaders)("maps %s to its final-page geometry", (_name, Loader, layout) => {
    const html = renderToStaticMarkup(<Loader />);

    expect(html).toContain(`data-wallet-loading-layout="${layout}"`);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("motion-reduce:animate-none");
    expect(html).not.toContain("bg-white");
  });

  it("keeps every wallet-detail section in place while data loads", () => {
    const html = renderToStaticMarkup(<WalletDetailSkeleton />);

    expect(html).toContain('data-skeleton-section="wallet-balances"');
    expect(html).toContain('data-skeleton-section="wallet-activity"');
  });

  it("reserves the responsive wallet search toolbar while the overview loads", () => {
    const html = renderToStaticMarkup(<WalletsLoading />);

    expect(html).toContain('data-wallet-search-skeleton="true"');
    expect(html).toContain("flex-col gap-3 sm:flex-row");
    expect(html).toContain("sm:max-w-md");
  });

  it("uses the organization-sync card geometry for the onboarding fallback", () => {
    const html = renderToStaticMarkup(<WalletsOnboardingSkeleton />);

    expect(html).toContain('data-wallet-loading-layout="wallets-onboarding"');
    expect(html).toContain("rounded-[24px]");
    expect(html).not.toContain("grid-cols-3");
  });
});
