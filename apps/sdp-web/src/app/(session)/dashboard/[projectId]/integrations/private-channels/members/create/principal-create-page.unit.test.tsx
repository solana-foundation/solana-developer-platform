// @vitest-environment jsdom

import type { CustodyWalletSummary } from "@sdp/types/custody";
import type { PrivateChannelPrincipalDto } from "@sdp/types/private-channels";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as principalActions from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/members/actions";
import * as walletActions from "@/app/(session)/dashboard/[projectId]/integrations/private-channels/wallets/actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { PrincipalCreatePage } from "./principal-create-page";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

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

const PRINCIPAL: PrivateChannelPrincipalDto = {
  id: "pcu_ops",
  name: "Ops desk",
  isDefault: false,
  status: "active",
  verifiedWalletCount: 0,
  createdAt: "2026-11-03T09:00:00.000Z",
  channels: [],
};

type VerifyAnswer = Awaited<ReturnType<typeof walletActions.verifyWalletAction>>;

/** Holds the next wallet check open; the test answers it with the returned resolver. */
function holdVerification(verify: MockInstance<typeof walletActions.verifyWalletAction>) {
  const held = Promise.withResolvers<VerifyAnswer>();
  verify.mockReturnValueOnce(held.promise);
  return held.resolve;
}

/** The footer's primary, by the start of its name: a running press adds the spinner's. */
function primary(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(Create identity|Retry verification)/ });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PrincipalCreatePage", () => {
  it("keeps each press's words on the button while it runs", async () => {
    const create = vi
      .spyOn(principalActions, "createPrincipalAction")
      .mockResolvedValue({ ok: true, value: PRINCIPAL });
    const verify = vi.spyOn(walletActions, "verifyWalletAction");
    const answerFirst = holdVerification(verify);
    render(
      <I18nProvider locale="en" messages={getMessages("en")}>
        <PrincipalCreatePage wallets={[WALLET]} />
      </I18nProvider>
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Identity name"), "Ops desk");
    await user.click(screen.getByRole("combobox", { name: "Wallet" }));
    await user.click(await screen.findByRole("option", { name: "Ops (OpsP…1111)" }));
    await user.click(primary());

    // The identity exists and its wallet check is out: the first press still reads Create.
    await waitFor(() => expect(verify).toHaveBeenCalledExactlyOnceWith("cwlt_ops", "pcu_ops"));
    expect(primary().textContent).toBe("Create identity");
    expect(primary().getAttribute("aria-busy")).toBe("true");

    answerFirst({ ok: false, message: "The wallet could not be verified." });
    await waitFor(() => expect(primary().getAttribute("aria-busy")).toBe("false"));
    expect(primary().textContent).toBe("Retry verification");

    // A retry checks the wallet again for the same identity and reads Retry while it runs.
    const answerRetry = holdVerification(verify);
    await user.click(primary());
    await waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
    expect(primary().textContent).toBe("Retry verification");
    expect(primary().getAttribute("aria-busy")).toBe("true");
    expect(create).toHaveBeenCalledTimes(1);

    answerRetry({
      ok: true,
      wallet: {
        id: "pcw_ops",
        walletId: "cwlt_ops",
        pubkey: WALLET.publicKey,
        verifiedAt: "2026-11-03T09:01:00.000Z",
      },
    });
    await waitFor(() => expect(dashboardRouter.push).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(primary().getAttribute("aria-busy")).toBe("false"));
  });
});
