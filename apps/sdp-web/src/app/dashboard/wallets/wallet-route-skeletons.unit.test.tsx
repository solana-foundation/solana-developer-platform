import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CustodyDetailLoading from "../custody/[walletId]/loading";
import CustodyAuditDetailLoading from "../custody/[walletId]/policy/audit/[policyEvaluationId]/loading";
import CustodyAuditLoading from "../custody/[walletId]/policy/audit/loading";
import CustodyPolicyLoading from "../custody/[walletId]/policy/loading";
import CustodyLoading from "../custody/loading";
import CustodySetupLoading from "../custody/setup/loading";
import CustodySwitchLoading from "../custody/switch/loading";
import WalletDetailLoading from "./[walletId]/loading";
import WalletAuditDetailLoading from "./[walletId]/policy/audit/[policyEvaluationId]/loading";
import WalletAuditLoading from "./[walletId]/policy/audit/loading";
import WalletPolicyLoading from "./[walletId]/policy/loading";
import WalletsLoading from "./loading";
import WalletSetupLoading from "./setup/loading";
import WalletSwitchLoading from "./switch/loading";
import {
  WalletDetailSkeleton,
  WalletPolicyAuditDetailSkeleton,
  WalletPolicyAuditListSkeleton,
  WalletPolicySkeleton,
  WalletsOnboardingSkeleton,
} from "./wallet-route-skeletons";

const routeLoaders = [
  ["wallets overview", WalletsLoading, "wallets-overview"],
  ["custody overview alias", CustodyLoading, "wallets-overview"],
  ["wallet setup", WalletSetupLoading, "wallet-setup"],
  ["custody setup alias", CustodySetupLoading, "wallet-setup"],
  ["wallet provider switch", WalletSwitchLoading, "wallet-setup"],
  ["custody provider switch alias", CustodySwitchLoading, "wallet-setup"],
  ["wallet detail", WalletDetailLoading, "wallet-detail"],
  ["custody detail alias", CustodyDetailLoading, "wallet-detail"],
  ["wallet policy", WalletPolicyLoading, "wallet-policy"],
  ["custody policy alias", CustodyPolicyLoading, "wallet-policy"],
  ["wallet policy audit", WalletAuditLoading, "wallet-policy-audit-list"],
  ["custody policy audit alias", CustodyAuditLoading, "wallet-policy-audit-list"],
  ["wallet policy audit detail", WalletAuditDetailLoading, "wallet-policy-audit-detail"],
  ["custody policy audit detail alias", CustodyAuditDetailLoading, "wallet-policy-audit-detail"],
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

    expect(html).toContain('data-skeleton-section="wallet-controls"');
    expect(html).toContain('data-skeleton-section="wallet-balances"');
    expect(html).toContain('data-skeleton-section="wallet-activity"');
  });

  it("reserves the responsive wallet search toolbar while the overview loads", () => {
    const html = renderToStaticMarkup(<WalletsLoading />);

    expect(html).toContain('data-wallet-search-skeleton="true"');
    expect(html).toContain("flex-col gap-3 sm:flex-row");
    expect(html).toContain("sm:max-w-md");
  });

  it("keeps the policy editor form, summary rail, and footer in place", () => {
    const html = renderToStaticMarkup(<WalletPolicySkeleton />);

    expect(html).toContain('data-skeleton-section="policy-form"');
    expect(html).toContain('data-skeleton-section="policy-summary"');
    expect(html).toContain("<footer");
  });

  it("matches the policy audit list's card layout", () => {
    const html = renderToStaticMarkup(<WalletPolicyAuditListSkeleton />);

    expect(html.match(/data-loading-audit-title-line="true"/g)).toHaveLength(2);
    expect(html.match(/data-loading-audit-description-line="true"/g)).toHaveLength(2);
    expect(html).toContain('data-loading-audit-filters="true"');
    expect(html).toContain("xl:grid-cols-5");
    expect(html).not.toContain("data-loading-filter-apply");
    expect(html).toContain('data-loading-audit-rows="true"');
    expect(html).toContain('data-loading-audit-footer="true"');
    expect(html).toContain("mt-auto");
  });

  it("stacks policy audit decision steps until the small breakpoint", () => {
    const html = renderToStaticMarkup(<WalletPolicyAuditDetailSkeleton />);

    expect(html).toContain("flex flex-wrap items-start gap-3");
    expect(html.match(/data-loading-detail-title-line="true"/g)).toHaveLength(2);
    expect(html).toContain('data-loading-detail-decision-badge="true"');
    expect(html).toContain("grid gap-2 sm:flex sm:flex-wrap sm:gap-4");
    expect(html.match(/data-loading-detail-metadata="true"/g)).toHaveLength(4);
    expect(html.match(/data-loading-audit-step="true"/g)).toHaveLength(5);
    expect(html).toContain("sm:grid-cols-[40px_minmax(0,1fr)_auto]");
    expect(html).not.toContain(" grid-cols-[40px_minmax(0,1fr)_auto]");
    expect(html).toContain('data-loading-step-icon="true"');
    expect(html).toContain("flex items-center gap-2 sm:block");
  });

  it("uses the organization-sync card geometry for the onboarding fallback", () => {
    const html = renderToStaticMarkup(<WalletsOnboardingSkeleton />);

    expect(html).toContain('data-wallet-loading-layout="wallets-onboarding"');
    expect(html).toContain("rounded-[24px]");
    expect(html).not.toContain("grid-cols-3");
  });
});
