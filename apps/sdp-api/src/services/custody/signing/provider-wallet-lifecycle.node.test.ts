import * as dfnsClient from "@sdp/custody/providers/dfns/client";
import { runInClusterScope } from "@sdp/rpc/scope";
import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { createProviderWallet } from "@/services/custody/signing/provider-wallet-lifecycle";
import { inSandboxScope } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";

const { address: CREATED_WALLET_ADDRESS } = await generateKeyPairSigner();

function notCalledWhenCreating(): Promise<never> {
  return Promise.reject(new Error("Wallet creation calls only wallets.createWallet"));
}

function stubWalletClient(create: "createDfnsApiClient" | "createIbmHavenApiClient") {
  const createWallet = vi
    .fn<dfnsClient.DfnsApiClient["wallets"]["createWallet"]>()
    .mockResolvedValue({ id: "wa-12345-abcde-newdfnswallet", address: CREATED_WALLET_ADDRESS });
  vi.spyOn(dfnsClient, create).mockResolvedValue({
    wallets: { getWallet: notCalledWhenCreating, listWallets: notCalledWhenCreating, createWallet },
    keySignatures: { createSignature: notCalledWhenCreating, getSignature: notCalledWhenCreating },
  });
  return createWallet;
}

afterEach(() => vi.restoreAllMocks());

describe("createProviderWallet", () => {
  it("creates additional DFNS wallets on the scope's cluster without reusing the configured signing key", async () => {
    const createWallet = stubWalletClient("createDfnsApiClient");

    const wallet = await runInClusterScope({ projectId: null, environment: "production" }, () =>
      createProviderWallet({
        env,
        orgId: "org_dfns",
        projectId: "project_dfns",
        params: { label: "DFNS treasury" },
        parsed: {
          provider: "dfns",
          walletId: "wa-12345-abcde-rootwallet",
          signingKeyId: "key-12345-abcde-rootwallet",
        },
      })
    );

    expect(dfnsClient.createDfnsApiClient).toHaveBeenCalledExactlyOnceWith(env, "mainnet-beta");
    expect(createWallet).toHaveBeenCalledExactlyOnceWith({ body: { name: "DFNS treasury" } });
    expect(wallet).toEqual({
      walletId: "dfns_wa-12345-abcde-newdfnswallet",
      publicKey: CREATED_WALLET_ADDRESS,
    });
  });

  it("creates additional IBM Digital Asset Haven wallets with the ibmhaven_ prefix", async () => {
    const createWallet = stubWalletClient("createIbmHavenApiClient");

    const wallet = await inSandboxScope(() =>
      createProviderWallet({
        env,
        orgId: "org_ibm_haven",
        projectId: "project_ibm_haven",
        params: { label: "Haven treasury" },
        parsed: {
          provider: "ibm_haven",
          walletId: "wa-12345-abcde-rootwallet",
          signingKeyId: "key-12345-abcde-rootwallet",
        },
      })
    );

    expect(dfnsClient.createIbmHavenApiClient).toHaveBeenCalledExactlyOnceWith(env, "devnet");
    expect(createWallet).toHaveBeenCalledExactlyOnceWith({ body: { name: "Haven treasury" } });
    expect(wallet).toEqual({
      walletId: "ibmhaven_wa-12345-abcde-newdfnswallet",
      publicKey: CREATED_WALLET_ADDRESS,
    });
  });

  describe("a keyed create's request id", () => {
    const REQUEST_ID = "6f1f4de5-930e-4c4c-a99f-30d46c3c5ceb";

    it("reaches Privy as its idempotency key and external id, the same on every attempt", async () => {
      const provision = vi.spyOn(custodyProvisioning, "provisionPrivyWallet").mockResolvedValue({
        walletId: "privy_wallet",
        address: CREATED_WALLET_ADDRESS,
      });
      const context = {
        env,
        orgId: "org_privy",
        projectId: "project_privy",
        params: { requestId: REQUEST_ID },
        parsed: { provider: "privy" as const },
      };

      await createProviderWallet(context);
      await createProviderWallet(context);

      const expected = {
        externalId: "sdp_cw_6f1f4de5-930e-4c4c-a99f-30d46c3c5ceb",
        idempotencyKey: REQUEST_ID,
      };
      expect(provision.mock.calls).toEqual([
        [env, expected],
        [env, expected],
      ]);
    });

    it("reaches Coinbase CDP as its idempotency key and account seed, reusing the account", async () => {
      const provision = vi
        .spyOn(custodyProvisioning, "provisionCoinbaseCdpAccount")
        .mockResolvedValue({ address: CREATED_WALLET_ADDRESS });
      const context = {
        env,
        orgId: "org_cdp",
        projectId: "project_cdp",
        params: { requestId: REQUEST_ID },
        parsed: { provider: "coinbase_cdp" as const },
      };

      await createProviderWallet(context);
      await createProviderWallet(context);

      const expected = expect.objectContaining({
        walletSeed: REQUEST_ID,
        idempotencyKey: REQUEST_ID,
        reuseExisting: true,
      });
      expect(provision.mock.calls).toEqual([
        [env, expected],
        [env, expected],
      ]);
    });

    it("is absent from an unkeyed create, which gets a fresh Coinbase CDP account", async () => {
      const provisionCdp = vi
        .spyOn(custodyProvisioning, "provisionCoinbaseCdpAccount")
        .mockResolvedValue({ address: CREATED_WALLET_ADDRESS });
      const provisionPrivy = vi
        .spyOn(custodyProvisioning, "provisionPrivyWallet")
        .mockResolvedValue({ walletId: "privy_wallet", address: CREATED_WALLET_ADDRESS });

      await createProviderWallet({
        env,
        orgId: "org_cdp",
        projectId: "project_cdp",
        params: {},
        parsed: { provider: "coinbase_cdp" },
      });
      await createProviderWallet({
        env,
        orgId: "org_privy",
        projectId: "project_privy",
        params: {},
        parsed: { provider: "privy" },
      });

      // No request id: CDP gets a fresh idempotency key, and a name collision fails.
      const [, cdpOptions] = required(provisionCdp.mock.calls[0]);
      expect(required(cdpOptions).idempotencyKey).toBeUndefined();
      expect(required(cdpOptions).reuseExisting).toBe(false);
      expect(provisionPrivy).toHaveBeenCalledExactlyOnceWith(env, {});
    });
  });
});
