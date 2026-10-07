import { describe, expect, it } from "vitest";
import type { SdpApiClient } from "@/lib/sdp-api";
import { fetchApiKeyAuthoringWallets } from "./api-key-authoring.data";

const WALLET = {
  id: "wallet_a",
  walletId: "wallet_a",
  publicKey: "So11111111111111111111111111111111111111112",
  label: "Treasury",
  custodyConfigId: "cfg_1",
  isRuntimeExecutionAllowed: true,
};

/** An API client that serves one wallet and records every path it is asked for. */
function recordingClient() {
  const paths: string[] = [];
  const client: SdpApiClient = {
    request: async (path) => {
      paths.push(path);
      return Response.json({ data: { wallets: [WALLET] } });
    },
    fetch: async <T>(path: string) => {
      paths.push(path);
      // SAFETY: the only `fetch` read here is the wallet policy, whose body this is.
      return { policy: { controlProfile: { status: "active", revisionNumber: 3 } } } as T;
    },
  };
  return { client, paths };
}

describe("fetchApiKeyAuthoringWallets", () => {
  it("reads each wallet's controls when the deployment runs Policies", async () => {
    const { client, paths } = recordingClient();

    await expect(
      fetchApiKeyAuthoringWallets(client, { policiesInReleaseChannel: true })
    ).resolves.toEqual({
      policiesInReleaseChannel: true,
      wallets: [{ ...WALLET, controlStatus: "active", activeRevisionNumber: 3 }],
    });
    expect(paths).toContain("/v1/payments/wallets/wallet_a/policies");
  });

  it("makes no policy read and invents no control status without Policies", async () => {
    const { client, paths } = recordingClient();

    await expect(
      fetchApiKeyAuthoringWallets(client, { policiesInReleaseChannel: false })
    ).resolves.toEqual({ policiesInReleaseChannel: false, wallets: [WALLET] });
    expect(paths.filter((path) => path.includes("/policies"))).toEqual([]);
  });
});
