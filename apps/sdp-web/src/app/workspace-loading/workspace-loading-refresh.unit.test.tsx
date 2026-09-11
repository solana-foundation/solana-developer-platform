// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { WorkspaceLoadingRefresh } from "./workspace-loading-refresh";

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const fetchMock = vi.fn();
const ui = () => (
  <I18nProvider locale="en" messages={getMessages("en")}>
    <WorkspaceLoadingRefresh returnTo="/dashboard" />
  </I18nProvider>
);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  router.replace.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("workspace preparation", () => {
  it("shows a skeleton, then stops polling and offers an explicit retry", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ state: "pending", reason: "sync" }),
    });
    const view = render(ui());
    expect(view.getByRole("status").textContent).toContain("Preparing your SDP workspace");
    expect(view.container.querySelector('[data-loading-layout="home"]')).toBeTruthy();
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(view.getByRole("status").textContent).toContain("Your workspace is still being set up");
    const count = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(count);
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    expect(fetchMock).toHaveBeenCalledTimes(count + 1);
    expect(view.getByRole("status").textContent).toContain("Preparing your SDP workspace");
  });
  it("navigates without a document reload when the workspace is ready", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ state: "ready" }) });
    const view = render(ui());
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(router.replace).toHaveBeenCalledExactlyOnceWith("/dashboard");
    expect(view.container.querySelector("[data-shell-loading-skeleton]")).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps permission problems distinct from slow sync", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ state: "pending", reason: "access" }),
    });
    const view = render(ui());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(view.getByRole("status").textContent).toContain("contact your organization admin");
  });
  it("bounds even a request that never resolves", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const view = render(ui());
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
