import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProvisionAnchorageConfig } from "./provisioning.anchorage";
import { provisionAnchorageWallet } from "./provisioning.anchorage";

describe("anchorage wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Api-Key authentication by default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ walletId: "wa_anch_1", address: "anch_address_1" }, 200));

    await provisionAnchorageWallet(createAnchorageConfig());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = toHeaderRecord(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers["Api-Key"]).toBe("anchorage-test-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("falls back to Bearer auth when Api-Key auth is rejected", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
        const attempt = fetchMock.mock.calls.length;
        const headers = toHeaderRecord(init?.headers);

        if (attempt === 1) {
          expect(headers["Api-Key"]).toBe("anchorage-test-key");
          expect(headers.Authorization).toBeUndefined();
          return new Response("unauthorized", { status: 401 });
        }

        expect(headers["Api-Key"]).toBeUndefined();
        expect(headers.Authorization).toBe("Bearer anchorage-test-key");
        return jsonResponse({ walletId: "wa_anch_2", address: "anch_address_2" }, 200);
      });

    const result = await provisionAnchorageWallet(createAnchorageConfig());

    expect(result.walletId).toBe("wa_anch_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function createAnchorageConfig(
  overrides: Partial<ProvisionAnchorageConfig> = {}
): ProvisionAnchorageConfig {
  return {
    apiKey: "anchorage-test-key",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers as Record<string, string>;
}
