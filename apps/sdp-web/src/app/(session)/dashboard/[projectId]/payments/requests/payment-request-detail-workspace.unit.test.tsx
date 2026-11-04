// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import type { OrganizationRole } from "@sdp/types/roles";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { DASHBOARD_SWR_CONFIG } from "@/lib/dashboard-swr-config";
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

function renderDetail(
  demo: boolean,
  publicToken: string | null,
  request: PaymentRequest,
  canceler: requestsData.PaymentRequestCanceler | null = null
) {
  function wrapper({ children }: { children: ReactNode }) {
    return (
      // The dashboard's own SWR defaults, which keep a key's last read once it goes null.
      <SWRConfig value={{ ...DASHBOARD_SWR_CONFIG, provider: () => new Map() }}>
        <I18nProvider locale="en" messages={getMessages("en")}>
          <PaymentsDemoProvider value={demo}>{children}</PaymentsDemoProvider>
        </I18nProvider>
      </SWRConfig>
    );
  }
  return render(
    <PaymentRequestDetailWorkspace
      request={request}
      publicToken={publicToken}
      walletName={null}
      canceler={canceler}
    />,
    { wrapper }
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetDashboardNavigation();
  workspace.role = "admin";
});

describe("PaymentRequestDetailWorkspace payment watch", () => {
  const paid: PaymentRequest = {
    ...paymentRequest,
    status: "paid",
    fulfilledByTransferId: "xfr_1",
    updatedAt: "2026-09-14T00:05:00.000Z",
  };

  it("shows a payment land on an open request without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.spyOn(requestsData, "fetchPaymentRequestFromBrowser").mockResolvedValue(paid);
    renderDetail(false, "tok_1", paymentRequest);

    expect(screen.getAllByText("Awaiting payment").length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10_000);

    await waitFor(() => expect(screen.getAllByText("Paid").length).toBeGreaterThan(0));
    expect(read).toHaveBeenCalledWith("preq_1");
  });

  it("shows a request the clock expired before anything wrote it, then stops reading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The API derives `expired` from the clock and leaves `updatedAt` as the last write set it.
    const expired: PaymentRequest = { ...paymentRequest, status: "expired" };
    const read = vi
      .spyOn(requestsData, "fetchPaymentRequestFromBrowser")
      .mockResolvedValue(expired);
    renderDetail(false, "tok_1", paymentRequest);

    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(screen.getAllByText("Expired").length).toBeGreaterThan(0));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it("shows a refresh's expired request over the open read before it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi
      .spyOn(requestsData, "fetchPaymentRequestFromBrowser")
      .mockResolvedValue(paymentRequest);
    const { rerender } = renderDetail(false, "tok_1", paymentRequest);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledOnce();

    // The refresh draws the request the clock expired; nothing wrote it, so `updatedAt` ties.
    rerender(
      <PaymentRequestDetailWorkspace
        request={{ ...paymentRequest, status: "expired" }}
        publicToken="tok_1"
        walletName={null}
      />
    );

    await waitFor(() => expect(screen.getAllByText("Expired").length).toBeGreaterThan(0));
  });

  it("reads a request that is no longer open no more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.spyOn(requestsData, "fetchPaymentRequestFromBrowser").mockResolvedValue(paid);
    renderDetail(false, "tok_1", paid);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).not.toHaveBeenCalled();
  });

  it("never reads a demo request, which is a fixture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.spyOn(requestsData, "fetchPaymentRequestFromBrowser").mockResolvedValue(paid);
    renderDetail(true, null, paymentRequest);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).not.toHaveBeenCalled();
  });
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

