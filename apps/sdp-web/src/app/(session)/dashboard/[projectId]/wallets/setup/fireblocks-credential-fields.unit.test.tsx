// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as csrActions from "@/app/(session)/dashboard/[projectId]/wallets/setup/fireblocks-csr-actions";
import { getMessages, type Messages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { FireblocksCredentialFields } from "./fireblocks-credential-fields";
import { loadFireblocksCsrAction } from "./fireblocks-csr-actions";

const ready = vi.fn();
const pending = vi.fn();
function fields(messages: Messages) {
  return (
    <I18nProvider locale="en" messages={messages}>
      <FireblocksCredentialFields onReadyChange={ready} onPendingChange={pending} />
    </I18nProvider>
  );
}
beforeEach(() => {
  vi.spyOn(csrActions, "loadFireblocksCsrAction");
  vi.mocked(loadFireblocksCsrAction).mockReset();
  ready.mockReset();
  pending.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("loads the registration once when a route render hands the provider new messages", async () => {
  vi.mocked(loadFireblocksCsrAction).mockResolvedValue({ status: "success", csr: null });
  const view = render(fields(getMessages("en")));
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  view.rerender(fields({ ...getMessages("en") }));
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  expect(loadFireblocksCsrAction).toHaveBeenCalledTimes(1);
});

it("shows the load failure and keeps it through a new messages identity", async () => {
  vi.mocked(loadFireblocksCsrAction).mockRejectedValue(new Error("Network disconnected"));
  const view = render(fields(getMessages("en")));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not generate your CSR. Try again."
  );
  view.rerender(fields({ ...getMessages("en") }));
  expect(screen.getByRole("alert")).toHaveProperty(
    "textContent",
    "Could not generate your CSR. Try again."
  );
  expect(loadFireblocksCsrAction).toHaveBeenCalledTimes(1);
});
