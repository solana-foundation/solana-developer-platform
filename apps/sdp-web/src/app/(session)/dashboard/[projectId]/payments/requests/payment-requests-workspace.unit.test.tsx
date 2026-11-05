// @vitest-environment jsdom

import type { PaymentRequest, PaymentsDashboardWallet } from "@sdp/types/payments";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubClipboard } from "@/test/clipboard";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import { PaymentRequestCreateWorkspace } from "./payment-request-create-workspace";
import type { PaymentRequestsListState } from "./payment-requests-page.data";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardAccess: { capabilities: { canWrite: true } },
  }),
  useOptionalDashboardWorkspace: () => null,
}));

const paymentRequest: PaymentRequest = {
  id: "preq_1",
  organizationId: "org_test",
  projectId: "prj_test_sandbox",
  walletId: "wallet_treasury",
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
const otherRequest: PaymentRequest = { ...paymentRequest, id: "preq_2", amount: "80" };
const wallet: PaymentsDashboardWallet = {
  id: "cwlt_treasury",
  walletId: "wallet_treasury",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  custodyConfigId: "ccfg_test",
  isRuntimeExecutionAllowed: true,
};
const firstPage: PaymentRequestsListState = { page: 1, pageSize: 25, status: null, search: null };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <EnglishI18n>
      <DashboardReadsProvider>{children}</DashboardReadsProvider>
    </EnglishI18n>
  );
}

function listBody(rows: readonly PaymentRequest[], total: number, list: PaymentRequestsListState) {
  return Response.json({
    data: { paymentRequests: rows, total, page: list.page, pageSize: list.pageSize },
  });
}

function listLoading() {
  return document.querySelector('[data-loading-layout="payment-requests"]');
}

async function renderList(
  listState: PaymentRequestsListState,
  rows: readonly PaymentRequest[],
  total: number
) {
  const fetchMock = stubDashboardFetch(() => listBody(rows, total, listState));
  render(<PaymentRequestsWorkspace listState={listState} />, { wrapper });
  await waitFor(() => expect(listLoading()).toBeNull());
  return fetchMock;
}

function isListRead(request: { path: string }) {
  return request.path.startsWith("/api/dashboard/payments/requests?");
}

beforeEach(() => {
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
  window.history.replaceState(null, "", "/");
});

describe("PaymentRequestsWorkspace search", () => {
  it("puts a search in the URL on Enter, from the first page", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/prj_test_sandbox/payments/requests?page=3&status=paid"
    );
    await renderList({ page: 3, pageSize: 25, status: "paid", search: null }, [paymentRequest], 60);

    await userEvent.type(screen.getByRole("searchbox"), " jane {Enter}");

    expect(dashboardRouter.replace).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/requests?status=paid&search=jane",
      { scroll: false }
    );
  });

  it("does not reload for a search the list already shows", async () => {
    await renderList({ ...firstPage, search: "jane" }, [paymentRequest], 1);

    await userEvent.type(screen.getByRole("searchbox"), "{Enter}");

    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("shows the page's rows that match the search, with no pager on one page", async () => {
    await renderList({ ...firstPage, search: "80" }, [paymentRequest, otherRequest], 2);

    expect(screen.getByText("80.00 SOL")).toBeTruthy();
    expect(screen.queryByText("5.00 SOL")).toBeNull();
    expect(screen.queryByText("Page 1")).toBeNull();
    expect(screen.queryByText(/of 2 requests/)).toBeNull();
  });

  it("shows no matches, not the empty directory, when a search finds nothing", async () => {
    await renderList({ ...firstPage, search: "nobody" }, [paymentRequest], 1);

    expect(screen.getByText("No requests match these filters.")).toBeTruthy();
    expect(screen.getByRole("searchbox")).toHaveProperty("value", "nobody");
  });
});

describe("PaymentRequestsWorkspace pager", () => {
  it("shows which rows of how many when the total is exact", async () => {
    await renderList(firstPage, [paymentRequest], 40);

    expect(screen.getByText("1-25 of 40 requests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", false);
  });

  it("names the page alone when the total is not exact, and offers the next while there is one", async () => {
    const awaitingPage2: PaymentRequestsListState = {
      ...firstPage,
      page: 2,
      status: "awaiting_payment",
    };
    await renderList(awaitingPage2, [paymentRequest], 60);

    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.queryByText(/of 60 requests/)).toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", false);
    cleanup();

    await renderList(awaitingPage2, [paymentRequest], 40);
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
  });

  it("sends a page past the end to the last page there is", async () => {
    await renderList({ ...firstPage, page: 5 }, [], 30);

    await waitFor(() =>
      expect(dashboardRouter.replace).toHaveBeenCalledWith(
        "/dashboard/prj_test_sandbox/payments/requests?page=2"
      )
    );
  });

  it("says the list did not load and reads it again on Retry", async () => {
    let failing = true;
    stubDashboardFetch(() =>
      failing
        ? Response.json({ error: { message: "unavailable" } }, { status: 503 })
        : listBody([paymentRequest], 1, firstPage)
    );
    render(<PaymentRequestsWorkspace listState={firstPage} />, { wrapper });

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("Unable to load payment requests")).toBeTruthy();
    failing = false;
    await userEvent.click(retry);

    expect(await screen.findByText("5.00 SOL")).toBeTruthy();
  });
});

