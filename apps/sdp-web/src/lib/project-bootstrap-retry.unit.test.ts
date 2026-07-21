import { describe, expect, it, vi } from "vitest";
import { retryProjectBootstrap } from "./project-bootstrap-retry";

describe("retryProjectBootstrap", () => {
  it("keeps waiting through missing and failed project loads", async () => {
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("organization is not linked"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["prj_sandbox"]);
    const wait = vi.fn(async () => undefined);

    await expect(
      retryProjectBootstrap({
        load,
        isReady: (projects) => projects.length > 0,
        delaysMs: [0, 250, 500],
        wait,
      })
    ).resolves.toEqual(["prj_sandbox"]);
    expect(load).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("returns null after the full loading window expires", async () => {
    const load = vi.fn(async () => [] as string[]);

    await expect(
      retryProjectBootstrap({
        load,
        isReady: (projects) => projects.length > 0,
        delaysMs: [0, 1],
        wait: async () => undefined,
      })
    ).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
