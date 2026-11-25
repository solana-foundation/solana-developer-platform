import { describe, expect, it, vi } from "vitest";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { testRuntime } from "#/test/runtime";
import { checkPrivyCredential } from "./credential";

const CREDENTIAL = { cluster: "devnet" as const, appId: "app-123", appSecret: "secret" };

function checkAgainst(answer: () => Promise<Response>) {
  return checkPrivyCredential(testRuntime(answer), CREDENTIAL);
}

describe("checkPrivyCredential", () => {
  it("accepts an empty app without triggering the Privy limit=1 failure", async () => {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async (input) =>
      new URL(String(input)).searchParams.get("limit") === "1"
        ? Response.json({ error: "Unable to process request" }, { status: 500 })
        : Response.json({ data: [] })
    );

    await expect(checkPrivyCredential(testRuntime(fetch), CREDENTIAL)).resolves.toBe("success");

    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://api.privy.io/v1/wallets", {
      method: "GET",
      headers: {
        // Base64 of dummy test credentials "app-123:secret"; fetch is stubbed.
        Authorization: "Basic YXBwLTEyMzpzZWNyZXQ=",
        "privy-app-id": "app-123",
      },
      signal: expect.any(AbortSignal),
    });
  });

  it("classifies a 401 response as a conclusive credential failure", async () => {
    await expect(
      checkAgainst(async () => Response.json({ error: "unauthorized" }, { status: 401 }))
    ).resolves.toBe("failed");
  });

  it.each([
    ["rate limit", () => Response.json({ error: "rate limited" }, { status: 429 })],
    ["provider failure", () => Response.json({ error: "unavailable" }, { status: 503 })],
    ["untrusted success body", () => Response.json({ data: {} })],
  ])("keeps %s retryable", async (_case, response) => {
    await expect(checkAgainst(async () => response())).resolves.toBe("retry_unknown");
  });

  it("keeps a transport failure retryable", async () => {
    await expect(
      checkAgainst(async () => {
        throw new Error("network failure");
      })
    ).resolves.toBe("retry_unknown");
  });

  it.each([
    [
      "failed",
      "Privy's invalid app credentials code",
      () => Response.json({ code: "missing_or_invalid_privy_app_id" }, { status: 400 }),
    ],
    [
      "retry_unknown",
      "another Privy code",
      () => Response.json({ code: "invalid_data" }, { status: 400 }),
    ],
    [
      "retry_unknown",
      "a body without a code",
      () => Response.json({ error: "bad request" }, { status: 400 }),
    ],
    ["retry_unknown", "a non-JSON body", () => new Response("Bad Request", { status: 400 })],
  ])("classifies a 400 as %s for %s", async (expected, _case, response) => {
    await expect(checkAgainst(async () => response())).resolves.toBe(expected);
  });
});
