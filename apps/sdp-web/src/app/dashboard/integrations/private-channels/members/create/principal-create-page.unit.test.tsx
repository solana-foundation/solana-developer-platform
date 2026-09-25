// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";

const mocks = vi.hoisted(() => ({
  createAndVerifyPrincipalAction: vi.fn(),
  routerPush: vi.fn(),
  routerRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, refresh: mocks.routerRefresh }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../actions", () => ({
  createAndVerifyPrincipalAction: mocks.createAndVerifyPrincipalAction,
}));

import { PrincipalCreatePage } from "./principal-create-page";

const wallet: CustodyWalletSummary = {
  custodyConfigId: "cc_1",
  id: "pcw_1",
  isRuntimeExecutionAllowed: false,
  walletId: "wallet_1",
  publicKey: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  label: "Deposit wallet",
  purpose: null,
  status: "active",
  createdAt: "2026-09-24T00:00:00.000Z",
};

function renderPage() {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <PrincipalCreatePage projectId="project_rendered" wallets={[wallet]} />
    </I18nProvider>
  );
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Identity name"), "Mia");
  await user.click(screen.getByRole("combobox", { name: "Wallet" }));
  await user.click(await screen.findByRole("option", { name: /Deposit wallet/ }));
  await user.click(screen.getByRole("button", { name: "Create identity" }));
}

afterEach(cleanup);

describe("PrincipalCreatePage lost-response resume", () => {
  it("keeps the ordinary retry disabled while the resume choice waits for confirmation", async () => {
    const user = userEvent.setup();
    mocks.createAndVerifyPrincipalAction
      .mockResolvedValueOnce({
        ok: false,
        message: "Your previous attempt may have created identity “Mia”.",
        resumeCandidates: ["pcp_lost"],
      })
      .mockResolvedValueOnce({ ok: true, wallet: { id: "pcvw_1", walletId: "wallet_1" } });
    renderPage();

    await fillAndSubmit(user);

    expect(mocks.createAndVerifyPrincipalAction).toHaveBeenCalledTimes(1);
    // The resume choice is displayed instead of enabling the ordinary retry:
    // both call the same submit, so only a disabled retry button can make the
    // callout's "Resume identity" the one confirmation for the resume.
    const retry = await screen.findByRole("button", { name: "Retry verification" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Resume identity" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Resume identity" }));
    expect(mocks.createAndVerifyPrincipalAction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: "Mia",
        walletId: "wallet_1",
        projectId: "project_rendered",
        resumePrincipalId: "pcp_lost",
      })
    );
  });

  it("retries with the created principal id after a failed verification", async () => {
    const user = userEvent.setup();
    mocks.createAndVerifyPrincipalAction
      .mockResolvedValueOnce({
        ok: false,
        message: "Custody wallet not found.",
        principalId: "pcp_1",
      })
      .mockResolvedValueOnce({ ok: true, wallet: { id: "pcvw_1", walletId: "wallet_1" } });
    renderPage();

    await fillAndSubmit(user);

    await user.click(await screen.findByRole("button", { name: "Retry verification" }));
    expect(mocks.createAndVerifyPrincipalAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ principalId: "pcp_1" })
    );
  });
});
