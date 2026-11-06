import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPrivyCredentialAccepted,
  checkPrivyCredential,
} from "@/services/custody/privy-credential";

describe("checkPrivyCredential", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts an empty app without triggering the Privy limit=1 failure", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        new URL(String(input)).searchParams.get("limit") === "1"
          ? jsonResponse({ error: "Unable to process request" }, 500)
          : jsonResponse({ data: [] }, 200)
      );

    await expect(
      checkPrivyCredential(
        { PRIVY_API_BASE_URL: "https://privy.example.test/v1/" },
        { appId: "app-123", appSecret: "secret" }
      )
    ).resolves.toBe("success");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("https://privy.example.test/v1/wallets", {
      method: "GET",
      headers: {
        // Base64 of dummy test credentials "app-123:secret"; fetch is mocked.
        Authorization: "Basic YXBwLTEyMzpzZWNyZXQ=",
        "privy-app-id": "app-123",
      },
      signal: expect.any(AbortSignal),
    });
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

  it.each([
    [
      "failed",
      "Privy's invalid app credentials code",
      () => jsonResponse({ code: "missing_or_invalid_privy_app_id" }, 400),
    ],
    ["retry_unknown", "another Privy code", () => jsonResponse({ code: "invalid_data" }, 400)],
    ["retry_unknown", "a body without a code", () => jsonResponse({ error: "bad request" }, 400)],
    ["retry_unknown", "a non-JSON body", () => new Response("Bad Request", { status: 400 })],
  ])("classifies a 400 as %s for %s", async (expected, _case, response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());

    await expect(checkPrivyCredential({}, { appId: "app-123", appSecret: "secret" })).resolves.toBe(
      expected
    );
  });
});

describe("assertPrivyCredentialAccepted", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when Privy accepts the credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ data: [] }, 200));

    await expect(
      assertPrivyCredentialAccepted({}, { appId: "app-123", appSecret: "secret" })
    ).resolves.toBeUndefined();
  });

  it("refuses credentials Privy rejects as invalid", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ code: "missing_or_invalid_privy_app_id" }, 400)
    );

    await expect(
      assertPrivyCredentialAccepted({}, { appId: "app-123", appSecret: "secret" })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
      message:
        "The provider rejected these credentials. Check the credential fields, then connect again.",
      details: { reason: "invalid_credentials" },
    });
  });

  it.each([
    ["a provider failure", () => Promise.resolve(jsonResponse({ error: "unavailable" }, 503))],
    ["a transport failure", () => Promise.reject(new Error("network failure"))],
  ])("refuses credentials Privy did not confirm after %s", async (_case, outcome) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(outcome);

    await expect(
      assertPrivyCredentialAccepted({}, { appId: "app-123", appSecret: "secret" })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "BAD_REQUEST",
      message: "Privy did not confirm these credentials, so nothing was saved. Try again.",
      details: { reason: "provider_unconfirmed" },
    });
  });
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