describe("PaymentRequestDetailWorkspace dead link", () => {
  // HOO-2616: a link the page calls dead is not handed out again.
  it.each<{ status: PaymentRequest["status"]; expiresAt: string | null }>([
    { status: "paid", expiresAt: null },
    { status: "canceled", expiresAt: null },
    { status: "expired", expiresAt: null },
    // The clock expired it before the API said so.
    { status: "awaiting_payment", expiresAt: "2020-01-01T00:00:00.000Z" },
  ])(
    "shows no link, QR code, copy or share for a $status request expiring $expiresAt",
    async ({ status, expiresAt }) => {
      renderDetail(false, "tok_1", { ...paymentRequest, status, expiresAt });

      await waitFor(() => expect(screen.queryByText(/\/pay\//)).toBeNull());
      expect(screen.queryByText("Payment link")).toBeNull();
      expect(screen.queryByRole("img", { name: "QR code for the payment link" })).toBeNull();
      for (const name of ["Copy link", "Share…", "Download QR code"]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
    }
  );
});

describe("PaymentRequestDetailWorkspace canceled by", () => {
  const canceledAt = "2026-09-15T10:30:00.000Z";
  const byMember: PaymentRequest = {
    ...paymentRequest,
    status: "canceled",
    canceledByUserId: "usr_1",
    canceledAt,
    updatedAt: canceledAt,
  };
  const byKey: PaymentRequest = {
    ...byMember,
    canceledByUserId: null,
    canceledByApiKeyId: "key_1",
  };

  it("names the member who canceled it, with when", () => {
    renderDetail(false, "tok_1", byMember, { kind: "member", id: "usr_1", name: "Ada Lovelace" });

    expect(
      screen.getByText(/^Ada Lovelace canceled it on .+2026.*, before anyone paid\./)
    ).toBeTruthy();
  });

  it("names the API key that canceled it", () => {
    renderDetail(false, "tok_1", byKey, { kind: "api_key", id: "key_1", name: "Checkout bot" });

    expect(
      screen.getByText(/^The API key “Checkout bot” canceled it on .+, before anyone paid\./)
    ).toBeTruthy();
  });

  it("says a member or an API key when the name could not be read", () => {
    renderDetail(false, "tok_1", byMember, { kind: "member", id: "usr_1", name: null });
    expect(screen.getByText(/^A member canceled it on /)).toBeTruthy();
    cleanup();

    renderDetail(false, "tok_1", byKey, null);
    expect(screen.getByText(/^An API key canceled it on /)).toBeTruthy();
  });

  it("never names a canceler read for someone else", () => {
    renderDetail(false, "tok_1", byMember, { kind: "member", id: "usr_2", name: "Grace Hopper" });

    expect(screen.queryByText(/Grace Hopper/)).toBeNull();
    expect(screen.getByText(/^A member canceled it on /)).toBeTruthy();
  });

  it("keeps the plain words for a cancel that names nobody", () => {
    renderDetail(false, "tok_1", { ...paymentRequest, status: "canceled" });

    expect(
      screen.getByText("Canceled before anyone paid it. The link is dead and cannot be reopened.")
    ).toBeTruthy();
  });
});

describe("PaymentRequestDetailWorkspace facts", () => {
  it("reads who pays and where it lands, then its reference, expiry and creation", () => {
    renderDetail(false, "tok_1", paymentRequest);

    expect(
      [...document.querySelectorAll("[data-record-fact] dt")].map((label) => label.textContent)
    ).toEqual(["From", "To", "Reference", "Expires", "Created"]);
    // A request names no payer: anyone holding the link can pay it.
    expect(screen.getByText("Anyone with the link")).toBeTruthy();
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

      expect(screen.queryByRole("button", { name: "Cancel request…" }) !== null).toBe(shown);
      expect(screen.queryByRole("heading", { name: "Danger zone" }) !== null).toBe(shown);
    }
  );

  it("cancels on confirm, holds every control while it runs, then reads the request again", async () => {
    const pending = Promise.withResolvers<{ ok: true } | { ok: false; error: string }>();
    const cancel = vi.spyOn(requestsData, "cancelPaymentRequest").mockReturnValue(pending.promise);
    const user = userEvent.setup();
    renderDetail(false, "tok_1", paymentRequest);

    expect(
      await screen.findByText("The link stops accepting payments. Cannot be undone.")
    ).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Cancel request…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Cancel request" }));
    expect(dialog.getByText("This link will stop accepting payments.")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Cancel request" }));

    expect(cancel).toHaveBeenCalledWith("preq_1");
    expect(dialog.getByRole("button", { name: "Close modal" })).toHaveProperty("disabled", true);
    expect(dialog.getByRole("button", { name: "Keep it" })).toHaveProperty("disabled", true);
    expect(dialog.getByRole("button", { name: /^Cancel request/ }).getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(dashboardRouter.refresh).not.toHaveBeenCalled();

    pending.resolve({ ok: true });
    await waitFor(() => expect(dashboardRouter.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
