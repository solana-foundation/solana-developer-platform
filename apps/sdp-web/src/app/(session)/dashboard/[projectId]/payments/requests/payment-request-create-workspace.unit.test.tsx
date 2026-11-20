// @vitest-environment jsdom

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { resetIdempotencyKeyStoresForTests } from "@/lib/idempotency-key-store";
import { stubClipboard } from "@/test/clipboard";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { TEST_PAYMENT_REQUEST_RECIPIENT } from "@/test/payment-requests";
import { requiredWellKnownMint } from "@/test/well-known-mints";
import { createdRequestLinkCopied, forgetCreatedRequestLink } from "./created-request-link";
import { PaymentRequestCreateWorkspace } from "./payment-request-create-workspace";

/** An ISO 8601 instant, as a frozen expiry is sent. */
const ISO_INSTANT = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** The fields these tests read from a sent create body; the rest is kept for equality checks. */
const sentCreateBodySchema = z.looseObject({
  amount: z.string(),
  expiresAt: z.string().nullable(),
});

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
  publicKey: TEST_PAYMENT_REQUEST_RECIPIENT,
  label: "Treasury",
  isRuntimeExecutionAllowed: true,
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" messages={getMessages("en")}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    </I18nProvider>
  );
}

function readsAs(): string | null {
  const sentence = screen.getByText("Reads as").nextElementSibling;
  if (sentence === null) throw new Error("no sentence follows Reads as");
  return sentence.textContent;
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
  forgetCreatedRequestLink();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetDashboardNavigation();
});

