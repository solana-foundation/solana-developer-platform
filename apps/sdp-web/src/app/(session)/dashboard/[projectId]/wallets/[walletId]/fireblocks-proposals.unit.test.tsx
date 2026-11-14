// @vitest-environment jsdom
import type { FireblocksProposalSummary } from "@sdp/types/fireblocks";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as actions from "@/app/(session)/dashboard/[projectId]/wallets/fireblocks-proposal-actions";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { FireblocksProposals } from "./fireblocks-proposals";

const proposal: FireblocksProposalSummary = {
  id: "fbp_1",
  kind: "signing",
  operation: "PROGRAM_CALL",
  status: "PENDING_AUTHORIZATION",
  transactionId: "provider-proposal-1",
  createdAt: "2026-11-12T12:00:00Z",
  cancellationRequestedAt: null,
  canCancel: true,
};
function show() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <FireblocksProposals custodyWalletId="cwlt_1" />
      </I18nProvider>
    </SWRConfig>
  );
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(actions, "listFireblocksProposals").mockResolvedValue({
    proposals: [proposal],
    hasMore: false,
  });
});
afterEach(cleanup);

it("asks for cancellation and reports acknowledgement without claiming it was cancelled", async () => {
  vi.spyOn(actions, "cancelFireblocksProposal").mockResolvedValue({
    acknowledged: true,
    proposal,
  });
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("button", { name: "Cancel proposal" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Cancellation can race approval or execution");
  await user.click(within(dialog).getByRole("button", { name: "Cancel proposal" }));
  await waitFor(() =>
    expect(actions.cancelFireblocksProposal).toHaveBeenCalledWith(
      "signing",
      "fbp_1",
      expect.any(String)
    )
  );
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Cancellation requested. Waiting for the final Fireblocks status."
  );
  expect(screen.queryByText("Fireblocks confirmed cancellation.")).toBeNull();
});

it("keeps the idempotency key across an uncertain retry", async () => {
  const cancel = vi
    .spyOn(actions, "cancelFireblocksProposal")
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce({
      acknowledged: true,
      proposal: { ...proposal, status: "CANCELLED", canCancel: false },
    });
  const user = userEvent.setup();
  show();
  await user.click(await screen.findByRole("button", { name: "Cancel proposal" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel proposal" })
  );
  await waitFor(() =>
    expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain(
      "Could not confirm"
    )
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel proposal" })
  );
  await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
  expect(cancel.mock.calls[0]).toEqual(cancel.mock.calls[1]);
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Fireblocks confirmed cancellation."
  );
});

it("loads native transfers and never offers cancellation for a completed proposal", async () => {
  const user = userEvent.setup();
  vi.spyOn(actions, "listFireblocksProposals").mockResolvedValue({
    proposals: [{ ...proposal, status: "COMPLETED", canCancel: false }],
    hasMore: false,
  });
  show();
  expect(await screen.findByText("COMPLETED")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel proposal" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Transfers" }));
  await waitFor(() =>
    expect(actions.listFireblocksProposals).toHaveBeenCalledWith("cwlt_1", "transfer", 0)
  );
});
