import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPrivyCredential } from "@/services/custody/privy-credential";

describe("checkPrivyCredential", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates one bounded Privy wallet-list request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: [] }, 200));

    await expect(
      checkPrivyCredential(
        { PRIVY_API_BASE_URL: "https://privy.example.test/v1/" },
        { appId: "app-123", appSecret: "secret" }
      )
    ).resolves.toBe("success");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://privy.example.test/v1/wallets?limit=1&chain_type=solana",
      {
        method: "GET",
        headers: {
          // Base64 of dummy test credentials "app-123:secret"; fetch is mocked.
          Authorization: "Basic YXBwLTEyMzpzZWNyZXQ=",
          "privy-app-id": "app-123",
        },
        signal: expect.any(AbortSignal),
      }
    );
  });

  it("classifies a 401 response as a conclusive credential failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

    await expect(checkPrivyCredential({}, { appId: "app-123", appSecret: "secret" })).resolves.toBe(
      "failed"
    );
  });

  it.each([
    ["rate limit", () => jsonResponse({ error: "rate limited" }, 429)],
    ["provider failure", () => jsonResponse({ error: "unavailable" }, 503)],
    ["untrusted success body", () => jsonResponse({ data: {} }, 200)],
  ])("keeps %s retryable", async (_case, response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());

    await expect(checkPrivyCredential({}, { appId: "app-123", appSecret: "secret" })).resolves.toBe(
      "retry_unknown"
    );
  });

  it("keeps a transport failure retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network failure"));

    await expect(checkPrivyCredential({}, { appId: "app-123", appSecret: "secret" })).resolves.toBe(
      "retry_unknown"
    );
  });
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
