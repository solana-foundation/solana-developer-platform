import { describe, expect, it } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";

type Translate = Parameters<typeof getDashboardPageConfig>[1];
const t = ((key: string) => key) as Translate;

function legacyConfig(pathname: string) {
  return getDashboardPageConfig(pathname, t, false, false, true, true, true, false);
}

describe("dashboard headers with NEW DESIGN off", () => {
  it("gives Payments, Counterparty and Requests their playground tabs", () => {
    for (const pathname of [
      "/dashboard/payments",
      "/dashboard/payments/counterparty",
      "/dashboard/payments/requests",
    ]) {
      expect(legacyConfig(pathname).headerTabs?.tabs.map((tab) => tab.id)).toContain("playground");
    }
  });

  it("keeps the transaction module tabs and no page action", () => {
    const config = legacyConfig("/dashboard/payments/transactions");
    expect(config.headerTabs?.tabs[0]?.id).toBe("all");
    expect(config.headerAction).toBeUndefined();
  });

  it("names Counterparty and Recurring as the previous design does", () => {
    expect(legacyConfig("/dashboard/payments/counterparty").title).toBe(
      "Shared.dashboardShell.counterparty"
    );
    expect(legacyConfig("/dashboard/payments/recurring").title).toBe(
      "Shared.dashboardShell.recurringPayments"
    );
    expect(legacyConfig("/dashboard/payments/recurring/create").title).toBe(
      "Shared.dashboardShell.recurringPayment"
    );
  });

  it("titles the Privacy connect form with a way back", () => {
    const config = legacyConfig("/dashboard/integrations/private-channels/setup");
    expect(config.title).toBe("DashboardPrivateChannels.instance.title");
  });

  it("leaves other routes as they are", () => {
    expect(legacyConfig("/dashboard/policies")).toEqual(
      getDashboardPageConfig("/dashboard/policies", t, false, false, true, true, true, true)
    );
  });
});