describe("New request page", () => {
  it("says there is nowhere to be paid into when the project has no wallet", () => {
    render(<PaymentRequestCreateWorkspace wallets={[]} walletsError={null} />, { wrapper });

    expect(screen.getByText("There is no wallet to be paid into")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Wallets" }).getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/wallets"
    );
    expect(screen.queryByRole("button", { name: "Create and copy link" })).toBeNull();
  });

  it("creates the request, copies its link from inside the press and opens the request", async () => {
    const writes: unknown[] = [];
    let answer: (response: Response) => void = () => {};
    const send = vi.fn<typeof fetch>((_input, init) => {
      writes.push(JSON.parse(String(init?.body)));
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    vi.stubGlobal("fetch", send);
    const success = vi.spyOn(toast, "success");
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
    const user = userEvent.setup();
    const clipboard = stubClipboard("writes");
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

    // Begun before the answer: Safari refuses a clipboard write that starts after an await.
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(clipboard.writes).toHaveLength(1);
    answer(Response.json({ data: { id: "preq_1", publicToken: "tok_1" } }));

    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([
      {
        walletId: "wallet_treasury",
        token: requiredWellKnownMint("USDC", "devnet"),
        amount: "25",
        expiresAt: null,
      },
    ]);
    const [copied] = clipboard.writes;
    if (copied === undefined) throw new Error("no clipboard write started");
    await expect(copied.then((blob) => blob.text())).resolves.toBe(
      `${window.location.origin}/pay/tok_1`
    );
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/requests/preq_1"
    );
    // The request's page says the link was copied; no toast follows the form there.
    expect(createdRequestLinkCopied("preq_1")).toBe(true);
    expect(success).not.toHaveBeenCalled();
    // On its way to the request, the form stays busy so a second press makes no second link.
    const creating = screen.getByRole("button", { name: /^Create and copy link/ });
    expect(creating.getAttribute("aria-busy")).toBe("true");
  });

  it("tells the request's page the link was not copied when the browser refuses", async () => {
    const sends = recordSends(201);
    const user = userEvent.setup();
    const clipboard = stubClipboard("refuses");
    await fillRequest(user, "25");
    await createLater(user, sends, 0);

    await waitFor(() =>
      expect(dashboardRouter.push).toHaveBeenCalledWith(
        "/dashboard/prj_test_sandbox/payments/requests/preq_1"
      )
    );
    expect(clipboard.writes).toHaveLength(1);
    expect(createdRequestLinkCopied("preq_1")).toBe(false);
  });

  it("copies nothing and opens nothing when the create is refused", async () => {
    const sends = recordSends(422);
    const user = userEvent.setup();
    const clipboard = stubClipboard("writes");
    await fillRequest(user, "25");
    await createLater(user, sends, 0);

    const [pending] = clipboard.writes;
    await expect(pending).rejects.toThrow("The create named no request");
    expect(createdRequestLinkCopied("preq_1")).toBeNull();
    expect(dashboardRouter.push).not.toHaveBeenCalled();
  });

  /** One create the page sent: its body and Idempotency-Key. */
  interface RecordedSend {
    body: z.infer<typeof sentCreateBodySchema>;
    key: string | null;
  }

  /** Records each create's body and key; the answers are given in order. */
  function recordSends(...answers: ("lost" | "outcome_unknown" | number)[]) {
    const sends: RecordedSend[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sends.push({
        body: sentCreateBodySchema.parse(JSON.parse(String(init?.body))),
        key: new Headers(init?.headers).get("Idempotency-Key"),
      });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("the page sent a create the test did not expect");
      if (answer === "lost") throw new TypeError("Failed to fetch");
      if (answer === "outcome_unknown") {
        return Response.json(
          { error: { code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN", message: "Read it first" } },
          { status: 409 }
        );
      }
      return answer < 400
        ? Response.json({ data: { id: "preq_1", publicToken: "tok_1" } }, { status: answer })
        : Response.json({ error: { message: "unavailable" } }, { status: answer });
    });
    return sends;
  }

  /** Fills the form for `amount` with a one-hour expiry. */
  async function fillRequest(user: ReturnType<typeof userEvent.setup>, amount: string) {
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
    await user.type(screen.getByRole("textbox", { name: "Amount" }), amount);
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    await user.click(screen.getByRole("button", { name: "Link expires" }));
    await user.click(screen.getByRole("button", { name: "1 hour" }));
  }

  /** Presses create at a later minute, so a re-read clock would show, and waits for the answer. */
  async function createLater(
    user: ReturnType<typeof userEvent.setup>,
    sends: readonly RecordedSend[],
    minutes: number
  ) {
    const create = () => screen.getByRole("button", { name: "Create and copy link" });
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    const sent = sends.length;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 12, 12, minutes));
    try {
      await user.click(create());
      await waitFor(() => expect(sends).toHaveLength(sent + 1));
    } finally {
      clock.mockRestore();
    }
    // Answered: the form is free again, or the request opened.
    await waitFor(() =>
      expect(
        dashboardRouter.push.mock.calls.length > 0 ||
          screen
            .queryByRole("button", { name: "Create and copy link" })
            ?.hasAttribute("disabled") === false
      ).toBe(true)
    );
  }

  // Browser test (HOO-1918): A's answer was lost, the user edited to B and back
  // to A, and A was rebuilt with a new expiry, so a second request was created.
  it("resends A's first expiry and key after an edit to B and back", async () => {
    const sends = recordSends("lost", 503, 201);
    const user = userEvent.setup();
    await fillRequest(user, "25");
    const amount = () => screen.getByRole("textbox", { name: "Amount" });

    await createLater(user, sends, 0);
    await user.clear(amount());
    await user.type(amount(), "26");
    await createLater(user, sends, 1);
    await user.clear(amount());
    await user.type(amount(), "25");
    await createLater(user, sends, 2);

    expect(sends.map((send) => send.body.amount)).toEqual(["25", "26", "25"]);
    expect(sends[0]).toMatchObject({ key: expect.any(String), body: { expiresAt: ISO_INSTANT } });
    expect(sends[2]).toEqual(sends[0]);
    expect(new Set(sends.map((send) => send.key)).size).toBe(2);
  });

  // Browser test (HOO-1918): with an expiry set, a lost answer, a reload and a
  // resubmit created a second request under a new key.
  it("resends the first expiry and key after a reload", async () => {
    const sends = recordSends("lost", 201);
    const user = userEvent.setup();
    await fillRequest(user, "25");
    await createLater(user, sends, 0);

    // A reload keeps sessionStorage and loses everything in memory.
    cleanup();
    resetIdempotencyKeyStoresForTests();
    await fillRequest(user, "25");
    await createLater(user, sends, 5);

    expect(sends).toHaveLength(2);
    expect(sends[0]).toMatchObject({ key: expect.any(String), body: { expiresAt: ISO_INSTANT } });
    expect(sends[1]).toEqual(sends[0]);
  });

  // The earlier request may have created it: the user checks the list, and
  // pressing create again is a new request under a new key.
  it("after an unknown outcome, says to check the list and opens it, sending nothing more", async () => {
    const sends = recordSends("outcome_unknown", 201);
    const error = vi.spyOn(toast, "error");
    const user = userEvent.setup();
    await fillRequest(user, "25");
    await createLater(user, sends, 0);

    expect(error).toHaveBeenCalledWith(
      "We couldn’t confirm whether this was created — check the list before trying again."
    );
    expect(dashboardRouter.push).toHaveBeenCalledWith(
      "/dashboard/prj_test_sandbox/payments/requests"
    );
    expect(sends).toHaveLength(1);

    cleanup();
    dashboardRouter.push.mockClear();
    await fillRequest(user, "25");
    await createLater(user, sends, 1);
    expect(sends.map((send) => send.key)).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(sends.map((send) => send.key)).size).toBe(2);
  });

  it("keeps create off for an amount the API would refuse", async () => {
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "1e3");

    expect(screen.getByText("Enter an amount greater than zero.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create and copy link" }).hasAttribute("disabled")
    ).toBe(true);
  });
});
