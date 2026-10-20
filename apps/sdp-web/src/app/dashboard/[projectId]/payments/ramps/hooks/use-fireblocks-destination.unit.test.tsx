// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import * as sonner from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dashboard from "@/lib/dashboard-fetch";
import { useFireblocksDestination } from "./use-fireblocks-destination";

const mocks = vi.hoisted(() => ({
  projectId: "project-one",
  userId: "user-one",
  fetch: vi.fn(),
  toast: Object.assign(
    vi.fn<(...args: Parameters<typeof import("sonner").toast>) => string>(() => "toast-book"),
    { dismiss: vi.fn(), error: vi.fn() }
  ),
  t: (key: string) => key,
}));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => mocks.t }));
vi.mock("@/lib/use-dashboard-project", () => ({ useProjectId: () => mocks.projectId }));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: mocks.userId, orgId: "org" },
  }),
}));
const selection = {
  enabled: true,
  walletId: "wallet",
  counterpartyId: "contact",
  accountId: "address",
  token: "SOL",
  address: "11111111111111111111111111111111",
};
const response = (state: string) => ({ ok: true, data: { data: { state, assetId: "SOL" } } });
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
}
function action() {
  const action = mocks.toast.mock.calls[0][1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action)) {
    throw new Error("Expected a toast action");
  }
  return () => {
    const button = render(
      <button type="button" onClick={action.onClick}>
        Suppress warning
      </button>
    );
    fireEvent.click(button.getByRole("button", { name: "Suppress warning" }));
    button.unmount();
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(dashboard, "dashboardFetch").mockImplementation(mocks.fetch);
  vi.spyOn(sonner.toast, "message").mockImplementation(mocks.toast);
  vi.spyOn(sonner.toast, "dismiss").mockImplementation(mocks.toast.dismiss);
  vi.spyOn(sonner.toast, "error").mockImplementation(mocks.toast.error);
  window.localStorage.clear();
  mocks.projectId = "project-one";
  mocks.userId = "user-one";
  mocks.fetch.mockResolvedValue(response("not_whitelisted"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("Fireblocks destination warning", () => {
  it("only reads, and saves suppression across remounts without proposing anything", async () => {
    const view = renderHook(() => useFireblocksDestination(selection));
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[0]).toContain("/destination?");
    expect(mocks.toast).toHaveBeenCalledOnce();
    action()();
    view.unmount();
    renderHook(() => useFireblocksDestination(selection));
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(window.localStorage.length).toBe(1);
    expect(mocks.fetch.mock.calls.every(([, opts]) => !opts.method || opts.method === "GET")).toBe(
      true
    );
  });
  it("does not suppress warnings for another user or project", async () => {
    const view = renderHook(() => useFireblocksDestination(selection));
    await tick();
    action()();
    mocks.projectId = "project-two";
    view.rerender();
    await tick();
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    mocks.projectId = "project-one";
    mocks.userId = "user-two";
    view.unmount();
    renderHook(() => useFireblocksDestination(selection));
    await tick();
    expect(mocks.toast).toHaveBeenCalledTimes(3);
  });
  it.each(["approved", "pending", "unknown", "failed"])(
    "does not warn about absence for %s",
    async (state) => {
      mocks.fetch.mockResolvedValue(response(state));
      renderHook(() => useFireblocksDestination(selection));
      await tick();
      expect(mocks.toast).not.toHaveBeenCalled();
    }
  );
  it("does not turn a failed lookup into an absent address", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, error: "Unavailable" });
    renderHook(() => useFireblocksDestination(selection));
    await tick();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("ignores stale responses, aborts old lookups and dismisses old warnings", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const view = renderHook((props) => useFireblocksDestination(props), {
      initialProps: selection,
    });
    await tick();
    const signal = mocks.fetch.mock.calls[0]?.[1].signal;
    view.rerender({ ...selection, accountId: "next" });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve(response("not_whitelisted"));
    });
    expect(mocks.toast).not.toHaveBeenCalled();
    await tick();
    const oldAction = action();
    view.rerender({ ...selection, enabled: false });
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("toast-book");
    oldAction();
    expect(window.localStorage.length).toBe(0);
  });
  it("does not repeat reads on unrelated renders or for another provider", async () => {
    const view = renderHook((props) => useFireblocksDestination(props), {
      initialProps: selection,
    });
    await tick();
    view.rerender({ ...selection });
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    view.rerender({ ...selection, enabled: false });
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it("reports a storage failure instead of claiming permanent suppression", async () => {
    const storage = vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    renderHook(() => useFireblocksDestination(selection));
    await tick();
    action()();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "DashboardPayments.fireblocksWarnings.saveFailed"
    );
    storage.mockRestore();
  });
});
