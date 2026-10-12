import { UNIFIED_TRANSACTION_MODULES } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getDashboardPageConfig } from "./dashboard-header";

type Translate = Parameters<typeof getDashboardPageConfig>[1];
const t = ((key: string) => key) as Translate;

function legacyConfig(pathname: string) {
  return getDashboardPageConfig(
    pathname,
    t,
    false,
    false,
    UNIFIED_TRANSACTION_MODULES,
    true,
    true,
    false
  );
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

  it("lists only the transaction modules it is given after All", () => {
    const config = getDashboardPageConfig(
      "/dashboard/payments/transactions",
      t,
      false,
      false,
      ["payments", "earn"],
      true,
      true,
      false
    );
    expect(config.headerTabs?.tabs.map((tab) => tab.id)).toEqual(["all", "payments", "earn"]);
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
    expect(legacyConfig("/dashboard/api-keys")).toEqual(
      getDashboardPageConfig(
        "/dashboard/api-keys",
        t,
        false,
        false,
        UNIFIED_TRANSACTION_MODULES,
        true,
        true,
        true
      )
    );
  });
});