describe("PaymentRequestsWorkspace after a create", () => {
  async function createRequest(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByRole("textbox", { name: "Amount" }), "25");
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    const create = screen.getByRole("button", { name: "Create and copy link" });
    await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
    await user.click(create);
  }

  function serveRequests(listed: PaymentRequest[], listAnswer: () => Promise<Response>) {
    return stubDashboardFetch((request) => {
      if (request.path.startsWith("/api/dashboard/wallets")) {
        return Response.json({ data: { wallets: [wallet] } });
      }
      if (isListRead(request)) return listAnswer();
      listed.push(otherRequest);
      return Response.json(
        { data: { id: otherRequest.id, publicToken: "tok_2" } },
        { status: 201 }
      );
    });
  }

  it("reads the list on screen again in place, keeping its rows until the answer lands", async () => {
    const listed = [paymentRequest];
    const pending = Promise.withResolvers<Response>();
    let reads = 0;
    const fetchMock = serveRequests(listed, async () => {
      reads += 1;
      return reads === 1 ? listBody([...listed], listed.length, firstPage) : pending.promise;
    });
    const user = userEvent.setup();
    stubClipboard("writes");
    render(
      <>
        <PaymentRequestsWorkspace listState={firstPage} />
        <PaymentRequestCreateWorkspace />
      </>,
      { wrapper }
    );
    expect(await screen.findByText("5.00 SOL")).toBeTruthy();

    await createRequest(user);

    await waitFor(() => expect(sentDashboardReads(fetchMock).filter(isListRead)).toHaveLength(2));
    expect(listLoading()).toBeNull();
    expect(screen.getByText("5.00 SOL")).toBeTruthy();
    pending.resolve(listBody([...listed], listed.length, firstPage));
    expect(await screen.findByText("80.00 SOL")).toBeTruthy();
  });

  it("clears a list not on screen, so the next visit loads it again", async () => {
    const listed = [paymentRequest];
    const fetchMock = serveRequests(listed, async () =>
      listBody([...listed], listed.length, firstPage)
    );
    const user = userEvent.setup();
    stubClipboard("writes");
    const view = render(<PaymentRequestsWorkspace listState={firstPage} />, { wrapper });
    expect(await screen.findByText("5.00 SOL")).toBeTruthy();
    view.rerender(<PaymentRequestCreateWorkspace />);

    await createRequest(user);
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    expect(sentDashboardReads(fetchMock).filter(isListRead)).toHaveLength(1);
    view.rerender(<PaymentRequestsWorkspace listState={firstPage} />);

    expect(listLoading()).not.toBeNull();
    expect(await screen.findByText("80.00 SOL")).toBeTruthy();
    expect(sentDashboardReads(fetchMock).filter(isListRead)).toHaveLength(2);
  });
});

describe("PaymentRequestsWorkspace copy link", () => {
  it("starts the clipboard write in the click, with the link read as its contents", async () => {
    const link = Promise.withResolvers<Response>();
    stubDashboardFetch((request) =>
      isListRead(request) ? listBody([paymentRequest], 1, firstPage) : link.promise
    );
    const copied = vi.spyOn(toast, "success");
    render(<PaymentRequestsWorkspace listState={firstPage} />, { wrapper });
    const user = userEvent.setup();
    const clipboard = stubClipboard("writes");

    const [copy] = await screen.findAllByRole("button", { name: "Copy link" });
    if (!copy) throw new Error("no Copy link button");
    await user.click(copy);

    expect(clipboard.writes).toHaveLength(1);
    link.resolve(Response.json({ data: { id: "preq_1", publicToken: "tok_1" } }));
    const [pending] = clipboard.writes;
    if (!pending) throw new Error("no clipboard contents");
    await expect((await pending).text()).resolves.toBe(`${window.location.origin}/pay/tok_1`);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("Payment link copied"));
  });
});
