import { describe, expect, it } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";

type Translate = Parameters<typeof getDashboardPageConfig>[1];
const t = ((key: string) => key) as Translate;

describe("Markets dashboard headers", () => {
  it("centers the Markets landing title without header tabs", () => {
    const config = getDashboardPageConfig("/dashboard/markets", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("uses the shared Markets title and route tabs for Treasury", () => {
    const config = getDashboardPageConfig("/dashboard/markets/treasury-solutions", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "left",
      headerVariant: "markets",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
    expect(config.routeTabs?.tabs).toEqual([
      {
        href: "/dashboard/markets/treasury-solutions",
        label: "Shared.dashboardShell.treasurySolutions",
      },
      {
        href: "/dashboard/markets/embedded-yield",
        label: "Shared.dashboardShell.earnProgram",
      },
    ]);
  });

  it("uses the shared Markets title and route tabs for Embedded Yield", () => {
    const config = getDashboardPageConfig("/dashboard/markets/embedded-yield", t, false, false);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "left",
      headerVariant: "markets",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
    expect(config.routeTabs?.tabs).toHaveLength(2);
  });

  it("centers the Embedded Yield integration title without header tabs", () => {
    const config = getDashboardPageConfig(
      "/dashboard/markets/embedded-yield/integrate",
      t,
      false,
      false
    );

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.configureEarnButton",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("uses the integration title for Embedded Yield configuration", () => {
    const config = getDashboardPageConfig(
      "/dashboard/markets/embedded-yield/configure",
      t,
      false,
      false
    );

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.configureEarnButton",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
  });
});

describe("Integrations dashboard headers", () => {
  it("shows every family when its owning module is enabled", () => {
    const config = getDashboardPageConfig(
      "/dashboard/integrations",
      t,
      false,
      true,
      true,
      true,
      true
    );

    expect(config.headerTabs?.tabs.map((tab) => tab.id)).toEqual([
      "all",
      "custody",
      "rpc",
      "ramps",
      "compliance",
      "privacy",
    ]);
  });

  it("removes module-specific families when their modules are disabled", () => {
    const config = getDashboardPageConfig(
      "/dashboard/integrations",
      t,
      false,
      false,
      false,
      false,
      false
    );

    expect(config.headerTabs?.tabs.map((tab) => tab.id)).toEqual(["all", "rpc"]);
  });
});

describe("Policies dashboard headers", () => {
  it("keeps only API key policies when Custody is disabled", () => {
    const config = getDashboardPageConfig("/dashboard/policies", t, false, false, false);

    expect(config.headerTabs?.tabs.map((tab) => tab.id)).toEqual(["api_keys"]);
  });
});

describe("dashboard route headers", () => {
  it.each([
    ["/dashboard/api-keys", "Shared.dashboardShell.apiKeys"],
    ["/dashboard/api-keys/new", "Shared.dashboardShell.newApiKey"],
    ["/dashboard/api-keys/key_1/edit", "Shared.dashboardShell.editApiKey"],
    ["/dashboard/approvals", "Shared.dashboardShell.approvals"],
    ["/dashboard/approvals/request_1", "Shared.dashboardShell.approvals"],
    ["/dashboard/wallets", "Shared.dashboardShell.wallets"],
    ["/dashboard/custody", "Shared.dashboardShell.wallets"],
    ["/dashboard/wallets/setup", "Shared.dashboardShell.createWallet"],
    ["/dashboard/custody/setup", "Shared.dashboardShell.createWallet"],
    ["/dashboard/wallets/connections", "Shared.dashboardShell.connections"],
    ["/dashboard/custody/connections", "Shared.dashboardShell.connections"],
    ["/dashboard/wallets/switch", "Shared.dashboardShell.activateProvider"],
    ["/dashboard/custody/switch", "Shared.dashboardShell.activateProvider"],
    ["/dashboard/wallets/wallet_1", "Shared.dashboardShell.wallets"],
    ["/dashboard/custody/wallet_1", "Shared.dashboardShell.wallets"],
    ["/dashboard/wallets/wallet_1/policy", "Shared.dashboardShell.walletControls"],
    [
      "/dashboard/wallets/wallet_1/policy/audit/evaluation_1",
      "Shared.dashboardShell.walletControls",
    ],
    ["/dashboard/issuance", "Shared.dashboardShell.issuance"],
    ["/dashboard/issuance/create", "Shared.dashboardShell.newAsset"],
    ["/dashboard/payments/counterparty", "Shared.dashboardShell.counterparty"],
    ["/dashboard/payments/counterparty/create", "Shared.dashboardShell.newCounterparty"],
    ["/dashboard/payments/counterparty/cp_1", "Shared.dashboardShell.manageCounterparty"],
    ["/dashboard/payments", "Shared.dashboardShell.payments"],
    ["/dashboard/payments/transactions", "Shared.dashboardShell.transactions"],
    ["/dashboard/payments/requests", "Shared.dashboardShell.requests"],
    ["/dashboard/payments/recurring", "Shared.dashboardShell.recurringPayments"],
    ["/dashboard/payments/recurring/create", "Shared.dashboardShell.recurringPayment"],
    ["/dashboard/payments/recurring/rp_1", "Shared.dashboardShell.recurringPayment"],
    ["/dashboard/payments/pay", "Shared.dashboardShell.pay"],
    ["/dashboard/payments/receive", "Shared.dashboardShell.receive"],
    ["/dashboard/integrations", "Shared.dashboardShell.integrations"],
    ["/dashboard/integrations/helius", "Shared.dashboardShell.integrations"],
    ["/dashboard/integrations/private-channels", "Shared.dashboardShell.integrations"],
    ["/dashboard/integrations/private-channels/setup", "DashboardPrivateChannels.instance.title"],
    [
      "/dashboard/integrations/private-channels/instance_1",
      "Shared.dashboardShell.privateChannels",
    ],
    [
      "/dashboard/integrations/private-channels/instance_1/setup",
      "DashboardPrivateChannels.instance.title",
    ],
    [
      "/dashboard/integrations/private-channels/instance_1/channels/new",
      "DashboardPrivateChannels.directory.setupChannel",
    ],
    [
      "/dashboard/integrations/private-channels/instance_1/channels/channel_1",
      "Shared.dashboardShell.privateChannels",
    ],
    ["/dashboard/integrations/private-channels/overview", "Shared.dashboardShell.privateChannels"],
    ["/dashboard/integrations/private-channels/channels", "DashboardPrivateChannels.tabs.channels"],
    ["/dashboard/integrations/private-channels/deposit", "Shared.dashboardShell.privateChannels"],
    ["/dashboard/integrations/private-channels/transfer", "Shared.dashboardShell.privateChannels"],
    ["/dashboard/integrations/private-channels/withdraw", "Shared.dashboardShell.privateChannels"],
    ["/dashboard/integrations/private-channels/members", "DashboardPrivateChannels.tabs.members"],
    [
      "/dashboard/integrations/private-channels/wallets",
      "DashboardPrivateChannels.overview.walletsTitle",
    ],
    ["/dashboard/integrations/private-channels/events", "Shared.dashboardShell.privateChannels"],
    ["/dashboard/settings", "Shared.dashboardShell.settings"],
    ["/dashboard/allowlist", "Shared.dashboardShell.allowlist"],
    ["/dashboard/unknown", "Shared.dashboardShell.home"],
  ])("maps %s to its route-specific title", (pathname, title) => {
    expect(getDashboardPageConfig(pathname, t, false, true, true, true, true).title).toBe(title);
  });

  it("uses the asset-management header only for enabled Asset Profiles", () => {
    expect(getDashboardPageConfig("/dashboard/issuance/token_1", t, true, false).title).toBe(
      "Shared.dashboardShell.assetManagement"
    );
    expect(getDashboardPageConfig("/dashboard/issuance/token_1", t, false, false).title).toBe(
      "Shared.dashboardShell.issuance"
    );
  });
});
