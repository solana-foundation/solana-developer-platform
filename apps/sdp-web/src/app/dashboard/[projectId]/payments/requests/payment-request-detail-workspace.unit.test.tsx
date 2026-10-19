// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import { PaymentRequestDetailWorkspace } from "./payment-request-detail-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ sdpEnvironment: "sandbox" }),
}));

const paymentRequest: PaymentRequest = {
  id: "preq_1",
  organizationId: "org_1",
  projectId: "prj_1",
  counterpartyId: null,
  walletId: "wallet_1",
  destinationAddress: "11111111111111111111111111111111",
  token: SOL_MINT,
  amount: "5",
  reference: "ref_1",
  status: "awaiting_payment",
  expiresAt: null,
  fulfilledByTransferId: null,
  canceledBy: null,
  lifecycle: [{ status: "awaiting_payment", at: "2026-09-14T00:00:00.000Z" }],
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

function renderDetail(demo: boolean, publicToken: string | null = "tok_1") {
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PaymentsDemoProvider value={demo}>{children}</PaymentsDemoProvider>
      </I18nProvider>
    );
  }
  return render(
    <PaymentRequestDetailWorkspace
      request={paymentRequest}
      publicToken={publicToken}
      contactName={null}
      walletName={null}
    />,
    { wrapper }
  );
}

afterEach(() => {
  cleanup();
});

describe("PaymentRequestDetailWorkspace payment link", () => {
  // The token is a bearer credential (APE-849): a member who may not manage
  // payment requests gets none, and no link is drawn.
  it("shows no link or QR code without the link token", async () => {
    renderDetail(false, null);

    await waitFor(() => expect(screen.queryByText(/\/pay\//)).toBeNull());
    expect(screen.queryByRole("img", { name: "QR code for the payment link" })).toBeNull();
  });

  it("shows the pay link and its QR code", async () => {
    renderDetail(false);

    expect(await screen.findByText(`${window.location.origin}/pay/tok_1`)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "QR code for the payment link" })).toBeTruthy();
  });

  it("shows no QR code or link for a demo request, only why there is none", async () => {
    renderDetail(true);

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
