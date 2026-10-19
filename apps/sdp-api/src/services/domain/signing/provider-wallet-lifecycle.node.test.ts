import { beforeEach, describe, expect, it, vi } from "vitest";
import * as custodyProvisioning from "@/services/custody/provisioning";
import {
  createProviderWallet,
  privyWalletExternalId,
} from "@/services/domain/signing/provider-wallet-lifecycle";
import type { Env } from "@/types/env";

const createWalletMock = vi.hoisted(() => vi.fn());
const createDfnsApiClientMock = vi.hoisted(() => vi.fn());
const createIbmHavenApiClientMock = vi.hoisted(() => vi.fn());
const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
const provisionCoinbaseCdpAccountMock = vi.spyOn(
  custodyProvisioning,
  "provisionCoinbaseCdpAccount"
);

vi.mock("@sdp/custody/dfns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/custody/dfns")>();

  return {
    ...actual,
    createDfnsApiClient: createDfnsApiClientMock,
    createIbmHavenApiClient: createIbmHavenApiClientMock,
  };
});

describe("createProviderWallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWalletMock.mockResolvedValue({
      id: "wa-12345-abcde-newdfnswallet",
      address: "DfnsNewWalletPublicKey111111111111111111111",
    });
    createDfnsApiClientMock.mockResolvedValue({
      wallets: {
        createWallet: createWalletMock,
      },
    });
    createIbmHavenApiClientMock.mockResolvedValue({
      wallets: {
        createWallet: createWalletMock,
      },
    });
  });

  it("creates additional DFNS wallets without reusing the configured signing key", async () => {
    const env = {
      DFNS_API_BASE_URL: "https://trusted.dfns.test",
    } as Env;

    const wallet = await createProviderWallet({
      env,
      orgId: "org_dfns",
      projectId: "project_dfns",
      params: {
        label: "DFNS treasury",
      },
      parsed: {
        provider: "dfns",
        apiBaseUrl: "https://untrusted.example",
        network: "SolanaDevnet",
        walletId: "wa-12345-abcde-rootwallet",
        signingKeyId: "key-12345-abcde-rootwallet",
      },
    });

    expect(createDfnsApiClientMock).toHaveBeenCalledWith(env);
    expect(createWalletMock).toHaveBeenCalledWith({
      body: {
        network: "SolanaDevnet",
        name: "DFNS treasury",
      },
    });
    expect(wallet).toEqual({
      walletId: "dfns_wa-12345-abcde-newdfnswallet",
      publicKey: "DfnsNewWalletPublicKey111111111111111111111",
    });
  });

  it("creates additional IBM Digital Asset Haven wallets with the ibmhaven_ prefix", async () => {
    const env = {
      IBM_HAVEN_API_BASE_URL: "https://trusted.haven.test",
    } as Env;

    const wallet = await createProviderWallet({
      env,
      orgId: "org_ibm_haven",
      projectId: "project_ibm_haven",
      params: {
        label: "Haven treasury",
      },
      parsed: {
        provider: "ibm_haven",
        apiBaseUrl: "https://untrusted.example",
        network: "SolanaDevnet",
        walletId: "wa-12345-abcde-rootwallet",
        signingKeyId: "key-12345-abcde-rootwallet",
      },
    });

    expect(createIbmHavenApiClientMock).toHaveBeenCalledWith(env);
    expect(createWalletMock).toHaveBeenCalledWith({
      body: {
        network: "SolanaDevnet",
        name: "Haven treasury",
      },
    });
    expect(wallet).toEqual({
      walletId: "ibmhaven_wa-12345-abcde-newdfnswallet",
      publicKey: "DfnsNewWalletPublicKey111111111111111111111",
    });
  });

  describe("a keyed create's request id", () => {
    const REQUEST_ID = "6f1f4de5-930e-4c4c-a99f-30d46c3c5ceb";

    it("reaches Privy as its idempotency key and external id, the same on every attempt", async () => {
      provisionPrivyWalletMock.mockResolvedValue({
        walletId: "privy_wallet",
        address: "So11111111111111111111111111111111111111112",
      });
      const context = {
        env: {} as Env,
        orgId: "org_privy",
        projectId: "project_privy",
        params: { requestId: REQUEST_ID },
        parsed: { provider: "privy" as const },
      };

      await createProviderWallet(context);
      await createProviderWallet(context);

      const expected = {
        externalId: privyWalletExternalId(REQUEST_ID),
        idempotencyKey: REQUEST_ID,
      };
      expect(provisionPrivyWalletMock).toHaveBeenNthCalledWith(1, context.env, expected);
      expect(provisionPrivyWalletMock).toHaveBeenNthCalledWith(2, context.env, expected);
      expect(expected.externalId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    });

    it("reaches Coinbase CDP as its idempotency key and account seed, reusing the account", async () => {
      provisionCoinbaseCdpAccountMock.mockResolvedValue({
        address: "So11111111111111111111111111111111111111112",
        network: "solana-devnet",
      });
      const context = {
        env: {} as Env,
        orgId: "org_cdp",
        projectId: "project_cdp",
        params: { requestId: REQUEST_ID },
        parsed: { provider: "coinbase_cdp" as const, network: "solana-devnet" as const },
      };

      await createProviderWallet(context);
      await createProviderWallet(context);

      const expected = expect.objectContaining({
        walletSeed: REQUEST_ID,
        idempotencyKey: REQUEST_ID,
        reuseExisting: true,
      });
      expect(provisionCoinbaseCdpAccountMock).toHaveBeenNthCalledWith(1, context.env, expected);
      expect(provisionCoinbaseCdpAccountMock).toHaveBeenNthCalledWith(2, context.env, expected);
    });

    it("is absent from an unkeyed create, which gets a fresh Coinbase CDP account", async () => {
      provisionCoinbaseCdpAccountMock.mockResolvedValue({
        address: "So11111111111111111111111111111111111111112",
        network: "solana-devnet",
      });
      provisionPrivyWalletMock.mockResolvedValue({
        walletId: "privy_wallet",
        address: "So11111111111111111111111111111111111111112",
      });

      await createProviderWallet({
        env: {} as Env,
        orgId: "org_cdp",
        projectId: "project_cdp",
        params: {},
        parsed: { provider: "coinbase_cdp", network: "solana-devnet" },
      });
      await createProviderWallet({
        env: {} as Env,
        orgId: "org_privy",
        projectId: "project_privy",
        params: {},
        parsed: { provider: "privy" },
      });

      const cdpOptions = provisionCoinbaseCdpAccountMock.mock.calls[0]?.[1];
      // No request id: CDP gets a fresh idempotency key, and a name collision fails.
      expect(cdpOptions?.idempotencyKey).toBeUndefined();
      expect(cdpOptions?.reuseExisting).toBe(false);
      expect(provisionPrivyWalletMock).toHaveBeenCalledWith({}, {});
    });
  });
});
