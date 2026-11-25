import { provisionAnchorageWallet as provisionAnchorageWalletInCustody } from "@sdp/custody/providers/anchorage/provisioning";
import type { CustodyProvisioningRuntime } from "@sdp/custody/shared/runtime";
import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionAnchorageWallet } from "@/services/custody/provisioning";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { required } from "@/test/helpers/required";
import type { Env } from "@/types/env";

describe("anchorage wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["sandbox", "solana-devnet"],
    ["production", "solana"],
  ] as const)("creates the %s wallet on the Anchorage %s network", async (environment, network) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({ walletId: "wa_anch_env", address: syntheticAddress(1) }, 200)
      );

    await runInClusterScope({ projectId: null, environment }, () =>
      provisionAnchorageWallet(createAnchorageEnv(), { walletLabel: "Treasury" })
    );

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.anchorage.com/v1/wallets",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = required(fetchMock.mock.calls[0]);
    expect(JSON.parse(String(required(init).body))).toEqual({ network, label: "Treasury" });
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

    const result = await inSandboxScope(() => provisionAnchorageWallet(createAnchorageEnv(), {}));

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
        { cluster: "devnet", apiKey: "anchorage-explicit-key" },
        {}
      )
    ).resolves.toEqual({ walletId: "wa_anch_4", address: syntheticAddress(4) });
  });
});

function createAnchorageEnv(): Env {
  return { ...env, ANCHORAGE_API_KEY: "anchorage-test-key" };
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
