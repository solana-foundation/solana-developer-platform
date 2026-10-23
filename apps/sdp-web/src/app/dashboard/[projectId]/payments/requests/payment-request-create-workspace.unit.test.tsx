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
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PaymentRequestCreateWorkspace } from "./payment-request-create-workspace";
import { deriveTokenOptions } from "./payment-requests-page.data";

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
  publicKey: "11111111111111111111111111111111",
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

function readsAs(): string {
  return screen.getByText("Reads as").nextElementSibling?.textContent ?? "";
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetIdempotencyKeyStoresForTests();
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

  it("creates the request, copies its link and opens it in the list", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { id: "preq_1", publicToken: "tok_1" } });
    });
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
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
        walletId: "wallet_treasury",
        token: usdc?.mintAddress,
        amount: "25",
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

  // The expiry comes from the clock. Read again on the retry, it would be a new
  // body under a new key, and a first attempt that did create could be repeated.
  it("resends the first attempt's expiry and key when the user retries", async () => {
    const sends: { body: z.infer<typeof sentCreateBodySchema>; key: string | null }[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sends.push({
        body: sentCreateBodySchema.parse(JSON.parse(String(init?.body))),
        key: new Headers(init?.headers).get("Idempotency-Key"),
      });
      if (sends.length === 1) throw new TypeError("network down");
      return Response.json({ data: { id: "preq_1", publicToken: "tok_1" } });
    });
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
    const user = userEvent.setup();
    const create = () => screen.getByRole("button", { name: "Create and copy link" });

    await user.type(screen.getByRole("textbox", { name: "Amount" }), "25");
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
    await user.click(screen.getByRole("button", { name: "Link expires" }));
    await user.click(screen.getByRole("button", { name: "1 hour" }));
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    await user.click(create());
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));

    const later = Date.now() + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      await user.click(create());
      await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    } finally {
      clock.mockRestore();
    }

    expect(sends).toHaveLength(2);
    expect(sends[0]?.body.expiresAt).toMatch(/^\d{4}-/);
    expect(sends[1]?.body).toEqual(sends[0]?.body);
    expect(sends[1]?.key).toBe(sends[0]?.key);
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
      const answer = answers.shift() ?? 201;
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
    expect(sends[1]?.key).not.toBe(sends[0]?.key);
    expect(sends[2]?.body).toEqual(sends[0]?.body);
    expect(sends[2]?.key).toBe(sends[0]?.key);
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
    expect(sends[1]?.body).toEqual(sends[0]?.body);
    expect(sends[1]?.key).toBe(sends[0]?.key);
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
      expect.stringMatching(/\/payments\/requests$/)
    );
    expect(sends).toHaveLength(1);

    cleanup();
    dashboardRouter.push.mockClear();
    await fillRequest(user, "25");
    await createLater(user, sends, 1);
    expect(sends[1]?.key).not.toBe(sends[0]?.key);
  });

  it("frees the form when creating the link throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
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

  /**
   * Answers USDC as a scaled mint (two shown per token unit) and its credit
   * quotes, the next of `credits` each time, the last one holding: 25 shown is
   * 12.5 token units. Records each quote body, and hands each create to
   * `answerCreate`.
   */
  function stubScaledUsdc(
    credits: readonly [string, ...string[]],
    answerCreate: (body: unknown) => Promise<Response>
  ) {
    const usdc = deriveTokenOptions("devnet").find((token) => token.symbol === "USDC");
    const quoteBodies: unknown[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/terms")) {
        return Response.json({
          data: {
            terms: {
              mint: usdc?.mintAddress,
              decimals: 6,
              transferFee: null,
              display: {
                rule: "scaled",
                multiplier: 2,
                newMultiplier: 2,
                newMultiplierEffectiveAt: "2026-01-01T00:00:00.000Z",
              },
            },
          },
        });
      }
      if (url.endsWith("/quote")) {
        const credit = credits[Math.min(quoteBodies.length, credits.length - 1)];
        quoteBodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          data: {
            quote: {
              mint: usdc?.mintAddress,
              amount: credit,
              amounts: {
                basis: "credit",
                debit: credit,
                fee: "0",
                credit,
                decimals: 6,
                display: {
                  debit: "25",
                  fee: "0",
                  credit: "25",
                  asOf: "2026-10-22T12:00:00.000Z",
                },
              },
              feeEpoch: null,
              asOf: "2026-10-22T12:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          },
        });
      }
      return answerCreate(JSON.parse(String(init?.body)));
    });
    return { usdc, quoteBodies };
  }

  /** Fills the form for 25 as wallets show it, paid into the treasury. */
  async function fillDisplayRequest(user: ReturnType<typeof userEvent.setup>) {
    render(<PaymentRequestCreateWorkspace wallets={[wallet]} walletsError={null} />, { wrapper });
    await user.click(await screen.findByRole("radio", { name: "Wallet display" }));
    await user.type(screen.getByRole("textbox", { name: "Amount as wallets show it" }), "25");
    await user.click(screen.getByRole("button", { name: "Destination wallet" }));
    await user.click(screen.getByRole("button", { name: /Treasury/ }));
  }

  // A request's amount is the credit, in token units. Typed as wallets show it, the quote
  // converts it, and the quote's credit is what the request asks for.
  it("asks for the credit a display amount converts to, never the display amount", async () => {
    const creates: unknown[] = [];
    const { usdc, quoteBodies } = stubScaledUsdc(["12.5"], async (body) => {
      creates.push(body);
      return Response.json({ data: { id: "preq_1", publicToken: "tok_1" } });
    });
    const user = userEvent.setup();
    const create = () => screen.getByRole("button", { name: "Create and copy link" });
    await fillDisplayRequest(user);

    await waitFor(() => expect(screen.getByText("Token amount")).toBeTruthy());
    expect(screen.getByText("Payer pays")).toBeTruthy();
    expect(readsAs()).toBe("Anyone with the link can pay 12.50 USDC into Treasury.");
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    await user.click(create());

    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    expect(quoteBodies).toEqual([{ displayAmount: "25", basis: "credit" }]);
    expect(creates).toEqual([
      { walletId: "wallet_treasury", token: usdc?.mintAddress, amount: "12.5", expiresAt: null },
    ]);
  });

  // A display amount's credit is priced again by each quote. A retry after a lost answer at a
  // later quote's credit was a new body under a new key, and could create a second request.
  it("resends a display amount's first credit and key after a lost answer and a new quote", async () => {
    let attempts = 0;
    stubScaledUsdc(["12.5", "13", "12.4"], async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return Response.json({ data: { id: "preq_1", publicToken: "tok_1" } });
    });
    // The stub sees bodies only; the spy also sees each create's Idempotency-Key.
    const sent = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    const create = () => screen.getByRole("button", { name: "Create and copy link" });
    const amount = () => screen.getByRole("textbox", { name: "Amount as wallets show it" });
    await fillDisplayRequest(user);
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    await user.click(create());
    await waitFor(() => expect(attempts).toBe(1));
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));

    // An edit and back prices 25 again, at 12.4 now.
    await user.clear(amount());
    await user.type(amount(), "26");
    await waitFor(() => expect(readsAs()).toContain("13.00 USDC"));
    await user.clear(amount());
    await user.type(amount(), "25");
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    // The unresolved attempt is shown as it went out.
    expect(readsAs()).toBe("Anyone with the link can pay 12.50 USDC into Treasury.");
    await user.click(create());
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));

    const createCalls = sent.mock.calls.filter(([input]) =>
      String(input).endsWith("/payments/requests")
    );
    const bodies = createCalls.map(([, init]) => JSON.parse(String(init?.body)));
    const keys = createCalls.map(([, init]) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ amount: "12.5" });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(keys[1]).toBe(keys[0]);
  });

  // The unit decides what the request asks for, so it cannot change while the create is sent.
  it("locks the amount unit while the request is being created", async () => {
    let answer: (response: Response) => void = () => undefined;
    stubScaledUsdc(
      ["12.5"],
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        })
    );
    const user = userEvent.setup();
    const create = () => screen.getByRole("button", { name: "Create and copy link" });
    const tokenUnits = () => screen.getByRole("radio", { name: "Token units" });
    await fillDisplayRequest(user);
    await waitFor(() => expect(create().hasAttribute("disabled")).toBe(false));
    expect(tokenUnits().matches(":disabled")).toBe(false);

    await user.click(create());

    await waitFor(() => expect(screen.getByRole("button", { name: "Creating…" })).toBeTruthy());
    expect(tokenUnits().matches(":disabled")).toBe(true);
    answer(Response.json({ data: { id: "preq_1", publicToken: "tok_1" } }));
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
  });
});
