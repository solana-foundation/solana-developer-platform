import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CustodyDetailLoading from "../custody/[walletId]/loading";
import CustodyAuditDetailLoading from "../custody/[walletId]/policy/audit/[policyEvaluationId]/loading";
import CustodyAuditLoading from "../custody/[walletId]/policy/audit/loading";
import CustodyPolicyLoading from "../custody/[walletId]/policy/loading";
import CustodyRevisionsLoading from "../custody/[walletId]/policy/revisions/loading";
import CustodyLoading from "../custody/loading";
import CustodySetupLoading from "../custody/setup/loading";
import CustodySwitchLoading from "../custody/switch/loading";
import WalletDetailLoading from "./[walletId]/loading";
import WalletAuditDetailLoading from "./[walletId]/policy/audit/[policyEvaluationId]/loading";
import WalletAuditLoading from "./[walletId]/policy/audit/loading";
import WalletPolicyLoading from "./[walletId]/policy/loading";
import WalletRevisionsLoading from "./[walletId]/policy/revisions/loading";
import WalletsLoading from "./loading";
import WalletSetupLoading from "./setup/loading";
import WalletSwitchLoading from "./switch/loading";
import {
  WalletDetailSkeleton,
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
  ["wallet policy revisions", WalletRevisionsLoading, "wallet-policy-revisions"],
  ["custody policy revisions alias", CustodyRevisionsLoading, "wallet-policy-revisions"],
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

  it("keeps the policy editor form, summary rail, and footer in place", () => {
    const html = renderToStaticMarkup(<WalletPolicySkeleton />);

    expect(html).toContain('data-skeleton-section="policy-form"');
    expect(html).toContain('data-skeleton-section="policy-summary"');
    expect(html).toContain("<footer");
  });

  it("uses the organization-sync card geometry for the onboarding fallback", () => {
    const html = renderToStaticMarkup(<WalletsOnboardingSkeleton />);

    expect(html).toContain('data-wallet-loading-layout="wallets-onboarding"');
    expect(html).toContain("rounded-[24px]");
    expect(html).not.toContain("grid-cols-3");
  });
});
