import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeCustodySetupAction } from "./actions";

const fetchMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ fetch: fetchMock, request: vi.fn() }),
}));

const ALREADY_INITIALIZED = new Error(
  'SDP API request failed (409): {"error":{"message":"Signing already initialized for org"}}'
);

function form(provider: string): FormData {
  const data = new FormData();
  data.set("provider", provider);
  data.set("walletLabel", "Default wallet");
  return data;
}

describe("custody initialization repair guard", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("refuses to repair across providers when another provider owns the default", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/initialize") {
        throw ALREADY_INITIALIZED;
      }
      if (path === "/v1/wallets/configs") {
        return {
          configs: [
            {
              id: "cfg_privy",
              provider: "privy",
              isDefault: true,
              defaultWalletId: "wal_privy_root",
              publicKey: "PrivyRootPublicKey11111111111111111111111111",
              status: "active",
            },
          ],
          defaultConfigId: "cfg_privy",
        };
      }
      throw new Error(`unexpected call: ${path}`);
    });

    const result = await initializeCustodySetupAction(form("local"));

    expect(result.status).toBe("error");
    const walletPosts = fetchMock.mock.calls.filter(([path]) => path === "/v1/wallets");
    expect(walletPosts).toHaveLength(0);
  });

  it("still repairs the same provider's incomplete default", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/initialize") {
        throw ALREADY_INITIALIZED;
      }
      if (path === "/v1/wallets/configs") {
        return {
          configs: [
            {
              id: "cfg_privy",
              provider: "privy",
              isDefault: true,
              defaultWalletId: null,
              publicKey: "PrivyRootPublicKey11111111111111111111111111",
              status: "active",
            },
          ],
          defaultConfigId: "cfg_privy",
        };
      }
      if (path === "/v1/wallets") {
        return { wallet: { walletId: "wal_repaired", publicKey: "RepairedKey" } };
      }
      throw new Error(`unexpected call: ${path}`);
    });

    const result = await initializeCustodySetupAction(form("privy"));

    expect(result.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/wallets",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("accepts an already-complete default for the same provider", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/initialize") {
        throw ALREADY_INITIALIZED;
      }
      if (path === "/v1/wallets/configs") {
        return {
          configs: [
            {
              id: "cfg_privy",
              provider: "privy",
              isDefault: true,
              defaultWalletId: "wal_done",
              publicKey: "DoneKey",
              status: "active",
            },
          ],
          defaultConfigId: "cfg_privy",
        };
      }
      throw new Error(`unexpected call: ${path}`);
    });

    const result = await initializeCustodySetupAction(form("privy"));

    expect(result.status).toBe("success");
    const walletPosts = fetchMock.mock.calls.filter(([path]) => path === "/v1/wallets");
    expect(walletPosts).toHaveLength(0);
  });
});
