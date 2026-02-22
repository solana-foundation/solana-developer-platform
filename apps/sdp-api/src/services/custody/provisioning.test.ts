import { provisionCoinbaseCdpAccount } from "@/services/custody/provisioning";
import type { Env } from "@/types/env";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const CREATED_ADDRESS = "H3tV2gQpwbUqR8P78xzQ5x7A8n9kXQ2a7P93wHo3GQqk";
const EXISTING_ADDRESS = "8JpY4aQ6MdbkCHf8W3yxKSL3Ufd9x5x2rE3PV4b6X1Nh";

let keyMaterial: {
  privateKeyPem: string;
  privateKeyPkcs8Base64: string;
};

describe("provisionCoinbaseCdpAccount", () => {
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

function createCoinbaseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "development",
    COINBASE_CDP_API_KEY_ID: "test-api-key-id",
    COINBASE_CDP_API_KEY_SECRET: keyMaterial.privateKeyPem,
    COINBASE_CDP_WALLET_SECRET: keyMaterial.privateKeyPkcs8Base64,
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
