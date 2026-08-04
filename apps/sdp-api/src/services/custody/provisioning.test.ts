import { provisionUtilaWallet as provisionUtilaWalletInCustody } from "@sdp/custody/provisioning";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  provisionCoinbaseCdpAccount,
  provisionParaWallet,
  provisionPrivyWallet,
  provisionUtilaWallet,
} from "@/services/custody/provisioning";
import type { Env } from "@/types/env";

const CREATED_ADDRESS = "11111111111111111111111111111111";
const EXISTING_ADDRESS = "22222222222222222222222222222222";

let keyMaterial: {
  privateKeyPem: string;
  privateKeyPkcs8Base64: string;
};
let utilaPrivateKeyPem: string;

beforeAll(async () => {
  keyMaterial = await createEs256KeyMaterial();
  utilaPrivateKeyPem = await createRsaPrivateKeyPem();
});

describe("coinbase account provisioning", () => {
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
          expect(body.name).toBe("sdp-production-acme-labs");

          return jsonResponse({ address: CREATED_ADDRESS }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionCoinbaseCdpAccount(
      createCoinbaseEnv({
        ENVIRONMENT: "production",
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

  it("reads data.address when resolving an already-created account by name", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          return jsonResponse({ errorType: "already_exists" }, 409);
        }

        if (url.includes("/platform/v2/solana/accounts/by-name/") && init?.method === "GET") {
          return jsonResponse({ data: { address: EXISTING_ADDRESS } }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionCoinbaseCdpAccount(createCoinbaseEnv(), {
      orgId: "org_abc",
      orgSlug: "Acme Labs",
    });

    expect(result.address).toBe(EXISTING_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when by-name lookup succeeds but does not contain an address", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          return jsonResponse({ errorType: "already_exists" }, 409);
        }

        if (url.includes("/platform/v2/solana/accounts/by-name/") && init?.method === "GET") {
          return jsonResponse({ data: {} }, 200);
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

describe("privy wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses a wallet found by external ID before creating one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(privyWalletResponse());

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-existing",
      address: EXISTING_ADDRESS,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(toUrlString(fetchMock.mock.calls[0]?.[0] as string | URL | Request)).toBe(
      "https://privy.test/v1/wallets/ext_wal_sdp_connection_123"
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates a wallet with stable external and idempotency IDs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(
        privyWalletResponse({ id: "wallet-created", address: CREATED_ADDRESS })
      );

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-created",
      address: CREATED_ADDRESS,
    });

    const createRequest = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(createRequest?.body))).toEqual({
      chain_type: "solana",
      external_id: "sdp_connection_123",
    });
    expect(new Headers(createRequest?.headers).get("privy-idempotency-key")).toBe("credential-456");
  });

  it("reconciles by external ID after an ambiguous create outcome", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(privyWalletResponse({ id: "wallet-reconciled" }));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-reconciled",
      address: EXISTING_ADDRESS,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("reconciles the unique external ID when create reports it already exists", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(jsonResponse({ error: "external_id already exists" }, 409))
      .mockResolvedValueOnce(privyWalletResponse({ id: "wallet-reconciled" }));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-reconciled",
      address: EXISTING_ADDRESS,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("fails closed when a duplicate external ID remains unavailable to lookup", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(jsonResponse({ error: "external_id already exists" }, 409))
      .mockResolvedValueOnce(privyWalletNotFound());

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("surfaces a deterministic conflict found during reconciliation", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(jsonResponse({ error: "rejected" }, 500))
      .mockResolvedValueOnce(privyWalletResponse({ archived_at: Date.now() }));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("requires external and idempotency IDs together", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      provisionTestPrivyWallet({ externalId: "sdp_connection_123" })
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed wallet", {}, "NETWORK_ERROR"],
    [
      "a wallet without an external ID",
      { ...PRIVY_WALLET, external_id: undefined },
      "NETWORK_ERROR",
    ],
    ["a wallet without a chain", { ...PRIVY_WALLET, chain_type: undefined }, "NETWORK_ERROR"],
    ["an archived wallet", { ...PRIVY_WALLET, archived_at: 1_725_000_000_000 }, "CONFLICT"],
    ["another external ID", { ...PRIVY_WALLET, external_id: "sdp_connection_other" }, "CONFLICT"],
    ["a non-Solana chain", { ...PRIVY_WALLET, chain_type: "ethereum" }, "CONFLICT"],
  ] as const)("fails closed when external-ID lookup returns %s", async (_case, body, code) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body, 200));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it.each([
    ["an archived wallet", { ...PRIVY_WALLET, archived_at: Date.now() }],
    ["another external ID", { ...PRIVY_WALLET, external_id: "sdp_connection_other" }],
    ["a non-Solana chain", { ...PRIVY_WALLET, chain_type: "ethereum" }],
  ] as const)("rejects a create response containing %s", async (_case, body) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(jsonResponse(body, 200));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an incomplete create response as ambiguous and reconciles once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(jsonResponse({ id: "wallet-created", address: CREATED_ADDRESS }, 200))
      .mockResolvedValueOnce(privyWalletNotFound());

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("classifies a Provider 401 during external-ID lookup as an invalid credential", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ error: "invalid credentials" }, 401));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "PROVIDER_CREDENTIAL_INVALID",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves an ambiguous create outcome when reconciliation returns 401", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(privyWalletNotFound())
      .mockResolvedValueOnce(jsonResponse({ error: "unknown" }, 500))
      .mockResolvedValueOnce(jsonResponse({ error: "invalid credentials" }, 401));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST", "GET"]);
  });

  it.each([
    ["wallet lookup", { walletId: "wallet-existing" }, "GET"],
    ["legacy creation", {}, "POST"],
  ] as const)("preserves %s", async (_case, options, method) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "wallet-existing", address: EXISTING_ADDRESS }, 200));

    await expect(provisionTestPrivyWallet(options)).resolves.toEqual({
      walletId: "wallet-existing",
      address: EXISTING_ADDRESS,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe(method);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it.each([
    [401, "PROVIDER_NOT_CONFIGURED"],
    [400, "PROVIDER_NOT_CONFIGURED"],
    [503, "PROVIDER_NOT_CONFIGURED"],
  ] as const)("preserves legacy HTTP %s create classification as %s", async (status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "rejected" }, status));

    await expect(provisionTestPrivyWallet({})).rejects.toMatchObject({ code });
  });

  it("preserves the legacy malformed create response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 200));

    await expect(
      provisionPrivyWallet(
        createPrivyEnv({
          PRIVY_APP_ID: PRIVY_AUTHENTICATION.appId,
          PRIVY_APP_SECRET: PRIVY_AUTHENTICATION.appSecret,
        }),
        {}
      )
    ).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
      message: "Privy wallet creation failed",
    });
  });
});

