import { provisionAnchorageWallet as provisionAnchorageWalletInCustody } from "@sdp/custody/providers/anchorage/provisioning";
import type { CustodyProvisioningRuntime } from "@sdp/custody/shared/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionAnchorageWallet } from "@/services/custody/provisioning";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import type { Env } from "@/types/env";

describe("anchorage wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses only the server-configured Anchorage endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ walletId: "wa_anch_env", address: syntheticAddress(1) }, 200)
      );

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
        const headers = new Headers(init?.headers);

        if (attempt === 1) {
          expect(headers.get("Api-Key")).toBe("anchorage-test-key");
          expect(headers.get("Authorization")).toBeNull();
          return new Response("unauthorized", { status: 401 });
        }

        expect(headers.get("Api-Key")).toBeNull();
        expect(headers.get("Authorization")).toBe("Bearer anchorage-test-key");
        return jsonResponse({ walletId: "wa_anch_2", address: syntheticAddress(2) }, 200);
      });

    const result = await provisionAnchorageWallet(createAnchorageEnv(), {});

    expect(result).toEqual({ walletId: "wa_anch_2", address: syntheticAddress(2) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("trims wallet fields returned by Anchorage", async () => {
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        jsonResponse({ walletId: " wa_anch_4 ", address: ` ${syntheticAddress(4)} ` }, 200)
      );

    await expect(
      provisionAnchorageWalletInCustody(
        createRuntime(fetchMock),
        { apiKey: "anchorage-explicit-key" },
        {}
      )
    ).resolves.toEqual({ walletId: "wa_anch_4", address: syntheticAddress(4) });
  });
});

function createAnchorageEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ANCHORAGE_API_KEY: "anchorage-test-key", ...overrides };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createRuntime(fetch: typeof globalThis.fetch): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => undefined,
    now: () => 0,
  };
}
