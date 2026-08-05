import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitPrivyCredentialAction } from "./byok-actions";

const fetchMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ fetch: fetchMock, request: vi.fn() }),
}));

function form(): FormData {
  const data = new FormData();
  data.set("idempotencyKey", "key-1");
  data.set("credentialLabel", "Privy credential");
  data.set("scope", "organization");
  data.set("appId", "app_1");
  data.set("appSecret", "shh");
  return data;
}

describe("submitPrivyCredentialAction outcome classification", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("treats any answered HTTP error as terminal, never as replayable", async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(
        'SDP API request failed (409): {"error":{"message":"Privy custody setup already exists"}}'
      )
    );

    const result = await submitPrivyCredentialAction(form());
    // A definitive conflict must not enter the frozen-replay loop.
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.message).toContain("already exists");
    }
  });

  it("keeps a response-less failure in the unknown, replayable state", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed: socket hang up"));

    const result = await submitPrivyCredentialAction(form());
    expect(result.status).toBe("error");
  });
});
