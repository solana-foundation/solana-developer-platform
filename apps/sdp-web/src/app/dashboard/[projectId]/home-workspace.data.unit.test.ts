import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHomeVolume } from "./home-workspace.data";

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchHomeVolume", () => {
  it("returns the route's volume", async () => {
    respond(200, { data: { todaysVolume: 125, todaysVolumeError: null } });

    await expect(fetchHomeVolume()).resolves.toEqual({
      todaysVolume: 125,
      todaysVolumeError: null,
    });
  });

  // A body without the fields is a broken answer, not a day with no volume.
  it("rejects a malformed body instead of reading it as no volume", async () => {
    respond(200, { data: {} });

    await expect(fetchHomeVolume()).rejects.toThrow();
  });

  it("surfaces the route's error message", async () => {
    respond(500, { error: "client unavailable" });

    await expect(fetchHomeVolume()).rejects.toThrow("client unavailable");
  });
});
