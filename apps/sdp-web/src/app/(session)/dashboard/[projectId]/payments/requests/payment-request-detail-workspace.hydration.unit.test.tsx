// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PaymentRequestDetailWorkspace } from "./payment-request-detail-workspace";
import * as requestsData from "./payment-requests-page.data";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardAccess: resolveDashboardAccess("admin"),
  }),
}));

// 10:14 PM in UTC, the server's zone, and 4:14 PM in Chicago, the viewer's.
const request: PaymentRequest = {
  id: "preq_1",
  organizationId: "org_1",
  projectId: "prj_1",
  walletId: "wallet_1",
  destinationAddress: "11111111111111111111111111111111",
  token: SOL_MINT,
  amount: "5",
  reference: "ref_1",
  status: "awaiting_payment",
  expiresAt: "2026-11-05T22:14:00.000Z",
  fulfilledByTransferId: null,
  paidLate: false,
  canceledByApiKeyId: null,
  canceledByUserId: null,
  canceledAt: null,
  lifecycle: [{ status: "awaiting_payment", at: "2026-11-04T22:14:00.000Z" }],
  createdBy: null,
  createdAt: "2026-11-04T22:14:00.000Z",
  updatedAt: "2026-11-04T22:14:00.000Z",
};

let root: Root | null = null;

function page() {
  return (
    <SWRConfig value={{ ...DASHBOARD_SWR_CONFIG, provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PaymentsDemoProvider value={false}>
          <PaymentRequestDetailWorkspace request={request} publicToken={null} walletName={null} />
        </PaymentsDemoProvider>
      </I18nProvider>
    </SWRConfig>
  );
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetDashboardNavigation();
});

describe("PaymentRequestDetailWorkspace on a full page load", () => {
  it("hydrates the server's dates without a mismatch, then shows them in the viewer's zone", async () => {
    vi.spyOn(requestsData, "fetchPaymentRequestFromBrowser").mockResolvedValue(request);
    vi.stubEnv("TZ", "UTC");
    const html = renderToString(page());

    vi.stubEnv("TZ", "America/Chicago");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, page(), {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toMatch(/Nov 4, 2026, 4:14\sPM/);
    expect(container.textContent).toMatch(/Nov 5, 2026, 4:14\sPM/);
    expect(container.textContent).not.toMatch(/10:14\sPM/);
  });
});
