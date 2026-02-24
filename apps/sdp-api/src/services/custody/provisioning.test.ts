import {
  provisionAnchorageWallet,
  provisionCoinbaseCdpAccount,
  provisionParaWallet,
} from "@/services/custody/provisioning";
import type { Env } from "@/types/env";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// biome-ignore lint/nursery/noSecrets: deterministic non-secret Solana test address.
const CREATED_ADDRESS = "11111111111111111111111111111111";
// biome-ignore lint/nursery/noSecrets: deterministic non-secret Solana test address.
const EXISTING_ADDRESS = "22222222222222222222222222222222";

let keyMaterial: {
  privateKeyPem: string;
  privateKeyPkcs8Base64: string;
};

describe("coinbase account provisioning", () => {
  beforeAll(async () => {
    keyMaterial = await createEs256KeyMaterial();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a CDP account using an environment-scoped name", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { name?: string };
          expect(body.name).toBe("sdp-staging-acme-labs");

          return jsonResponse({ address: CREATED_ADDRESS }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionCoinbaseCdpAccount(
      createCoinbaseEnv({
        ENVIRONMENT: "staging",
      }),
      {
        orgId: "org_abc",
        orgSlug: "Acme Labs",
      }
    );

    expect(result.address).toBe(CREATED_ADDRESS);
    expect(result.network).toBe("solana-devnet");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the existing CDP account when create returns already_exists", async () => {
    const expectedName = "sdp-local-acme-labs";
    const expectedByNamePath = `/platform/v2/solana/accounts/by-name/${encodeURIComponent(expectedName)}`;

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          return jsonResponse({ errorType: "already_exists" }, 409);
        }

        if (url.endsWith(expectedByNamePath) && init?.method === "GET") {
          return jsonResponse({ address: EXISTING_ADDRESS, name: expectedName }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionCoinbaseCdpAccount(
      createCoinbaseEnv({
        COINBASE_CDP_ACCOUNT_NAMESPACE: "local",
      }),
      {
        orgId: "org_abc",
        orgSlug: "Acme Labs",
      }
    );

    expect(result.address).toBe(EXISTING_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws an actionable error when by-name lookup fails after already_exists", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          return jsonResponse({ errorType: "already_exists" }, 409);
        }

        if (url.includes("/platform/v2/solana/accounts/by-name/") && init?.method === "GET") {
          return jsonResponse({ errorType: "not_found" }, 404);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    await expect(
      provisionCoinbaseCdpAccount(createCoinbaseEnv(), {
        orgId: "org_abc",
        orgSlug: "Acme Labs",
      })
    ).rejects.toThrowError(/could not be resolved by name/i);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("para wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries transient address-not-ready errors while waiting for wallet readiness", async () => {
    const walletId = "wal_para_123";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v1/wallets") && init?.method === "POST") {
          return jsonResponse({ data: { id: walletId, status: "creating" } }, 200);
        }

        if (url.endsWith(`/v1/wallets/${walletId}`) && init?.method === "GET") {
          if (fetchMock.mock.calls.length === 2) {
            return jsonResponse({ message: "wallet address not found after 6315ms" }, 500);
          }

          return jsonResponse(
            {
              data: {
                id: walletId,
                type: "SOLANA",
                scheme: "ED25519",
                status: "ready",
                address: CREATED_ADDRESS,
              },
            },
            200
          );
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionParaWallet(createParaEnv(), {
      orgId: "org_abc",
      orgSlug: "Acme Labs",
    });

    expect(result.walletId).toBe(walletId);
    expect(result.address).toBe(CREATED_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bubbles non-retryable para errors", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v1/wallets") && init?.method === "POST") {
          return jsonResponse({ message: "invalid request" }, 400);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    await expect(
      provisionParaWallet(createParaEnv(), {
        orgId: "org_abc",
        orgSlug: "Acme Labs",
      })
    ).rejects.toThrowError(/Para API error: 400/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("anchorage wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an Anchorage wallet and returns its deposit address", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v2/vaults/vault_123/wallets") && init?.method === "POST") {
          const headers = new Headers(init.headers);
          const body = JSON.parse(String(init.body ?? "{}")) as {
            networkId?: string;
            subaccountId?: string;
            walletName?: string;
          };

          expect(headers.get("Api-Access-Key")).toBe("anchorage-access-key");
          expect(body.networkId).toBe("SOL");
          expect(body.subaccountId).toBe("sub_123");
          expect(body.walletName).toBe("Treasury");

          return jsonResponse(
            {
              walletId: "wal_anch_123",
              networkId: "SOL",
              walletName: "Treasury",
              depositAddress: {
                address: CREATED_ADDRESS,
              },
            },
            200
          );
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionAnchorageWallet(createAnchorageEnv(), {
      vaultId: "vault_123",
      networkId: "SOL",
      subaccountId: "sub_123",
      walletName: "Treasury",
    });

    expect(result.walletId).toBe("wal_anch_123");
    expect(result.address).toBe(CREATED_ADDRESS);
    expect(result.networkId).toBe("SOL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads an existing Anchorage wallet by walletId", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v2/wallets/wal_existing") && init?.method === "GET") {
          const headers = new Headers(init.headers);
          expect(headers.get("Api-Access-Key")).toBe("anchorage-access-key");

          return jsonResponse(
            {
              walletId: "wal_existing",
              networkId: "SOL",
              depositAddress: {
                address: EXISTING_ADDRESS,
              },
            },
            200
          );
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionAnchorageWallet(createAnchorageEnv(), {
      vaultId: "vault_ignored",
      networkId: "SOL",
      walletId: "wal_existing",
    });

    expect(result.walletId).toBe("wal_existing");
    expect(result.address).toBe(EXISTING_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when Anchorage access key is missing", async () => {
    await expect(
      provisionAnchorageWallet(createAnchorageEnv({ ANCHORAGE_API_ACCESS_KEY: undefined }), {
        vaultId: "vault_123",
        networkId: "SOL",
      })
    ).rejects.toThrowError(/ANCHORAGE_API_ACCESS_KEY/i);
  });
});

function createCoinbaseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    COINBASE_CDP_API_KEY_ID: "test-api-key-id",
    COINBASE_CDP_API_KEY_SECRET: keyMaterial.privateKeyPem,
    COINBASE_CDP_WALLET_SECRET: keyMaterial.privateKeyPkcs8Base64,
    ...overrides,
  } as Env;
}

function createParaEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    PARA_API_KEY: "test-para-api-key",
    PARA_API_BASE_URL: "https://api.getpara.com",
    ...overrides,
  } as Env;
}

function createAnchorageEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    ANCHORAGE_API_BASE_URL: "https://api.anchorage-staging.com/v2",
    ANCHORAGE_API_ACCESS_KEY: "anchorage-access-key",
    ...overrides,
  } as Env;
}

function toUrlString(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function createEs256KeyMaterial(): Promise<{
  privateKeyPem: string;
  privateKeyPkcs8Base64: string;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;

  const pkcs8Buffer = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const pkcs8Bytes = new Uint8Array(pkcs8Buffer);
  const privateKeyPkcs8Base64 = Buffer.from(pkcs8Bytes).toString("base64");
  const pemLines = privateKeyPkcs8Base64.match(/.{1,64}/g)?.join("\n") ?? privateKeyPkcs8Base64;
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${pemLines}\n-----END PRIVATE KEY-----`;

  return {
    privateKeyPem,
    privateKeyPkcs8Base64,
  };
}
