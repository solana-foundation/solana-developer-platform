import { describe, expect, it, vi } from "vitest";
import {
  PROXY_PROJECT_BOOTSTRAP_RETRY_DELAYS_MS,
  retryProjectBootstrap,
} from "./project-bootstrap-retry";

describe("retryProjectBootstrap", () => {
  it("keeps waiting through missing and failed project loads", async () => {
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("organization is not linked"), { status: 404 })
      )
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

  it("rethrows permanent failures without waiting", async () => {
    const error = Object.assign(new Error("unauthorized"), { status: 401 });
    const load = vi.fn(async () => Promise.reject(error));
    const wait = vi.fn(async () => undefined);

    await expect(
      retryProjectBootstrap({
        load,
        isReady: () => false,
        delaysMs: [0, 250, 500],
        wait,
      })
    ).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("surfaces a retryable failure when every attempt fails", async () => {
    const error = Object.assign(new Error("service unavailable"), { status: 503 });
    const load = vi.fn(async () => Promise.reject(error));

    await expect(
      retryProjectBootstrap({
        load,
        isReady: () => false,
        delaysMs: [0, 1],
        wait: async () => undefined,
      })
    ).rejects.toBe(error);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps proxy delay below the minimum five-second execution budget", () => {
    const deliberateDelayMs = PROXY_PROJECT_BOOTSTRAP_RETRY_DELAYS_MS.reduce(
      (total, delay) => total + delay,
      0
    );
    expect(deliberateDelayMs).toBeLessThan(5000);
  });
});