describe("utila wallet provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes resource-style vault IDs before creating wallets", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v2/vaults/vault_123/wallets") && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as {
            displayName?: string;
            networks?: string[];
          };
          expect(body.displayName).toBe("Root Wallet");
          expect(body.networks).toEqual(["networks/solana-devnet"]);

          return jsonResponse(
            {
              wallet: {
                name: "vaults/vault_123/wallets/wallet_abc",
                solanaDetails: {
                  address: CREATED_ADDRESS,
                },
              },
            },
            200
          );
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionUtilaWallet(createUtilaEnv(), {
      displayName: "Root Wallet",
    });

    expect(result.walletId).toBe("wallet_abc");
    expect(result.address).toBe(CREATED_ADDRESS);
    expect(result.vaultId).toBe("vault_123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the injected clock for service account JWTs", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse(
        {
          wallet: {
            name: "vaults/vault_123/wallets/wallet_clock",
            solanaDetails: { address: CREATED_ADDRESS },
          },
        },
        200
      )
    );
    const now = 1_725_000_000_000;

    await provisionUtilaWalletInCustody(
      {
        fetch: fetchMock,
        sleep: async () => undefined,
        now: () => now,
        randomUUID: () => "test-uuid",
        getRandomValues: (values) => values,
        sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
      },
      {
        serviceAccountEmail: "service-account@example.com",
        serviceAccountPrivateKeyPem: utilaPrivateKeyPem,
        vaultId: "vaults/vault_123",
        apiBaseUrl: "https://api.utila.io",
      },
      {}
    );

    const authorization = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization");
    expect(authorization).toBeTruthy();
    expect(decodeJwtPayload(authorization?.slice("Bearer ".length) ?? "")).toMatchObject({
      iat: now / 1_000,
      exp: now / 1_000 + 5 * 60,
    });
  });
});

