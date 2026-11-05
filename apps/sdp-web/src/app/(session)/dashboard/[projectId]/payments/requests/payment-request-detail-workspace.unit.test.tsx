// @vitest-environment jsdom

import type { PaymentRequest } from "@sdp/types/payments";
import type { OrganizationRole } from "@sdp/types/roles";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import {
  type SentDashboardRequest,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import { SANDBOX_PROJECT } from "@/test/projects";
import { forgetCreatedRequestLink, noteCreatedRequestLink } from "./created-request-link";
import { PaymentRequestDetailWorkspace } from "./payment-request-detail-workspace";

const workspace = vi.hoisted((): { role: OrganizationRole } => ({ role: "admin" }));

Element.prototype.scrollIntoView = () => {};

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    sdpEnvironment: "sandbox",
    dashboardAccess: resolveDashboardAccess(workspace.role),
  }),
}));

const DETAIL_PATH = "/api/dashboard/payments/requests/preq_1";

const paymentRequest: PaymentRequest = {
  id: "preq_1",
  organizationId: "org_1",
  projectId: SANDBOX_PROJECT.id,
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

const served: { request: PaymentRequest; publicToken: string | null } = {
  request: paymentRequest,
  publicToken: "tok_1",
};

type Answer = (request: SentDashboardRequest) => Response | Promise<Response>;

function refused(status: number): Response {
  return Response.json({ error: { message: "refused" } }, { status });
}

/** The request and its link as {@link served} holds them, and a Project with no wallets. */
const detailReads: Answer = ({ path, method }) => {
  if (path === DETAIL_PATH) return Response.json({ data: served.request });
  if (path === `${DETAIL_PATH}/link`) {
    return served.publicToken === null
      ? refused(403)
      : Response.json({ data: { id: "preq_1", publicToken: served.publicToken } });
  }
  if (path.startsWith("/api/dashboard/wallets")) return Response.json({ data: { wallets: [] } });
  throw new Error(`unexpected ${method} ${path}`);
};

function renderDetail(demo: boolean, answer: Answer) {
  const fetchMock = stubDashboardFetch(answer);
  render(
    <EnglishI18n>
      <DashboardReadsProvider>
        <PaymentsDemoProvider value={demo}>
          <PaymentRequestDetailWorkspace requestId="preq_1" />
        </PaymentsDemoProvider>
      </DashboardReadsProvider>
    </EnglishI18n>
  );
  return fetchMock;
}

async function renderRecord(demo: boolean, request: PaymentRequest) {
  served.request = request;
  const fetchMock = renderDetail(demo, detailReads);
  await screen.findByText("Anyone with the link");
  return fetchMock;
}

function detailReadCount(fetchMock: ReturnType<typeof stubDashboardFetch>): number {
  return sentDashboardReads(fetchMock).filter((read) => read.path === DETAIL_PATH).length;
}

beforeEach(() => {
  served.request = paymentRequest;
  served.publicToken = "tok_1";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
  workspace.role = "admin";
});

describe("PaymentRequestDetailWorkspace read", () => {
  it("shows the Project's not-found page for a request the API does not hold", async () => {
    renderDetail(false, (request) =>
      request.path === DETAIL_PATH ? refused(404) : detailReads(request)
    );

    expect(await screen.findByRole("link", { name: "Back to Overview" })).toBeTruthy();
  });

  it("says a failed read could not load, and drops the new-request note so a retry says nothing late", async () => {
    noteCreatedRequestLink("preq_1", true);
    renderDetail(false, (request) =>
      request.path === DETAIL_PATH ? refused(503) : detailReads(request)
    );
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();

    await renderRecord(false, paymentRequest);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });
});

describe("PaymentRequestDetailWorkspace payment watch", () => {
  it("shows a payment land on an open request without a reload, then reads it no more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = await renderRecord(false, paymentRequest);
    expect(screen.getAllByText("Awaiting payment").length).toBeGreaterThan(0);

    served.request = {
      ...paymentRequest,
      status: "paid",
      fulfilledByTransferId: "xfr_1",
      updatedAt: "2026-09-14T00:05:00.000Z",
    };
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(screen.getAllByText("Paid").length).toBeGreaterThan(0));
    const reads = detailReadCount(fetchMock);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(detailReadCount(fetchMock)).toBe(reads);
  });

  it("never reads a demo request again, which is a fixture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = await renderRecord(true, paymentRequest);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentDashboardReads(fetchMock).filter((read) => read.path === DETAIL_PATH)).toEqual([
      { path: DETAIL_PATH, projectId: SANDBOX_PROJECT.id, demo: "1" },
    ]);
  });
});

