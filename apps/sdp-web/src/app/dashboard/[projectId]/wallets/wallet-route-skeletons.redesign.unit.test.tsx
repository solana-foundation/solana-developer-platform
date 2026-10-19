import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CustodyDetailLoading from "@/app/dashboard/[projectId]/custody/[walletId]/loading";
import CustodyLoading from "@/app/dashboard/[projectId]/custody/loading";
import CustodySetupLoading from "@/app/dashboard/[projectId]/custody/setup/loading";
import { WalletsOnboardingSkeleton } from "@/app/dashboard/[projectId]/wallets/wallet-route-skeletons";
import WalletDetailLoading from "./[walletId]/loading";
import WalletsLoading from "./loading";
import WalletSetupLoading from "./setup/loading";
import { WalletDetailSkeleton } from "./wallet-route-skeletons.redesign";

// NEW DESIGN on.
vi.mock("@/components/new-design", () => ({
  DesignSwitch: ({ current }: { current: unknown }) => current,
  useNewDesign: () => true,
}));

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

    expect(html).toContain('data-skeleton-section="wallet-state"');
    expect(html).toContain('data-skeleton-section="wallet-balance"');
    expect(html).toContain('data-skeleton-section="wallet-tokens"');
    expect(html).toContain('data-skeleton-section="wallet-activity"');
  });

  it("reserves the two-column wallet card grid while the overview loads", () => {
    const html = renderToStaticMarkup(<WalletsLoading />);

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
