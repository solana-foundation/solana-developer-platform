import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSdpReleaseChannelAgainstApi } from "./release-channel-check";

function apiReporting(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkSdpReleaseChannelAgainstApi", () => {
  const env = { SDP_RELEASE_CHANNEL: "stable", SDP_API_BASE_URL: "http://api.test/" };

  it("matches when the API reports the same release channel", async () => {
    await expect(
      checkSdpReleaseChannelAgainstApi(env, apiReporting({ releaseChannel: "stable" }))
    ).resolves.toEqual({ status: "match", releaseChannel: "stable" });
  });

  it("finds the API through NEXT_PUBLIC_API_BASE_URL like every other dashboard API call", async () => {
    const urls: string[] = [];
    const recording: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ releaseChannel: "stable" }));
    };

    await expect(
      checkSdpReleaseChannelAgainstApi(
        { SDP_RELEASE_CHANNEL: "stable", NEXT_PUBLIC_API_BASE_URL: "http://legacy.test/" },
        recording
      )
    ).resolves.toEqual({ status: "match", releaseChannel: "stable" });
    expect(urls).toEqual(["http://legacy.test/health"]);
  });

  it("logs a mismatch loudly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      checkSdpReleaseChannelAgainstApi(env, apiReporting({ releaseChannel: "experimental" }))
    ).resolves.toEqual({ status: "mismatch", web: "stable", api: "experimental" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("sdp_release_channel_mismatch"));
  });

  it("treats an unreachable or unparseable API as unavailable, not as a match", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      checkSdpReleaseChannelAgainstApi(env, apiReporting({ status: "ok" }))
    ).resolves.toEqual({
      status: "unavailable",
    });
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(checkSdpReleaseChannelAgainstApi(env, down)).resolves.toEqual({
      status: "unavailable",
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("rejects a typo'd web release channel", async () => {
    await expect(
      checkSdpReleaseChannelAgainstApi({ ...env, SDP_RELEASE_CHANNEL: "mainnet" }, apiReporting({}))
    ).rejects.toThrow(/SDP_RELEASE_CHANNEL must be one of/);
  });
});
