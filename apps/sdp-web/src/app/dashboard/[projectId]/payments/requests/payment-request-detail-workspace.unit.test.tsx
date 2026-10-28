// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import type { OrganizationRole } from "@sdp/types/roles";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PaymentRequestDetailWorkspace } from "./payment-request-detail-workspace";
import * as requestsData from "./payment-requests-page.data";

const workspace = vi.hoisted((): { role: OrganizationRole } => ({ role: "admin" }));

Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardAccess: resolveDashboardAccess(workspace.role),
  }),
}));

const paymentRequest: PaymentRequest = {
  id: "preq_1",
  organizationId: "org_1",
  projectId: "prj_1",
  walletId: "wallet_1",
  destinationAddress: "11111111111111111111111111111111",
  token: SOL_MINT,
  amount: "5",
  reference: "ref_1",
  status: "awaiting_payment",
  expiresAt: null,
  fulfilledByTransferId: null,
  paidLate: false,
  canceledByApiKeyId: null,
  canceledByUserId: null,
  canceledAt: null,
  lifecycle: [{ status: "awaiting_payment", at: "2026-09-14T00:00:00.000Z" }],
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

function renderDetail(demo: boolean, publicToken: string | null, request: PaymentRequest) {
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PaymentsDemoProvider value={demo}>{children}</PaymentsDemoProvider>
      </I18nProvider>
    );
  }
  return render(
    <PaymentRequestDetailWorkspace request={request} publicToken={publicToken} walletName={null} />,
    { wrapper }
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDashboardNavigation();
  workspace.role = "admin";
});

describe("PaymentRequestDetailWorkspace payment link", () => {
  // The token is a bearer credential (APE-849): a member who may not manage
  // payment requests gets none, and no link is drawn.
  it("shows no link or QR code without the link token", async () => {
    renderDetail(false, null, paymentRequest);

    await waitFor(() => expect(screen.queryByText(/\/pay\//)).toBeNull());
    expect(screen.queryByRole("img", { name: "QR code for the payment link" })).toBeNull();
  });

  it("shows the pay link and its QR code", async () => {
    renderDetail(false, "tok_1", paymentRequest);

    expect(await screen.findByText(`${window.location.origin}/pay/tok_1`)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "QR code for the payment link" })).toBeTruthy();
  });

  it("shows no QR code or link for a demo request, only why there is none", async () => {
    renderDetail(true, "tok_1", paymentRequest);

    // The link is read after mount; once the actions enable, it would be drawn.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Copy link" })).toHaveProperty("disabled", false)
    );
    expect(
      screen.getByText(
        "Demo requests have no pay link to share. Turn off demo mode to create a real one."
      )
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "QR code for the payment link" })).toBeNull();
    expect(screen.queryByText(/\/pay\/tok_1/)).toBeNull();
  });
});

describe("PaymentRequestDetailWorkspace cancel", () => {
  it.each<{
    role: OrganizationRole;
    status: PaymentRequest["status"];
    expiresAt: string | null;
    shown: boolean;
  }>([
    { role: "member", status: "awaiting_payment", expiresAt: null, shown: true },
    { role: "viewer", status: "awaiting_payment", expiresAt: null, shown: false },
    { role: "admin", status: "expired", expiresAt: null, shown: false },
    {
      role: "admin",
      status: "awaiting_payment",
      expiresAt: "2020-01-01T00:00:00.000Z",
      shown: false,
    },
  ])(
    "offers Cancel request to $role on a $status request expiring $expiresAt: $shown",
    ({ role, status, expiresAt, shown }) => {
      workspace.role = role;
      renderDetail(false, "tok_1", { ...paymentRequest, status, expiresAt });

      expect(screen.queryByRole("button", { name: "Cancel request" }) !== null).toBe(shown);
    }
  );

  it("cancels on confirm, holds every control while it runs, then reads the request again", async () => {
    const pending = Promise.withResolvers<{ ok: true } | { ok: false; error: string }>();
    const cancel = vi.spyOn(requestsData, "cancelPaymentRequest").mockReturnValue(pending.promise);
    const user = userEvent.setup();
    renderDetail(false, "tok_1", paymentRequest);

    const open = await screen.findByRole("button", { name: "Cancel request" });
    await user.click(open);
    const panel = within(
      screen.getByRole("group", { name: "This link will stop accepting payments." })
    );
    await user.click(panel.getByRole("button", { name: "Cancel request" }));

    expect(cancel).toHaveBeenCalledWith("preq_1");
    expect(open).toHaveProperty("disabled", true);
    expect(panel.getByRole("button", { name: "Keep it" })).toHaveProperty("disabled", true);
    expect(panel.getByRole("button", { name: "Canceling" })).toHaveProperty("disabled", true);
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();

    pending.resolve({ ok: true });
    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1));
    expect(open).toHaveProperty("disabled", false);
  });
});
