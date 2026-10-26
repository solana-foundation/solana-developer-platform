import { describe, expect, it } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";

type Translate = Parameters<typeof getDashboardPageConfig>[1];
const t = ((key: string) => key) as Translate;

describe("Markets dashboard headers", () => {
  it("sets the Markets landing title left over the page column, without header tabs", () => {
    const config = getDashboardPageConfig("/dashboard/markets", t);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "left",
      contentWidthClass: "max-w-page",
    });
    expect(config.headerTabs).toBeUndefined();
    expect(config.headerAction).toBeUndefined();
  });

  it.each([
    "/dashboard/markets/treasury-solutions",
    "/dashboard/markets/embedded-yield",
    "/dashboard/markets/dvp",
  ])("centers the shared Markets title without redundant route tabs for %s", (pathname) => {
    const config = getDashboardPageConfig(pathname, t);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.markets",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
    expect(config.routeTabs).toBeUndefined();
  });

  it("centers the Embedded Yield integration title without header tabs", () => {
    const config = getDashboardPageConfig("/dashboard/markets/embedded-yield/integrate", t);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.configureEarnButton",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
    expect(config.headerTabs).toBeUndefined();
  });

  it("uses the integration title for Embedded Yield configuration", () => {
    const config = getDashboardPageConfig("/dashboard/markets/embedded-yield/configure", t);

    expect(config).toMatchObject({
      title: "Shared.dashboardShell.configureEarnButton",
      titlePosition: "center",
      contentWidthClass: "max-w-none",
    });
  });
});

describe("Integrations dashboard headers", () => {
  it("keeps category navigation in the sidebar submenu", () => {
    const config = getDashboardPageConfig("/dashboard/integrations", t, true);

    expect(config.headerTabs).toBeUndefined();
  });

  it("does not recreate category tabs when modules are disabled", () => {
    const config = getDashboardPageConfig("/dashboard/integrations", t, false);

    expect(config.headerTabs).toBeUndefined();
  });
});

describe("dashboard route headers", () => {
  it.each([
    ["/dashboard/api-keys", "Shared.dashboardShell.apiKeys"],
    ["/dashboard/api-keys/new", "Shared.dashboardShell.newApiKey"],
    ["/dashboard/api-keys/key_1/edit", "Shared.dashboardShell.editApiKey"],
    ["/dashboard/wallets", "Shared.dashboardShell.wallets"],
    ["/dashboard/custody", "Shared.dashboardShell.wallets"],
    ["/dashboard/wallets/setup", "Shared.dashboardShell.createWallet"],
    ["/dashboard/custody/setup", "Shared.dashboardShell.createWallet"],
    ["/dashboard/wallets/connections", "Shared.dashboardShell.connections"],
    ["/dashboard/custody/connections", "Shared.dashboardShell.connections"],
    ["/dashboard/wallets/wallet_1", "Shared.dashboardShell.wallet"],
    ["/dashboard/custody/wallet_1", "Shared.dashboardShell.wallet"],
    ["/dashboard/issuance", "Shared.dashboardShell.issuance"],
    ["/dashboard/issuance/create", "DashboardIssuance.newDesign.draft.pageTitle"],
    ["/dashboard/issuance/token_1", "DashboardIssuance.newDesign.token.pageTitle"],
    ["/dashboard/payments/counterparty", "Shared.dashboardShell.contactList"],
    ["/dashboard/payments/counterparty/create", "Shared.dashboardShell.newDesign.newCounterparty"],
    ["/dashboard/payments/counterparty/cp_1", "Shared.dashboardShell.contact"],
    ["/dashboard/payments", "Shared.dashboardShell.payments"],
    ["/dashboard/payments/transactions", "Shared.dashboardShell.transactions"],
    ["/dashboard/payments/requests", "Shared.dashboardShell.requests"],
    ["/dashboard/payments/requests/new", "DashboardPayments.requests.newRequest"],
    ["/dashboard/payments/recurring", "Shared.dashboardShell.newDesign.recurringPayments"],
    ["/dashboard/payments/recurring/create", "DashboardPayments.recurring.newSchedule"],
    ["/dashboard/payments/recurring/rp_1", "Shared.dashboardShell.newDesign.recurringPayment"],
    ["/dashboard/payments/pay", "Shared.dashboardShell.pay"],
    ["/dashboard/payments/receive", "Shared.dashboardShell.receive"],
    ["/dashboard/integrations", "Shared.dashboardShell.integrations"],
    ["/dashboard/integrations/helius", "Shared.dashboardShell.integrations"],
    ["/dashboard/integrations/private-channels", "Shared.dashboardShell.integrations"],
    ["/dashboard/integrations/private-channels/setup", "Shared.dashboardShell.privacy"],
    [
      "/dashboard/integrations/private-channels/instance_1",
      "Shared.dashboardShell.privateChannels",
    ],
    ["/dashboard/integrations/private-channels/instance_1/setup", "Shared.dashboardShell.privacy"],
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
    ["/dashboard/unknown", "Shared.dashboardShell.newDesign.home"],
  ])("maps %s to its route-specific title", (pathname, title) => {
    expect(getDashboardPageConfig(pathname, t, true).title).toBe(title);
  });
});
