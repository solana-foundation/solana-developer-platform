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

describe("dashboard headers for Requests and Schedules with new-design-activity on", () => {
  const activityConfig = (pathname: string) =>
    getDashboardPageConfig(pathname, t, false, false, true, true, true, true, { activity: true });

  it("keep the previous design's header, Requests' playground switch included", () => {
    for (const pathname of [
      "/dashboard/payments/requests",
      "/dashboard/payments/recurring",
      "/dashboard/payments/recurring/create",
      "/dashboard/payments/recurring/rp_1",
    ]) {
      expect(activityConfig(pathname)).toEqual(legacyConfig(pathname));
    }
    const requests = activityConfig("/dashboard/payments/requests");
    expect(requests.headerTabs?.tabs.map((tab) => tab.id)).toContain("playground");
    expect(requests.headerAction).toBeUndefined();
  });

  it("still gives Transactions the new design's header", () => {
    expect(activityConfig("/dashboard/payments/transactions").headerAction?.href).toBe(
      "/api/dashboard/payments/transactions/export"
    );
  });
});