describe("PaymentRequestDetailWorkspace payment link", () => {
  it("shows no link or QR code when the link read is refused", async () => {
    served.publicToken = null;
    await renderRecord(false, paymentRequest);

    expect(screen.queryByText(/\/pay\//)).toBeNull();
    expect(screen.queryByRole("img", { name: "QR code for the payment link" })).toBeNull();
  });

  it.each([
    { status: 403, retried: false },
    { status: 503, retried: true },
  ])(
    "asks for the link again after a $status only when it may answer differently: $retried",
    async ({ status, retried }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const fetchMock = renderDetail(false, (request) =>
        request.path === `${DETAIL_PATH}/link` ? refused(status) : detailReads(request)
      );
      await screen.findByText("Anyone with the link");

      await vi.advanceTimersByTimeAsync(20_000);
      const linkReads = sentDashboardReads(fetchMock).filter(
        (read) => read.path === `${DETAIL_PATH}/link`
      );
      expect(linkReads.length > 1).toBe(retried);
    }
  );

  it("shows the pay link and its QR code", async () => {
    await renderRecord(false, paymentRequest);

    expect(screen.getByText(`${window.location.origin}/pay/tok_1`)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "QR code for the payment link" })).toBeTruthy();
  });

  it("shows no QR code or link for a demo request, only why there is none", async () => {
    await renderRecord(true, paymentRequest);

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

  it("reads Copied for 1.4s once Copy link copies, and raises no toast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const success = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    await renderRecord(false, paymentRequest);

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/pay/tok_1`);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.getByText("Copied", { selector: "span[aria-live]" })).toBeTruthy();
    expect(success).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_400);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy());
  });
});

describe("PaymentRequestDetailWorkspace opened by the new-request page", () => {
  const notCopiedLine = "Could not copy the payment link.";
  const copyButton = (name: "Copy link" | "Copied") => screen.queryByRole("button", { name });

  beforeEach(() => forgetCreatedRequestLink());

  it("reads Copied on Copy link for 1.4s when the link was copied", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    noteCreatedRequestLink("preq_1", true);
    await renderRecord(false, paymentRequest);

    expect(copyButton("Copied")).toBeTruthy();
    expect(screen.queryByText(notCopiedLine)).toBeNull();
    await vi.advanceTimersByTimeAsync(1_400);
    await waitFor(() => expect(copyButton("Copy link")).toBeTruthy());
  });

  it("says plainly when the link was not copied, under the buttons", async () => {
    noteCreatedRequestLink("preq_1", false);
    await renderRecord(false, paymentRequest);

    const line = screen.getByText(notCopiedLine);
    const copy = copyButton("Copy link");
    if (!copy) throw new Error("no Copy link button");
    expect(copy.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("clears the failed-copy line once Copy link copies the link", async () => {
    noteCreatedRequestLink("preq_1", false);
    const user = userEvent.setup();
    await renderRecord(false, paymentRequest);
    expect(screen.getByText(notCopiedLine)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(screen.queryByText(notCopiedLine)).toBeNull());
    expect(copyButton("Copied")).toBeTruthy();
  });

  it("says it on that request's first arrival only", async () => {
    noteCreatedRequestLink("preq_2", true);
    await renderRecord(false, paymentRequest);
    expect(copyButton("Copied")).toBeNull();
    cleanup();

    noteCreatedRequestLink("preq_1", true);
    await renderRecord(false, paymentRequest);
    expect(copyButton("Copied")).toBeTruthy();
    cleanup();

    await renderRecord(false, paymentRequest);
    expect(copyButton("Copy link")).toBeTruthy();
  });

  it("takes the failed-copy line away once the watch sees the request closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    noteCreatedRequestLink("preq_1", false);
    await renderRecord(false, paymentRequest);
    expect(screen.getByText(notCopiedLine)).toBeTruthy();

    served.request = { ...paymentRequest, status: "canceled" };
    await vi.advanceTimersByTimeAsync(10_000);

    await waitFor(() => expect(screen.queryByText(notCopiedLine)).toBeNull());
  });

  it("marks the link it arrived with, and no link on a later visit", async () => {
    stubMatchMedia();
    const animate = vi.fn<HTMLElement["animate"]>();
    Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
    try {
      noteCreatedRequestLink("preq_1", true);
      await renderRecord(false, paymentRequest);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.contexts[0]).toBe(
        screen.getByText(`${window.location.origin}/pay/tok_1`)
      );
      cleanup();

      await renderRecord(false, paymentRequest);
      expect(animate).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });
});

describe("PaymentRequestDetailWorkspace dead link", () => {
  it.each<{ status: PaymentRequest["status"]; expiresAt: string | null }>([
    { status: "paid", expiresAt: null },
    { status: "canceled", expiresAt: null },
    { status: "expired", expiresAt: null },
    { status: "awaiting_payment", expiresAt: "2020-01-01T00:00:00.000Z" },
  ])(
    "shows no link, QR code, copy or share for a $status request expiring $expiresAt",
    async ({ status, expiresAt }) => {
      await renderRecord(false, { ...paymentRequest, status, expiresAt });

      expect(screen.queryByText(/\/pay\//)).toBeNull();
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
  const membersPage = (id: string, name: string) =>
    Response.json({
      data: {
        members: [{ user: { id, email: `${id}@example.com`, name } }],
        meta: { hasMore: false },
      },
    });

  function cancelerReads(answer: Answer): Answer {
    return (request) =>
      request.path.startsWith("/api/dashboard/members?") ||
      request.path === "/api/dashboard/api-keys/key_1"
        ? answer(request)
        : detailReads(request);
  }

  async function renderCanceled(request: PaymentRequest, answer: Answer) {
    served.request = request;
    renderDetail(false, cancelerReads(answer));
    await screen.findByText("Anyone with the link");
  }

  it("names the member who canceled it, with when", async () => {
    await renderCanceled(byMember, () => membersPage("usr_1", "Ada Lovelace"));

    expect(
      await screen.findByText(/^Ada Lovelace canceled it on .+2026.*, before anyone paid\./)
    ).toBeTruthy();
  });

  it("names the API key that canceled it", async () => {
    await renderCanceled(byKey, () =>
      Response.json({
        data: {
          id: "key_1",
          name: "Checkout bot",
          environment: "sandbox",
          grants: [],
          expiresAt: null,
          walletScope: "all",
          walletIds: [],
          allowedIps: null,
        },
      })
    );

    expect(
      await screen.findByText(/^The API key “Checkout bot” canceled it on .+, before anyone paid\./)
    ).toBeTruthy();
  });

  it("says a member or an API key, and nothing else changes, when the name read fails", async () => {
    await renderCanceled(byMember, () => refused(503));
    expect(await screen.findByText(/^A member canceled it on /)).toBeTruthy();
    cleanup();

    await renderCanceled(byKey, () => refused(404));
    expect(await screen.findByText(/^An API key canceled it on /)).toBeTruthy();
  });

  it("never names a member read for someone else", async () => {
    await renderCanceled(byMember, () => membersPage("usr_2", "Grace Hopper"));

    expect(await screen.findByText(/^A member canceled it on /)).toBeTruthy();
    expect(screen.queryByText(/Grace Hopper/)).toBeNull();
  });

  it("names who canceled it once the watch sees someone else cancel it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderCanceled(paymentRequest, () => membersPage("usr_1", "Ada Lovelace"));

    served.request = byMember;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await screen.findByText(/^Ada Lovelace canceled it on /)).toBeTruthy();
  });

  it("keeps the plain words for a cancel that names nobody", async () => {
    await renderRecord(false, { ...paymentRequest, status: "canceled" });

    expect(
      screen.getByText("Canceled before anyone paid it. The link is dead and cannot be reopened.")
    ).toBeTruthy();
  });
});

describe("PaymentRequestDetailWorkspace facts", () => {
  it("reads who pays and where it lands, then its reference, expiry and creation", async () => {
    await renderRecord(false, paymentRequest);

    expect(
      [...document.querySelectorAll("[data-record-fact] dt")].map((label) => label.textContent)
    ).toEqual(["From", "To", "Reference", "Expires", "Created"]);
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
    async ({ role, status, expiresAt, shown }) => {
      workspace.role = role;
      await renderRecord(false, { ...paymentRequest, status, expiresAt });

      expect(screen.queryByRole("button", { name: "Cancel request…" }) !== null).toBe(shown);
      expect(screen.queryByRole("heading", { name: "Danger zone" }) !== null).toBe(shown);
    }
  );

  it("cancels on confirm, holds every control while it runs, then reads the request again in place", async () => {
    const canceled = Promise.withResolvers<Response>();
    const fetchMock = renderDetail(false, (request) =>
      request.path === `${DETAIL_PATH}/cancel` ? canceled.promise : detailReads(request)
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Cancel request…" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Cancel request" }));
    expect(dialog.getByText("This link will stop accepting payments.")).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Cancel request" }));

    expect(dialog.getByRole("button", { name: "Close modal" })).toHaveProperty("disabled", true);
    expect(dialog.getByRole("button", { name: "Keep it" })).toHaveProperty("disabled", true);
    expect(dialog.getByRole("button", { name: /^Cancel request/ }).getAttribute("aria-busy")).toBe(
      "true"
    );
    expect(detailReadCount(fetchMock)).toBe(1);

    served.request = { ...paymentRequest, status: "canceled" };
    canceled.resolve(Response.json({ data: served.request }));
    await waitFor(() => expect(detailReadCount(fetchMock)).toBe(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByText(
        "Canceled before anyone paid it. The link is dead and cannot be reopened."
      )
    ).toBeTruthy();
  });
});
