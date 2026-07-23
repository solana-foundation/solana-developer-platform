import { describe, expect, it, vi } from "vitest";
import { GcpMetadataTokenProvider } from "./access-token";

describe("GcpMetadataTokenProvider", () => {
  it("fetches a bearer token from the metadata server", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 })
      );
    const provider = new GcpMetadataTokenProvider({ fetchImpl: fetchMock });

    const token = await provider.getToken();

    expect(token).toBe("tok-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("metadata.google.internal");
    expect((init.headers as Record<string, string>)["Metadata-Flavor"]).toBe("Google");
  });

  it("caches the token until it nears expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: "tok-1", expires_in: 3600 }), { status: 200 })
      );
    const provider = new GcpMetadataTokenProvider({ fetchImpl: fetchMock, now: () => 1000 });

    await provider.getToken();
    await provider.getToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-200 metadata response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    const provider = new GcpMetadataTokenProvider({ fetchImpl: fetchMock });
    await expect(provider.getToken()).rejects.toThrow(/metadata/i);
  });
});
