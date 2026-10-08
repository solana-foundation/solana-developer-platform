import { beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";
import { initializeCustodySetupAction } from "./actions";

const fetchMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
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
    setPageRequest(`/dashboard/${SANDBOX_PROJECT.id}/wallets/setup`);
  });

  it("refuses to repair when the submitted provider has no active config", async () => {
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
              defaultWalletId: "wal_privy_root",
              publicKey: "PrivyRootPublicKey11111111111111111111111111",
              status: "active",
            },
          ],
        };
      }
      throw new Error(`unexpected call: ${path}`);
    });

    const result = await initializeCustodySetupAction(form("local"));

    expect(result.status).toBe("error");
    const walletPosts = fetchMock.mock.calls.filter(([path]) => path === "/v1/wallets");
    expect(walletPosts).toHaveLength(0);
  });

  it("repairs the provider's config that has no wallet yet, naming the provider", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/initialize") {
        throw ALREADY_INITIALIZED;
      }
      if (path === "/v1/wallets/configs") {
        return {
          configs: [
            {
              id: "cfg_local",
              provider: "local",
              defaultWalletId: "wal_local_root",
              publicKey: "LocalRootPublicKey1111111111111111111111111",
              status: "active",
            },
            {
              id: "cfg_privy",
              provider: "privy",
              defaultWalletId: null,
              publicKey: "PrivyRootPublicKey11111111111111111111111111",
              status: "active",
            },
          ],
        };
      }
      if (path === "/v1/wallets") {
        return { wallet: { walletId: "wal_repaired", publicKey: "RepairedKey" } };
      }
      throw new Error(`unexpected call: ${path}`);
    });

    const result = await initializeCustodySetupAction(form("privy"));

    expect(result.status).toBe("success");
    const walletPosts = fetchMock.mock.calls.filter(([path]) => path === "/v1/wallets");
    expect(walletPosts).toHaveLength(1);
    expect(JSON.parse(String(walletPosts[0]?.[1]?.body))).toEqual({
      provider: "privy",
      label: "Default wallet",
      purpose: "root",
    });
  });

  it("ignores an archived config of the same provider", async () => {
    fetchMock.mockImplementation(async (path: string) => {
      if (path === "/v1/wallets/initialize") {
        throw ALREADY_INITIALIZED;
      }
      if (path === "/v1/wallets/configs") {
        return {
          configs: [
            {
              id: "cfg_privy_old",
              provider: "privy",
              defaultWalletId: "wal_old",
              publicKey: "OldKey",
              status: "archived",
            },
          ],
        };
      }
      throw new Error(`unexpected call: ${path}`);
    });

    const result = await initializeCustodySetupAction(form("privy"));

    expect(result.status).toBe("error");
    const walletPosts = fetchMock.mock.calls.filter(([path]) => path === "/v1/wallets");
    expect(walletPosts).toHaveLength(0);
  });

  it("accepts an already-provisioned config for the same provider", async () => {
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
              defaultWalletId: "wal_done",
              publicKey: "DoneKey",
              status: "active",
            },
          ],
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
