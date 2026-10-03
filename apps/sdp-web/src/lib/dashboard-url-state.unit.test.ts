// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshKeepingDashboardUrl, replaceDashboardSearchParams } from "./dashboard-url-state";

describe("refreshKeepingDashboardUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("hands Next the live URL, shallow tab included, before it refreshes", () => {
    window.history.replaceState({ __NA: true }, "", "/dashboard/issuance/tok_1");
    replaceDashboardSearchParams({ tab: "operations" });

    const calls: string[] = [];
    const replaceState = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation((data, _unused, url) => {
        // Next's patch acts only on a state without its own marker.
        calls.push(`replace:${data === null ? "external" : "internal"}:${String(url)}`);
      });
    refreshKeepingDashboardUrl({ refresh: () => calls.push("refresh") });

    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["replace:external:/dashboard/issuance/tok_1?tab=operations", "refresh"]);
  });
});
