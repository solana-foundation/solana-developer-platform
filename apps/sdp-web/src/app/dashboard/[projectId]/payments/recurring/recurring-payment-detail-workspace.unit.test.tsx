import type { PaymentRecurringPaymentStatus } from "@sdp/types/payments";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DashboardWorkspaceProvider } from "@/contexts/dashboard-workspace-context";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { buildWorld } from "@/lib/payments-demo/demo-fixtures";
import { SANDBOX_PROJECT } from "@/test/projects";
import { dashboardFlagsAt } from "@/test/release-channel-flags";
import { RecurringPaymentDetailWorkspace } from "./recurring-payment-detail-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, orgId: "org_test", userId: "user_test" }),
}));

const FAILURE = "Privy refused to sign this request because of a wallet policy.";

function renderDetail(status: PaymentRecurringPaymentStatus, recovered = false) {
  const world = buildWorld(new Date("2026-10-30T12:00:00Z"), []);
  const schedule = world.schedules[0];
  const attempt = world.attempts[0];
  if (!schedule?.sourceCustodyWalletId || !attempt) throw new Error("Missing recurring fixture");
  const wallets = Object.values(world.wallets);
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <DashboardWorkspaceProvider
        scopeRefreshFallback={null}
        dashboardAccess={resolveDashboardAccess("admin")}
        flags={dashboardFlagsAt("stable")}
        serverDashboardCacheScope={{ orgId: "org_test", userId: "user_test" }}
        projects={[SANDBOX_PROJECT]}
      >
        <RecurringPaymentDetailWorkspace
          recurringPayment={{
            ...schedule,
            sourceCustodyWalletId: schedule.sourceCustodyWalletId,
            status,
            pausedReason: status === "paused" ? "custody_policy_refused" : null,
          }}
          wallet={wallets.find((wallet) => wallet.id === schedule.sourceCustodyWalletId) ?? null}
          wallets={wallets}
          issuedTokensByMint={{}}
          counterpartyAccounts={Object.values(world.accounts)}
          counterpartyLabel="Test recipient"
          collectionAttempts={[
            {
              ...attempt,
              status: recovered ? "confirmed" : "failed",
              error: recovered ? null : FAILURE,
            },
          ]}
          collectionAttemptsTotal={1}
        />
      </DashboardWorkspaceProvider>
    </I18nProvider>
  );
}

describe("recurring failure state band", () => {
  it.each(["active", "paused"] as const)("shows the latest failure while %s", (status) => {
    expect(renderDetail(status)).toContain(`Last run: ${FAILURE}`);
  });

  it.each(["active", "canceled"] as const)("does not show a stale failure while %s", (status) => {
    expect(renderDetail(status, status === "active")).not.toContain("Last run:");
  });
});
