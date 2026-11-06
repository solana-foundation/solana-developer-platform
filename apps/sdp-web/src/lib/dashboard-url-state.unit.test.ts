// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshKeepingDashboardUrl, replaceDashboardSearchParams } from "./dashboard-url-state";

describe("refreshKeepingDashboardUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("re-reads the page at the live URL, shallow tab included", () => {
    window.history.replaceState({ __NA: true }, "", "/dashboard/issuance/tok_1");
    replaceDashboardSearchParams({ tab: "operations" });
    const replaceState = vi.spyOn(window.history, "replaceState");
    const router = { refresh: vi.fn(), replace: vi.fn() };

    refreshKeepingDashboardUrl(router);

    expect(router.replace).toHaveBeenCalledWith("/dashboard/issuance/tok_1?tab=operations", {
      scroll: false,
    });
    expect(router.refresh).not.toHaveBeenCalled();
    // No history write of its own: Next's patch would start a restore that undoes the read.
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("replaceDashboardSearchParams", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("replaces with null state, so Next's patch records the URL as its own", () => {
    window.history.replaceState({ __NA: true }, "", "/dashboard/issuance/tok_1");
    const replaceState = vi.spyOn(window.history, "replaceState");

    replaceDashboardSearchParams({ tab: "x" });

    expect(replaceState.mock.calls).toEqual([[null, "", "/dashboard/issuance/tok_1?tab=x"]]);
  });
});
