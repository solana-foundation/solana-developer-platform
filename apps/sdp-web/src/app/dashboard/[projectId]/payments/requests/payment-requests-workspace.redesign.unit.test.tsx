// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PaymentRequestsWorkspace } from "./payment-requests-workspace.redesign";

// jsdom implements no matchMedia, while the workspace's motion components read
// it through useReducedMotion.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

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

const paymentRequest = {
  id: "preq_1",
  counterpartyId: null,
  destinationAddress: "11111111111111111111111111111111",
  token: "So11111111111111111111111111111111111111112",
  amount: "5",
  reference: "ref_1",
  status: "awaiting_payment",
  createdAt: "2026-09-14T00:00:00.000Z",
} as PaymentRequest;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      {children}
    </I18nProvider>
  );
}

function renderWorkspace(props: Partial<ComponentProps<typeof PaymentRequestsWorkspace>> = {}) {
  return render(
    <PaymentRequestsWorkspace
      initialPaymentRequests={[paymentRequest]}
      counterparties={[]}
      total={1}
      totalIsExact
      hasNextPage={false}
      listState={{ page: 1, pageSize: 25, status: null, search: null }}
      {...props}
    />,
    { wrapper }
  );
}

afterEach(() => {
  cleanup();
  resetDashboardNavigation();
  window.history.replaceState(null, "", "/");
});

const otherRequest = {
  ...paymentRequest,
  id: "preq_2",
  counterpartyId: "cp_jane",
  amount: "80",
  reference: "ref_2",
} as PaymentRequest;

describe("PaymentRequestsWorkspace search", () => {
  it("puts a search in the URL on Enter, from the first page", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/prj_test_sandbox/payments/requests?page=3&status=paid"
    );
    renderWorkspace({ listState: { page: 3, pageSize: 25, status: "paid", search: null } });

    await userEvent.type(screen.getByRole("searchbox"), " jane {Enter}");

    expect(dashboardRouter.replace).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/requests?status=paid&search=jane",
      { scroll: false }
    );
  });

  it("does not reload for a search the list already shows", async () => {
    renderWorkspace({ listState: { page: 1, pageSize: 25, status: null, search: "jane" } });

    await userEvent.type(screen.getByRole("searchbox"), "{Enter}");

    expect(dashboardRouter.replace).not.toHaveBeenCalled();
  });

  it("shows the page's rows that match the search, by payer, with no pager on one page", () => {
    renderWorkspace({
      initialPaymentRequests: [paymentRequest, otherRequest],
      counterparties: [{ id: "cp_jane", displayName: "Jane Doe" } as never],
      total: 2,
      listState: { page: 1, pageSize: 25, status: null, search: "jane" },
    });

    expect(screen.getByText("Jane Doe")).toBeTruthy();
    expect(screen.queryByText("anyone")).toBeNull();
    expect(screen.queryByText("Page 1")).toBeNull();
    expect(screen.queryByText(/of 2 requests/)).toBeNull();
  });

  it("shows no matches, not the empty directory, when a search finds nothing", () => {
    renderWorkspace({
      initialPaymentRequests: [paymentRequest],
      total: 1,
      listState: { page: 1, pageSize: 25, status: null, search: "nobody" },
    });

    expect(screen.getByText("No requests match these filters.")).toBeTruthy();
    expect(screen.getByRole("searchbox")).toHaveProperty("value", "nobody");
  });
});

describe("PaymentRequestsWorkspace pager", () => {
  it("shows which rows of how many when the total is exact", () => {
    renderWorkspace({ total: 40, hasNextPage: true });

    expect(screen.getByText("1-25 of 40 requests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", false);
  });

  it("names the page alone when the total is not exact, and offers the next while there is one", () => {
    renderWorkspace({
      total: 40,
      totalIsExact: false,
      hasNextPage: true,
      listState: { page: 2, pageSize: 25, status: "awaiting_payment", search: null },
    });

    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.queryByText(/of 40 requests/)).toBeNull();
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", false);
    cleanup();

    renderWorkspace({
      total: 40,
      totalIsExact: false,
      hasNextPage: false,
      listState: { page: 2, pageSize: 25, status: "awaiting_payment", search: null },
    });
    expect(screen.getByRole("button", { name: "Next page" })).toHaveProperty("disabled", true);
  });
});

// APE-849 moved the pay link behind a read on Copy; Safari only lets a
// clipboard write start inside the click, so the write must not wait for it.
describe("PaymentRequestsWorkspace copy link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts the clipboard write in the click, with the link read as its contents", async () => {
    let answerLink: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            answerLink = resolve;
          })
      )
    );
    const copied = vi.spyOn(toast, "success");
    const written: Promise<Blob>[] = [];
    class StubClipboardItem {
      constructor(readonly items: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal("ClipboardItem", StubClipboardItem);
    const write = vi.fn(async (items: StubClipboardItem[]) => {
      const [item] = items;
      if (!item) throw new Error("nothing to write");
      const text = item.items["text/plain"];
      if (!text) throw new Error("no text/plain");
      written.push(text);
      await text;
    });
    renderWorkspace();
    // user-event installs its own clipboard on setup; this one goes in after it.
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });

    const [copy] = screen.getAllByRole("button", { name: "Copy link" });
    if (!copy) throw new Error("no Copy link button");
    await user.click(copy);

    // Called before the link read has answered.
    expect(write).toHaveBeenCalledTimes(1);
    answerLink(Response.json({ data: { id: "preq_1", publicToken: "tok_1" } }));
    const [pending] = written;
    if (!pending) throw new Error("no clipboard contents");
    await expect((await pending).text()).resolves.toBe(`${window.location.origin}/pay/tok_1`);
    await waitFor(() => expect(copied).toHaveBeenCalledWith("Payment link copied"));
  });
});
