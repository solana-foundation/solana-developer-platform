import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderWallet,
  type ProvisionedProviderWallet,
} from "@/services/domain/signing/provider-wallet-lifecycle";
import { env as testEnv } from "@/test/helpers/env";
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

    const wallet = await createDfnsWalletIn("sandbox", env);

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

  it("creates additional DFNS wallets on mainnet inside a production scope", async () => {
    await createDfnsWalletIn("production", testEnv);

    expect(createWalletMock).toHaveBeenCalledExactlyOnceWith({
      body: {
        network: "Solana",
        name: "DFNS treasury",
      },
    });
  });

  it("creates additional IBM Digital Asset Haven wallets with the ibmhaven_ prefix", async () => {
    const env = {
      IBM_HAVEN_API_BASE_URL: "https://trusted.haven.test",
    } as Env;

    const wallet = await runInClusterScope(
      { projectId: "project_ibm_haven", environment: "sandbox" },
      () =>
        createProviderWallet({
          env,
          orgId: "org_ibm_haven",
          projectId: "project_ibm_haven",
          params: {
            label: "Haven treasury",
          },
          parsed: {
            provider: "ibm_haven",
            apiBaseUrl: "https://untrusted.example",
            walletId: "wa-12345-abcde-rootwallet",
            signingKeyId: "key-12345-abcde-rootwallet",
          },
        })
    );

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

function createDfnsWalletIn(
  environment: SdpEnvironment,
  env: Env
): Promise<ProvisionedProviderWallet> {
  return runInClusterScope({ projectId: "project_dfns", environment }, () =>
    createProviderWallet({
      env,
      orgId: "org_dfns",
      projectId: "project_dfns",
      params: {
        label: "DFNS treasury",
      },
      parsed: {
        provider: "dfns",
        apiBaseUrl: "https://untrusted.example",
        walletId: "wa-12345-abcde-rootwallet",
        signingKeyId: "key-12345-abcde-rootwallet",
      },
    })
  );
}
