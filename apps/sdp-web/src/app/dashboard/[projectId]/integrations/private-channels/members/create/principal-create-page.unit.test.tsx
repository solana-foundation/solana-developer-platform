// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";

const mocks = vi.hoisted(() => ({
  createPrincipalAction: vi.fn(),
  verifyWalletAction: vi.fn(),
}));

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/app/dashboard/[projectId]/integrations/private-channels/members/actions", () => ({
  createPrincipalAction: mocks.createPrincipalAction,
}));
vi.mock("@/app/dashboard/[projectId]/integrations/private-channels/wallets/actions", () => ({
  verifyWalletAction: mocks.verifyWalletAction,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// A native select stands in for the design-system one, so a test can pick the wallet.
vi.mock("@sdp/ui/select", () => ({
  Select: ({
    ariaLabel,
    children,
    disabled,
    onValueChange,
    value,
  }: {
    ariaLabel?: string;
    children: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string | null) => void;
    value?: string | null;
  }) => (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value || null)}
      value={value ?? ""}
    >
      <option value="">Choose a wallet</option>
      {children}
    </select>
  ),
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import { PrincipalCreatePage } from "./principal-create-page";

const WALLET: CustodyWalletSummary = {
  id: "wallet-row-1",
  custodyConnectionId: "conn-active",
  provider: "privy",
  isRuntimeExecutionAllowed: true,
  walletId: "cwlt_ops",
  publicKey: "OpsPublicKey1111111111111111111111111111111",
  label: "Ops",
  purpose: "transfer",
  status: "active",
  createdAt: "2026-08-10T09:05:00.000Z",
};

type VerifyAnswer = { ok: true; value: undefined } | { ok: false; message: string };

/** A wallet check the test answers when it chooses. */
function heldVerification() {
  let answer: (result: VerifyAnswer) => void = () => undefined;
  mocks.verifyWalletAction.mockReturnValueOnce(
    new Promise<VerifyAnswer>((resolve) => {
      answer = resolve;
    })
  );
  return (result: VerifyAnswer) => answer(result);
}

/** The footer's primary, by the start of its name: a running press adds the spinner's. */
function primary(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(Create identity|Retry verification)/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDashboardNavigation();
});

afterEach(cleanup);

describe("PrincipalCreatePage", () => {
  it("keeps each press's words on the button while it runs", async () => {
    mocks.createPrincipalAction.mockResolvedValue({ ok: true, value: { id: "pcu_ops" } });
    const answerFirst = heldVerification();
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrincipalCreatePage wallets={[WALLET]} />
      </I18nProvider>
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Identity name"), "Ops desk");
    await user.selectOptions(screen.getByRole("combobox", { name: "Wallet" }), "cwlt_ops");
    await user.click(primary());

    // The identity exists and its wallet check is out: the first press still reads Create.
    await waitFor(() =>
      expect(mocks.verifyWalletAction).toHaveBeenCalledExactlyOnceWith("cwlt_ops", "pcu_ops")
    );
    expect(primary().textContent).toBe("Create identity");
    expect(primary().getAttribute("aria-busy")).toBe("true");

    answerFirst({ ok: false, message: "The wallet could not be verified." });
    await waitFor(() => expect(primary().getAttribute("aria-busy")).toBe("false"));
    expect(primary().textContent).toBe("Retry verification");

    // A retry checks the wallet again for the same identity and reads Retry while it runs.
    const answerRetry = heldVerification();
    await user.click(primary());
    await waitFor(() => expect(mocks.verifyWalletAction).toHaveBeenCalledTimes(2));
    expect(primary().textContent).toBe("Retry verification");
    expect(primary().getAttribute("aria-busy")).toBe("true");
    expect(mocks.createPrincipalAction).toHaveBeenCalledTimes(1);

    answerRetry({ ok: true, value: undefined });
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(primary().getAttribute("aria-busy")).toBe("false"));
  });
});
