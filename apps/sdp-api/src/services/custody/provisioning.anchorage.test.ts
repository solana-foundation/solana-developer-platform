import {
  type CustodyProvisioningRuntime,
  provisionAnchorageWallet as provisionAnchorageWalletInCustody,
} from "@sdp/custody/provisioning";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionAnchorageWallet } from "@/services/custody/provisioning";
import type { Env } from "@/types/env";

describe("anchorage wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Api-Key authentication by default", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ walletId: "wa_anch_1", address: "anch_address_1" }, 200));

    await provisionAnchorageWallet(createAnchorageEnv(), {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = toHeaderRecord(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers["Api-Key"]).toBe("anchorage-test-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("uses only the server-configured Anchorage endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ walletId: "wa_anch_env", address: "anch_env" }, 200));

    await provisionAnchorageWallet(
      createAnchorageEnv({
        ANCHORAGE_API_BASE_URL: "https://trusted.anchorage.test",
      }),
      {}
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://trusted.anchorage.test/v1/wallets",
      expect.objectContaining({ method: "POST" })
    );
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

    const result = await provisionAnchorageWallet(createAnchorageEnv(), {});

    expect(result.walletId).toBe("wa_anch_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts explicit configuration and runtime dependencies", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ walletId: "wa_anch_3", address: "anch_address_3" }, 200));

    const result = await provisionAnchorageWalletInCustody(
      createRuntime(fetchMock),
      {
        apiKey: "anchorage-explicit-key",
        apiBaseUrl: "https://anchorage.example.test",
      },
      {}
    );

    expect(result).toEqual({ walletId: "wa_anch_3", address: "anch_address_3" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://anchorage.example.test/v1/wallets",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("trims wallet fields returned by Anchorage", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse({ walletId: " wa_anch_4 ", address: " anch_address_4 " }, 200)
      );

    await expect(
      provisionAnchorageWalletInCustody(
        createRuntime(fetchMock),
        { apiKey: "anchorage-explicit-key" },
        {}
      )
    ).resolves.toEqual({ walletId: "wa_anch_4", address: "anch_address_4" });
  });
});

function createAnchorageEnv(overrides?: Partial<Env>): Env {
  return {
    DB: {} as DatabaseClient,
    ENVIRONMENT: "development",
    API_VERSION: "v1",
    CUSTODY_ENCRYPTION_KEY: "unused",
    ANCHORAGE_API_KEY: "anchorage-test-key",
    ...overrides,
  } as Env;
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

function createRuntime(fetch: typeof globalThis.fetch): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => undefined,
    now: () => 0,
    randomUUID: () => "test-uuid",
    getRandomValues: (values) => values,
    sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}