describe("para wallet provisioning", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses only the server-configured Para endpoint", async () => {
    const walletId = "wal_para_env";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);
        expect(url.startsWith("https://trusted.para.test/")).toBe(true);

        if (url.endsWith("/v1/wallets") && init?.method === "POST") {
          return jsonResponse({ data: { id: walletId, status: "creating" } }, 200);
        }

        if (url.endsWith(`/v1/wallets/${walletId}`) && init?.method === "GET") {
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

    await provisionParaWallet(
      createParaEnv({
        PARA_API_BASE_URL: "https://trusted.para.test",
      }),
      {
        orgId: "org_abc",
        orgSlug: "Acme Labs",
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("stops retrying after max transient address-not-found errors", async () => {
    vi.useFakeTimers();

    const walletId = "wal_para_retry_limit";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v1/wallets") && init?.method === "POST") {
          return jsonResponse({ data: { id: walletId, status: "creating" } }, 200);
        }

        if (url.endsWith(`/v1/wallets/${walletId}`) && init?.method === "GET") {
          return jsonResponse({ message: "wallet address not found after 6315ms" }, 500);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const provisionPromise = provisionParaWallet(createParaEnv(), {
      orgId: "org_abc",
      orgSlug: "Acme Labs",
    });

    const resultPromise = expect(provisionPromise).rejects.toThrowError(/Para API error: 500/i);

    await vi.runAllTimersAsync();
    await resultPromise;
    expect(fetchMock).toHaveBeenCalledTimes(9);
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

const PRIVY_AUTHENTICATION = {
  appId: "app-id",
  appSecret: "app-secret",
};
const PRIVY_CREATE_OPTIONS = {
  externalId: "sdp_connection_123",
  idempotencyKey: "credential-456",
};
const PRIVY_WALLET = {
  id: "wallet-existing",
  address: EXISTING_ADDRESS,
  chain_type: "solana",
  external_id: PRIVY_CREATE_OPTIONS.externalId,
};

function createPrivyEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    API_VERSION: "test",
    DATABASE_URL: "postgresql://unused",
    PRIVY_API_BASE_URL: "https://privy.test/v1",
    ...overrides,
  } as Env;
}

function provisionTestPrivyWallet(options: Parameters<typeof provisionPrivyWallet>[1]) {
  return provisionPrivyWallet(createPrivyEnv(), options, PRIVY_AUTHENTICATION);
}

function privyWalletResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({ ...PRIVY_WALLET, ...overrides }, 200);
}

function privyWalletNotFound(): Response {
  return jsonResponse({ error: "not found" }, 404);
}

function createParaEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    PARA_API_KEY: "test-para-api-key",
    PARA_API_BASE_URL: "https://api.getpara.com",
    ...overrides,
  } as Env;
}

function createUtilaEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    SOLANA_NETWORK: "devnet",
    UTILA_SERVICE_ACCOUNT_EMAIL: "service-account@example.com",
    UTILA_SERVICE_ACCOUNT_PRIVATE_KEY: utilaPrivateKeyPem,
    UTILA_VAULT_ID: "vaults/vault_123",
    UTILA_API_BASE_URL: "https://api.utila.io",
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

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as Record<
    string,
    unknown
  >;
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

async function createRsaPrivateKeyPem(): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8Buffer = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const pkcs8 = new Uint8Array(pkcs8Buffer);
  return encodePem("PRIVATE KEY", pkcs8);
}

function encodePem(label: string, bytes: Uint8Array): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}
