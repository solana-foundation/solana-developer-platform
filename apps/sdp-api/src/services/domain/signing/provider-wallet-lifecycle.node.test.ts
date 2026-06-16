import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderWallet } from "@/services/domain/signing/provider-wallet-lifecycle";
import type { Env } from "@/types/env";

const createWalletMock = vi.hoisted(() => vi.fn());
const createDfnsApiClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/dfns/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/dfns/client")>();

  return {
    ...actual,
    createDfnsApiClient: createDfnsApiClientMock,
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
  });

  it("creates additional DFNS wallets without reusing the configured signing key", async () => {
    const env = {} as Env;

    const wallet = await createProviderWallet({
      env,
      orgId: "org_dfns",
      projectId: "project_dfns",
      params: {
        label: "DFNS treasury",
      },
      parsed: {
        provider: "dfns",
        apiBaseUrl: "https://api.dfns.test",
        network: "SolanaDevnet",
        walletId: "wa-12345-abcde-rootwallet",
        signingKeyId: "key-12345-abcde-rootwallet",
      },
    });

    expect(createDfnsApiClientMock).toHaveBeenCalledWith(env, {
      apiBaseUrl: "https://api.dfns.test",
    });
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
});
