// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMessages, type Messages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { FreshSWRCache } from "@/test/swr";
import { FireblocksCredentialFields } from "./fireblocks-credential-fields";

const ready = vi.fn();
const pending = vi.fn();
function fields(messages: Messages) {
  return (
    <I18nProvider locale="en" messages={messages}>
      <FireblocksCredentialFields onReadyChange={ready} onPendingChange={pending} />
    </I18nProvider>
  );
}
function pendingCsr(expiresInMs: number) {
  return {
    id: "fbcsr_test",
    csrPem: "public-csr",
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}
function signingKeyId(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[name="signingKeyId"]')?.value;
}
beforeEach(() => {
  ready.mockReset();
  pending.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads the registration once when a route render hands the provider new messages", async () => {
  const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, { csr: null }));
  const view = render(fields(getMessages("en")), { wrapper: FreshSWRCache });
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  view.rerender(fields({ ...getMessages("en") }));
  await act(async () => {});
  expect(sentDashboardRequests(fetchMock)).toEqual([
    { path: "/api/dashboard/fireblocks/csr", method: "GET", idempotencyKey: null, body: undefined },
  ]);
});

it("tells the host it is not ready, and pending only while the read is in flight", async () => {
  const answer = Promise.withResolvers<Response>();
  stubDashboardFetch(() => answer.promise);
  render(fields(getMessages("en")), { wrapper: FreshSWRCache });
  expect(ready).toHaveBeenCalledWith(false);
  expect(pending).toHaveBeenLastCalledWith(true);
  expect(pending).not.toHaveBeenCalledWith(false);
  answer.resolve(dashboardDataResponse(200, { csr: pendingCsr(86_400_000) }));
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  expect(screen.getByRole("button", { name: "Download CSR" })).toBeTruthy();
});

it.each([
  ["an error answer", () => dashboardErrorResponse(503, "Upstream unavailable")],
  // The route streams sdp-api's envelope; a bare body means the answer was not read as sent.
  ["a body outside the data envelope", () => Response.json({ csr: pendingCsr(86_400_000) })],
])("shows a failed read for %s and settles pending", async (_case, answer) => {
  const fetchMock = stubDashboardFetch(answer);
  render(fields(getMessages("en")), { wrapper: FreshSWRCache });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not generate your CSR. Try again."
  );
  await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
  expect(screen.queryByRole("button", { name: "Download CSR" })).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("marks a registration that expires while the form is open and withdraws it", async () => {
  // Only the clock and timeouts are faked; time still passes, so the read and RTL's waits settle.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
  stubDashboardFetch(() => dashboardDataResponse(200, { csr: pendingCsr(60_000) }));
  const { container } = render(fields(getMessages("en")), { wrapper: FreshSWRCache });
  await screen.findByRole("button", { name: "Download CSR" });
  expect(signingKeyId(container)).toBe("fbcsr_test");
  ready.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.getByRole("alert")).toHaveProperty(
    "textContent",
    "This registration has expired. Generate a new CSR to continue."
  );
  expect(ready).toHaveBeenCalledWith(false);
  expect(signingKeyId(container)).toBe("");
  expect(screen.getByRole("button", { name: "Generate and download CSR" })).toBeTruthy();
});
