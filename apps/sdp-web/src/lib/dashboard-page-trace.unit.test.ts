import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: vi.fn() }));

vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => ({
    childContext: () => undefined,
    log: mocks.log,
    step: (_name: string, task: () => unknown) => task(),
  }),
}));
vi.mock("@/lib/sdp-api", () => ({ createSdpApiClient: async () => ({}) }));

import { withDashboardPageTrace } from "./dashboard-page-trace";

describe("withDashboardPageTrace", () => {
  beforeEach(() => {
    mocks.log.mockClear();
  });

  it("lets a redirect through without logging a failed page", async () => {
    await expect(
      withDashboardPageTrace("page.test", async () => redirect("/dashboard"))
    ).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;/) });

    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("logs a thrown failure before rethrowing it", async () => {
    await expect(
      withDashboardPageTrace("page.test", async () => {
        throw new Error("upstream down");
      })
    ).rejects.toThrow("upstream down");

    expect(mocks.log).toHaveBeenCalledExactlyOnceWith({ ok: false, error: "upstream down" });
  });
});
