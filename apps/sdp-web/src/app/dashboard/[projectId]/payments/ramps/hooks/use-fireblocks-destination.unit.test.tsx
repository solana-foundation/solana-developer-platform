// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFireblocksDestination } from "./use-fireblocks-destination";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: Object.assign(
    vi.fn(() => "toast-book"),
    { dismiss: vi.fn(), error: vi.fn() }
  ),
  t: (key: string) => key,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: mocks.fetch }));
vi.mock("@/i18n/provider", () => ({ useTranslations: () => mocks.t }));
vi.mock("@/lib/use-dashboard-project", () => ({ useProjectId: () => "project-one" }));
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
  return (mocks.toast.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1]
    .action.onClick;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(response("not_whitelisted"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("Fireblocks destination prompt", () => {
  it("reads after selection and writes only after the user clicks the toast action", async () => {
    renderHook(() => useFireblocksDestination(selection));
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[0]).toContain("/destination?");
    expect(mocks.toast).toHaveBeenCalledOnce();
    mocks.fetch.mockResolvedValue(response("pending"));
    await act(async () => {
      action()();
    });
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/dashboard/fireblocks/whitelist", {
      method: "POST",
      body: {
        walletId: "wallet",
        counterpartyId: "contact",
        accountId: "address",
        token: "SOL",
        address: selection.address,
      },
    });
  });
  it.each(["approved", "pending", "unknown", "failed"])(
    "does not offer another proposal for %s",
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
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["request", "whitelistFailed"],
    ["permissions", "whitelistPermissions"],
    ["credentials", "whitelistCredentials"],
  ])(
    "shows the actual %s failure category without automatically retrying",
    async (failureReason, message) => {
      renderHook(() => useFireblocksDestination(selection));
      await tick();
      mocks.fetch.mockResolvedValue({
        ok: true,
        data: { data: { state: "failed", assetId: "SOL", failureReason, providerCode: 9003 } },
      });
      await act(async () => {
        action()();
      });
      expect(mocks.toast).toHaveBeenLastCalledWith(`DashboardPayments.onchainSend.${message}`, {
        duration: 10000,
        description: "DashboardPayments.onchainSend.whitelistErrorCode",
      });
      await tick();
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    }
  );
  it("ignores stale responses and dismisses an old destination's action", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const { rerender } = renderHook((props) => useFireblocksDestination(props), {
      initialProps: selection,
    });
    await tick();
    rerender({ ...selection, accountId: "next" });
    await act(async () => {
      resolve(response("not_whitelisted"));
    });
    expect(mocks.toast).not.toHaveBeenCalled();
    await tick();
    const oldAction = action();
    rerender({ ...selection, enabled: false });
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("toast-book");
    const count = mocks.fetch.mock.calls.length;
    await act(async () => {
      oldAction();
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(count);
  });
  it("does not repeat the check on unrelated renders or use another wallet provider", async () => {
    const { rerender } = renderHook((props) => useFireblocksDestination(props), {
      initialProps: selection,
    });
    await tick();
    rerender({ ...selection });
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    rerender({ ...selection, enabled: false });
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
