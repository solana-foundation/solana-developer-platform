import { generateKeyPairSync } from "node:crypto";
import { provisionUtilaWallet as provisionUtilaWalletInCustody } from "@sdp/custody/providers/utila/provisioning";
import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  findPrivyWalletByExternalId,
  provisionCoinbaseCdpAccount,
  provisionParaWallet,
  provisionPrivyWallet,
  provisionUtilaWallet,
} from "@/services/custody/provisioning";
import { env } from "@/test/helpers/env";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { required } from "@/test/helpers/required";
import type { Env } from "@/types/env";

const CREATED_ADDRESS = syntheticAddress(1);
const EXISTING_ADDRESS = syntheticAddress(2);
const requestNameSchema = z.object({ name: z.string() });

const coinbaseKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const keyMaterial = {
  privateKeyPem: coinbaseKey.export({ type: "pkcs8", format: "pem" }).toString(),
  privateKeyPkcs8Base64: coinbaseKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
};
const utilaPrivateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

describe("coinbase account provisioning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCreateCapturingNames(names: string[]) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          names.push(requestNameSchema.parse(JSON.parse(String(init.body))).name);

          return jsonResponse({ address: CREATED_ADDRESS }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });
  }

  it("creates a CDP account with a digest name that fits CDP constraints", async () => {
    const names: string[] = [];
    const fetchMock = mockCreateCapturingNames(names);

    const result = await provisionCoinbaseCdpAccount(
      createCoinbaseEnv({
        ENVIRONMENT: "production",
      }),
      {
        orgId: "org_abc",
        projectId: "proj_1",
      }
    );

    expect(result.address).toBe(CREATED_ADDRESS);
    expect(result.network).toBe("solana-devnet");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(names[0]).toMatch(/^sdp-[0-9a-f]{32}$/);
  });

  it("scopes the account identity by org, project, network, namespace, and wallet seed", async () => {
    const names: string[] = [];
    mockCreateCapturingNames(names);

    const base = { orgId: "org_abc", projectId: "proj_1" };
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), base);
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), base);
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), { ...base, orgId: "org_other" });
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), { ...base, projectId: "proj_2" });
    await provisionCoinbaseCdpAccount(createCoinbaseEnv({ COINBASE_CDP_NETWORK: "solana" }), base);
    await provisionCoinbaseCdpAccount(
      createCoinbaseEnv({ COINBASE_CDP_ACCOUNT_NAMESPACE: "staging" }),
      base
    );
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), { ...base, walletSeed: "seed-1" });
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), { ...base, walletSeed: "seed-2" });

    // Retries of the same identity are deterministic…
    expect(names[1]).toBe(names[0]);
    // …while every scope dimension yields a distinct account.
    const distinct = [names[0], ...names.slice(2)];
    expect(new Set(distinct).size).toBe(distinct.length);
    for (const name of names) {
      expect(name).toMatch(/^sdp-[0-9a-f]{32}$/);
    }
  });

  it("sends the caller's idempotency key as X-Idempotency-Key, and a fresh one without it", async () => {
    const headers: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input: string | URL | Request, init?: RequestInit) => {
        headers.push(new Headers(init?.headers).get("X-Idempotency-Key"));
        return jsonResponse({ address: CREATED_ADDRESS }, 200);
      }
    );

    const base = { orgId: "org_abc", projectId: "proj_1", walletSeed: "seed-1" };
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), { ...base, idempotencyKey: "req-1" });
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), { ...base, idempotencyKey: "req-1" });
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), base);

    expect(headers[0]).toBe("req-1");
    expect(headers[1]).toBe("req-1");
    expect(headers[2]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("does not derive the identity from truncatable tenant identifiers", async () => {
    const names: string[] = [];
    mockCreateCapturingNames(names);

    const longPrefix = `org_${"a".repeat(60)}`;
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), {
      orgId: `${longPrefix}x`,
      projectId: "proj_1",
    });
    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), {
      orgId: `${longPrefix}y`,
      projectId: "proj_1",
    });

    expect(names[0]).not.toBe(names[1]);
  });

  it("reuses the existing CDP account on already_exists when the caller opts in", async () => {
    let requestedName = "";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          requestedName = requestNameSchema.parse(JSON.parse(String(init.body))).name;
          return jsonResponse({ errorType: "already_exists" }, 409);
        }

        if (
          url.endsWith(
            `/platform/v2/solana/accounts/by-name/${encodeURIComponent(requestedName)}`
          ) &&
          init?.method === "GET"
        ) {
          return jsonResponse({ address: EXISTING_ADDRESS, name: requestedName }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    const result = await provisionCoinbaseCdpAccount(
      createCoinbaseEnv({
        COINBASE_CDP_ACCOUNT_NAMESPACE: "local",
      }),
      {
        orgId: "org_abc",
        projectId: "proj_1",
        reuseExisting: true,
      }
    );

    expect(result.address).toBe(EXISTING_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed on already_exists when the caller does not opt into reuse", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          return jsonResponse({ errorType: "already_exists" }, 409);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    await expect(
      provisionCoinbaseCdpAccount(createCoinbaseEnv(), {
        orgId: "org_abc",
        projectId: "proj_1",
        walletSeed: "seed-1",
      })
    ).rejects.toThrowError(/already exists and this operation does not reuse/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("binds CDP JWTs to the expected issuer, audience, and short expiries", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/platform/v2/solana/accounts") && init?.method === "POST") {
          return jsonResponse({ address: CREATED_ADDRESS }, 200);
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      });

    await provisionCoinbaseCdpAccount(createCoinbaseEnv(), {
      orgId: "org_abc",
      projectId: "proj_1",
    });

    const headers = new Headers(required(required(fetchMock.mock.calls[0])[1]).headers);
    const bearer = decodeJwtPayload(required(headers.get("authorization")).slice("Bearer ".length));
    expect(bearer).toMatchObject({
      iss: "cdp",
      aud: ["cdp_service"],
      sub: "test-api-key-id",
    });
    expect(Number(bearer.exp) - Number(bearer.iat)).toBe(120);

    // CDP documents iss/aud for the bearer token only; the wallet-auth token is
    // bound by its short expiry, jti, and request hash instead.
    const walletAuth = decodeJwtPayload(required(headers.get("x-wallet-auth")));
    expect(walletAuth.iss).toBeUndefined();
    expect(walletAuth.aud).toBeUndefined();
    expect(walletAuth.jti).toEqual(expect.any(String));
    expect(walletAuth.reqHash).toEqual(expect.any(String));
    expect(walletAuth.nbf).toBe(walletAuth.iat);
    expect(Number(walletAuth.exp) - Number(walletAuth.iat)).toBe(60);
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
      reuseExisting: true,
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
        reuseExisting: true,
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
        reuseExisting: true,
      })
    ).rejects.toThrowError(/could not be resolved by name/i);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("privy wallet provisioning", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("looks up an existing wallet by external ID without creating one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(privyWalletResponse());

    await expect(findTestPrivyWallet()).resolves.toEqual({
      walletId: "wallet-existing",
      address: EXISTING_ADDRESS,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });

  it("returns absent from external-ID lookup without creating a wallet", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(privyWalletNotFound());

    await expect(findTestPrivyWallet()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });

  it("rejects an invalid external-ID wallet without creating one", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(privyWalletResponse({ external_id: "sdp_connection_other" }));

    await expect(findTestPrivyWallet()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });

  it("creates a wallet with stable external and idempotency IDs", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        privyWalletResponse({ id: "wallet-created", address: CREATED_ADDRESS })
      );

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-created",
      address: CREATED_ADDRESS,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [createUrl, createRequest] = required(fetchMock.mock.calls[0]);
    expect(toUrlString(createUrl)).toBe("https://privy.test/v1/wallets");
    expect(required(createRequest).method).toBe("POST");
    expect(JSON.parse(String(required(createRequest).body))).toEqual({
      chain_type: "solana",
      external_id: "sdp_connection_123",
    });
    expect(new Headers(required(createRequest).headers).get("privy-idempotency-key")).toBe(
      "credential-456"
    );
  });

  it("reconciles by external ID after an ambiguous create outcome", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("connection reset"))
      .mockResolvedValueOnce(privyWalletResponse({ id: "wallet-reconciled" }));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-reconciled",
      address: EXISTING_ADDRESS,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it("reconciles the unique external ID when create reports it already exists", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "external_id already exists" }, 409))
      .mockResolvedValueOnce(privyWalletResponse({ id: "wallet-reconciled" }));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).resolves.toEqual({
      walletId: "wallet-reconciled",
      address: EXISTING_ADDRESS,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it("fails closed when a duplicate external ID remains unavailable to lookup", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ error: "external_id already exists" }, 409))
      .mockResolvedValueOnce(privyWalletNotFound());

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it("surfaces a deterministic conflict found during reconciliation", async () => {
    vi.spyOn(globalThis, "fetch")
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
  ] as const)("fails closed when create and its lookup return %s", async (_case, body, code) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body, 200));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({ code });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it("treats an incomplete create response as ambiguous and reconciles once", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: "wallet-created", address: CREATED_ADDRESS }, 200))
      .mockResolvedValueOnce(privyWalletNotFound());

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it("gives up on an unanswered stored-credential create and lookup as a network error", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("timed out", "TimeoutError")),
        milliseconds
      );
      return controller.signal;
    });
    // Privy never answers: only a request deadline settles the call.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) signal.addEventListener("abort", () => reject(signal.reason));
        })
    );

    const outcome = provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS).then(
      () => "resolved",
      (error) => error
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(required(required(init).signal).aborted).toBe(true);
    }
  });

  it("classifies a Provider 401 on create as an invalid credential, with no lookup", async () => {
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
      .mockResolvedValueOnce(jsonResponse({ error: "unknown" }, 500))
      .mockResolvedValueOnce(jsonResponse({ error: "invalid credentials" }, 401));

    await expect(provisionTestPrivyWallet(PRIVY_CREATE_OPTIONS)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it.each([
    ["looks up an existing wallet by ID", { walletId: "wallet-existing" }, "GET"],
    ["creates a wallet without an external ID", {}, "POST"],
  ] as const)("reads or creates a Managed wallet (%s)", async (_case, options, method) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ id: "wallet-existing", address: EXISTING_ADDRESS }, 200));

    await expect(provisionTestPrivyWallet(options)).resolves.toEqual({
      walletId: "wallet-existing",
      address: EXISTING_ADDRESS,
    });
    expect(required(required(fetchMock.mock.calls[0])[1]).method).toBe(method);
  });

  it.each([
    [401, "PROVIDER_NOT_CONFIGURED"],
    [400, "PROVIDER_NOT_CONFIGURED"],
    [503, "PROVIDER_NOT_CONFIGURED"],
  ] as const)("classifies a Managed create's HTTP %s failure as %s", async (status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "rejected" }, status));

    await expect(provisionTestPrivyWallet({})).rejects.toMatchObject({ code });
  });

  it.each([
    [401, "PROVIDER_CREDENTIAL_INVALID"],
    [400, "PROVIDER_NOT_CONFIGURED"],
    [503, "NETWORK_ERROR"],
  ] as const)(
    "classifies bounded credential HTTP %s create failures as %s",
    async (status, code) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "rejected" }, status));

      await expect(provisionTestPrivyWallet({ credentialRequest: true })).rejects.toMatchObject({
        code,
      });
    }
  );

  it("classifies a malformed bounded credential create response as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 200));

    await expect(provisionTestPrivyWallet({ credentialRequest: true })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("reports a malformed Managed create response as a failed creation", async () => {
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

  function provisionInSandbox(options: Parameters<typeof provisionUtilaWallet>[1]) {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      provisionUtilaWallet(createUtilaEnv(), options)
    );
  }

  it("normalizes resource-style vault IDs before creating wallets", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v2/vaults/vault_123/wallets") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            displayName: "Root Wallet",
            networks: ["networks/solana-devnet"],
          });

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

    const result = await provisionInSandbox({ displayName: "Root Wallet" });

    expect(result.walletId).toBe("wallet_abc");
    expect(result.address).toBe(CREATED_ADDRESS);
    expect(result.vaultId).toBe("vault_123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports only the upstream error code when wallet creation fails", async () => {
    const leakedToken = "eyJhbGciOiJSUzI1NiJ9.leaked-service-account-token";

    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v2/vaults/vault_123/wallets") && init?.method === "POST") {
          return jsonResponse(
            {
              error: {
                code: 403,
                status: "PERMISSION_DENIED",
                message: `authorization: Bearer ${leakedToken} is not permitted for vaults/vault_123`,
              },
            },
            403
          );
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      }
    );

    await expect(provisionInSandbox({})).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Utila CreateWallet failed (403): code=PERMISSION_DENIED",
    });
  });

  it("omits upstream detail entirely when the error body has no known code field", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);

        if (url.endsWith("/v2/vaults/vault_123/wallets") && init?.method === "POST") {
          return new Response("<html>authorization: Bearer leaked-token</html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          });
        }

        throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
      }
    );

    await expect(provisionInSandbox({})).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Utila CreateWallet failed (502): code=unavailable",
    });
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

    const authorization = required(
      new Headers(required(required(fetchMock.mock.calls[0])[1]).headers).get("authorization")
    );
    expect(decodeJwtPayload(authorization.slice("Bearer ".length))).toMatchObject({
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
    ...env,
    COINBASE_CDP_API_KEY_ID: "test-api-key-id",
    COINBASE_CDP_API_KEY_SECRET: keyMaterial.privateKeyPem,
    COINBASE_CDP_WALLET_SECRET: keyMaterial.privateKeyPkcs8Base64,
    ...overrides,
  };
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
  return { ...env, PRIVY_API_BASE_URL: "https://privy.test/v1", ...overrides };
}

function provisionTestPrivyWallet(options: Parameters<typeof provisionPrivyWallet>[1]) {
  return provisionPrivyWallet(createPrivyEnv(), options, PRIVY_AUTHENTICATION);
}

function findTestPrivyWallet() {
  return findPrivyWalletByExternalId(
    createPrivyEnv(),
    PRIVY_CREATE_OPTIONS.externalId,
    PRIVY_AUTHENTICATION
  );
}

function privyWalletResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({ ...PRIVY_WALLET, ...overrides }, 200);
}

function privyWalletNotFound(): Response {
  return jsonResponse({ error: "not found" }, 404);
}

function createParaEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    PARA_API_KEY: "test-para-api-key",
    PARA_API_BASE_URL: "https://api.getpara.com",
    ...overrides,
  };
}

function createUtilaEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    UTILA_SERVICE_ACCOUNT_EMAIL: "service-account@example.com",
    UTILA_SERVICE_ACCOUNT_PRIVATE_KEY: utilaPrivateKeyPem,
    UTILA_VAULT_ID: "vaults/vault_123",
    UTILA_API_BASE_URL: "https://api.utila.io",
    ...overrides,
  };
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
  return z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(Buffer.from(required(token.split(".")[1]), "base64url").toString()));
}
