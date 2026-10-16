import { describe, expect, it } from "vitest";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchApiKeyAuthoringWallets, fetchApiKeyForAuthoring } from "./api-key-authoring.data";

const WALLET = {
  id: "wallet_a",
  walletId: "wallet_a",
  publicKey: "So11111111111111111111111111111111111111112",
  label: "Treasury",
  custodyConfigId: "cfg_1",
  isRuntimeExecutionAllowed: true,
};

/** An API client that answers every request with one response and records the paths. */
function clientAnswering(respond: (path: string) => Response) {
  const paths: string[] = [];
  const client: SdpApiClient = {
    request: async (path) => {
      paths.push(path);
      return respond(path);
    },
    fetch: async () => {
      throw new Error("The authoring loaders read through `request`.");
    },
  };
  return { client, paths };
}

describe("fetchApiKeyAuthoringWallets", () => {
  it("returns the wallets and reads nothing about wallet controls", async () => {
    const { client, paths } = clientAnswering(() => Response.json({ data: { wallets: [WALLET] } }));

    await expect(fetchApiKeyAuthoringWallets(client)).resolves.toEqual([WALLET]);
    expect(paths.filter((path) => path.includes("/policies"))).toEqual([]);
  });
});

describe("fetchApiKeyForAuthoring", () => {
  it("returns the key with its allowed operations", async () => {
    const key = { id: "key_1", name: "Payouts", allowedOperations: ["payment", "ramp"] };
    const { client, paths } = clientAnswering(() => Response.json({ data: key }));

    await expect(fetchApiKeyForAuthoring(client, "key_1")).resolves.toEqual(key);
    expect(paths).toEqual(["/v1/api-keys/key_1"]);
  });

  it("returns null for a key that does not exist", async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 404 }));

    await expect(fetchApiKeyForAuthoring(client, "missing")).resolves.toBeNull();
  });

  it("fails loudly on any other error", async () => {
    const { client } = clientAnswering(() => new Response(null, { status: 500 }));

    await expect(fetchApiKeyForAuthoring(client, "key_1")).rejects.toThrow(
      "Unable to load API key (500)"
    );
  });
});
