import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderWallet } from "@/services/domain/signing/provider-wallet-lifecycle";
import type { Env } from "@/types/env";

const createWalletMock = vi.hoisted(() => vi.fn());
const createDfnsApiClientMock = vi.hoisted(() => vi.fn());
const createIbmHavenApiClientMock = vi.hoisted(() => vi.fn());

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
});
