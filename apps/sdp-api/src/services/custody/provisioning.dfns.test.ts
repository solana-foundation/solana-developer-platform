import type { Env } from "@/types/env";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createDfnsApiClientMock } = vi.hoisted(() => ({
  createDfnsApiClientMock: vi.fn(),
}));
const testAddressOne = "1".repeat(32);
const testAddressTwo = "2".repeat(32);
const testAddressThree = "3".repeat(32);

vi.mock("@/services/dfns/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/services/dfns/client")>("@/services/dfns/client");
  return {
    ...actual,
    createDfnsApiClient: createDfnsApiClientMock,
  };
});

import { provisionDfnsWallet } from "@/services/custody/provisioning";

describe("dfns wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the created wallet when DFNS responds with JSON", async () => {
    const client = createMockDfnsClient();
    client.wallets.createWallet.mockResolvedValue({
      id: "wal_123",
      address: testAddressOne,
      network: "SolanaDevnet",
      signingKey: { id: "key_123" },
    });
    createDfnsApiClientMock.mockResolvedValue(client);

    const result = await provisionDfnsWallet(createDfnsEnv(), {
      orgId: "org_123",
      orgSlug: "acme",
    });

    expect(result).toEqual({
      walletId: "wal_123",
      address: testAddressOne,
      network: "SolanaDevnet",
      signingKeyId: "key_123",
    });
    expect(client.wallets.createWallet).toHaveBeenCalledWith({
      body: expect.objectContaining({
        name: "sdp-acme",
        network: "SolanaDevnet",
      }),
    });
  });

  it("recovers a newly-created wallet when DFNS create returns a non-JSON parse error", async () => {
    const client = createMockDfnsClient();
    client.wallets.createWallet.mockRejectedValue(
      new Error(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)
    );
    client.wallets.listWallets.mockResolvedValue({
      items: [
        {
          id: "wal_recovered",
          address: testAddressTwo,
          network: "SolanaDevnet",
          signingKey: { id: "key_456" },
          name: "sdp-acme",
          dateCreated: new Date().toISOString(),
        },
      ],
      nextPageToken: undefined,
    });
    createDfnsApiClientMock.mockResolvedValue(client);

    const result = await provisionDfnsWallet(createDfnsEnv(), {
      orgId: "org_123",
      orgSlug: "acme",
    });

    expect(result).toEqual({
      walletId: "wal_recovered",
      address: testAddressTwo,
      network: "SolanaDevnet",
      signingKeyId: "key_456",
    });
  });

  it("throws an actionable error when non-JSON DFNS responses cannot be recovered", async () => {
    vi.useFakeTimers();

    const client = createMockDfnsClient();
    client.wallets.createWallet.mockRejectedValue(
      new Error(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)
    );
    client.wallets.listWallets.mockResolvedValue({
      items: [],
      nextPageToken: undefined,
    });
    createDfnsApiClientMock.mockResolvedValue(client);

    const pending = provisionDfnsWallet(createDfnsEnv(), {
      orgId: "org_123",
      orgSlug: "acme",
    });
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toThrowError(/DFNS returned a non-JSON response/i);
  });

  it("does not recover an unrelated wallet when name does not match", async () => {
    vi.useFakeTimers();

    const client = createMockDfnsClient();
    client.wallets.createWallet.mockRejectedValue(
      new Error(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)
    );
    client.wallets.listWallets.mockResolvedValue({
      items: [
        {
          id: "wal_unrelated",
          address: testAddressThree,
          network: "SolanaDevnet",
          signingKey: { id: "key_789" },
          name: "different-wallet-name",
          dateCreated: new Date().toISOString(),
        },
      ],
      nextPageToken: undefined,
    });
    createDfnsApiClientMock.mockResolvedValue(client);

    const pending = provisionDfnsWallet(createDfnsEnv(), {
      orgId: "org_123",
      orgSlug: "acme",
    });
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toThrowError(
      /automatic recovery could not find a newly created wallet/i
    );
  });
});

function createDfnsEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    DFNS_NETWORK: "SolanaDevnet",
    DFNS_AUTH_TOKEN: "test-dfns-auth-token",
    DFNS_API_BASE_URL: "https://api.dfns.io",
    ...overrides,
  } as Env;
}

function createMockDfnsClient() {
  return {
    wallets: {
      createWallet: vi.fn(),
      getWallet: vi.fn(),
      listWallets: vi.fn(),
    },
  };
}
