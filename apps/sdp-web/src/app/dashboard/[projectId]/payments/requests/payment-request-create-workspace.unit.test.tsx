// @vitest-environment jsdom

import type { Counterparty, PaymentRequest, PaymentsDashboardWallet } from "@sdp/types";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PaymentRequestCreateWorkspace } from "./payment-request-create-workspace";
import { deriveTokenOptions } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace as LegacyPaymentRequestsWorkspace } from "./payment-requests-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { orgId: "org_test", userId: "user_test" },
    selectedProjectId: "proj_test",
    sdpEnvironment: "sandbox",
    flags: {},
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const wallet: PaymentsDashboardWallet = {
  id: "cwlt_treasury",
  walletId: "wallet_treasury",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  isRuntimeExecutionAllowed: true,
};

const contact: Counterparty = {
  id: "cpty_jane",
  organizationId: "org_test",
  projectId: "proj_test",
  externalId: null,
  displayName: "Jane Smith",
  entityType: "individual",
  status: "active",
  createdBy: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

function readsAs(): string {
  return screen.getByText("Reads as").nextElementSibling?.textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
});

describe("New request page", () => {
  it("says there is nowhere to be paid into when the project has no wallet", () => {
    render(<PaymentRequestCreateWorkspace wallets={[]} walletsError={null} counterparties={[]} />, {
      wrapper,
    });

    expect(screen.getByText("There is no wallet to be paid into")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Wallets" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/wallets"
    );
    expect(screen.queryByRole("button", { name: "Create and copy link" })).toBeNull();
  });

  it("creates the request, copies its link and opens it in the list", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { id: "preq_1", publicToken: "tok_1" } });
    });
    render(
      <PaymentRequestCreateWorkspace
        wallets={[wallet]}
        walletsError={null}
        counterparties={[contact]}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    const create = () => screen.getByRole("button", { name: "Create and copy link" });

    expect(create().hasAttribute("disabled")).toBe(true);
    expect(readsAs()).toBe("Anyone with the link can pay an amount into a wallet.");
    expect(screen.getByText("The link stays live until it is paid.")).toBeTruthy();

    await user.type(screen.getByRole("textbox", { name: "Amount" }), "25");
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));

    expect(readsAs()).toBe("Anyone with the link can pay 25.00 USDC into Treasury.");
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    await user.click(create());

    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    const usdc = deriveTokenOptions("devnet").find((token) => token.symbol === "USDC");
    expect(writes).toEqual([
      {
        custodyWalletId: "cwlt_treasury",
        token: usdc?.mintAddress,
        amount: "25",
        counterpartyId: null,
        expiresAt: null,
      },
    ]);
    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/pay/tok_1`);
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/requests/preq_1"
    );
    // On its way to the request, the form stays busy so a second press makes no second link.
    const creating = screen.getByRole("button", { name: "Creating…" });
    expect(creating.hasAttribute("disabled")).toBe(true);
  });

  it("keeps wallets sharing a provider reference and address as separate recipients", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { id: "preq_alias", publicToken: "tok_alias" } });
    });
    render(
      <PaymentRequestCreateWorkspace
        wallets={[wallet, { ...wallet, id: "cwlt_settlement", label: "Settlement" }]}
        walletsError={null}
        counterparties={[]}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "25");
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Settlement/ }));
    expect(readsAs()).toBe("Anyone with the link can pay 25.00 USDC into Settlement.");
    await user.click(screen.getByRole("button", { name: "Create and copy link" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ custodyWalletId: "cwlt_settlement" });
    expect(writes[0]).not.toHaveProperty("walletId");
  });

  it("frees the form when creating the link throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    render(
      <PaymentRequestCreateWorkspace
        wallets={[wallet]}
        walletsError={null}
        counterparties={[contact]}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    const create = () => screen.getByRole("button", { name: "Create and copy link" });

    await user.type(screen.getByRole("textbox", { name: "Amount" }), "25");
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    await user.click(create());

    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  it("keeps create off for an amount the API would refuse", async () => {
    render(
      <PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} counterparties={[]} />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "1e3");

    expect(screen.getByText("Enter an amount greater than zero.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create and copy link" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("names the contact in the sentence and says when they have no address on file", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: { accounts: [] } }));
    render(
      <PaymentRequestCreateWorkspace
        wallets={[wallet]}
        walletsError={null}
        counterparties={[contact]}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "From" }));
    await user.click(screen.getByRole("button", { name: "Jane Smith" }));

    expect(readsAs()).toBe("Jane Smith can pay an amount into a wallet.");
    expect(await screen.findByText(/Jane Smith has no Solana address on file\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add an address" })).toBeTruthy();
  });
});

describe("Previous design requests", () => {
  it("sends the exact selected recipient when provider references and addresses coincide", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ data: {} });
    });
    render(
      <LegacyPaymentRequestsWorkspace
        initialPaymentRequests={[]}
        apiBaseUrl={null}
        apiKeys={[]}
        wallets={[wallet, { ...wallet, id: "cwlt_settlement", label: "Settlement" }]}
        counterparties={[]}
      />,
      { wrapper }
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create" }));
    const form = within(screen.getByRole("dialog", { name: "Create payment request" }));
    await user.type(form.getByRole("spinbutton", { name: "Amount" }), "25");
    await user.click(form.getAllByRole("combobox")[0]);
    await user.click(screen.getByRole("option", { name: "SOL" }));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    await user.click(form.getAllByRole("combobox")[1]);
    await user.click(await screen.findByRole("option", { name: "Settlement" }));
    await user.click(form.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ custodyWalletId: "cwlt_settlement" });
    expect(writes[0]).not.toHaveProperty("walletId");
  });

  it.each([
    { custodyWalletId: "cwlt_treasury", expectedName: "Treasury" },
    { custodyWalletId: null, expectedName: null },
    { custodyWalletId: "cwlt_unavailable", expectedName: null },
  ])(
    "shows exact recipient $custodyWalletId without guessing an alias",
    async ({ custodyWalletId, expectedName }) => {
      const request: PaymentRequest = {
        id: "preq_legacy",
        publicToken: "tok_legacy",
        organizationId: "org_test",
        projectId: "proj_test",
        counterpartyId: null,
        custodyWalletId,
        walletId: wallet.walletId,
        destinationAddress: wallet.publicKey,
        token: "So11111111111111111111111111111111111111112",
        amount: "5",
        reference: "reference",
        status: "awaiting_payment",
        expiresAt: null,
        fulfilledByTransferId: null,
        canceledBy: null,
        lifecycle: [],
        createdBy: null,
        createdAt: "2026-10-12T00:00:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
      };
      render(
        <LegacyPaymentRequestsWorkspace
          initialPaymentRequests={[request]}
          apiBaseUrl={null}
          apiKeys={[]}
          wallets={[wallet, { ...wallet, id: "cwlt_settlement", label: "Settlement" }]}
          counterparties={[]}
        />,
        { wrapper }
      );
      await userEvent.click(screen.getAllByRole("button", { name: /5.00 SOL/ })[0]);
      const detail = within(screen.getByRole("dialog", { name: "Payment request details" }));
      expect(detail.getByText(wallet.publicKey)).toBeTruthy();
      expect(detail.queryByText("Settlement")).toBeNull();
      expect(Boolean(detail.queryByText("Treasury"))).toBe(expectedName !== null);
    }
  );
});
