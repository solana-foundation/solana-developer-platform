import { generateKeyPairSync } from "node:crypto";
import { createDfnsApiClient, createIbmHavenApiClient, type DfnsEnv } from "@sdp/custody/dfns";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const API_BASE_URL = "https://api.dfns.test";
const ATTACKER_ORIGIN = "https://attacker.example.test";
const AUTH_TOKEN = "dfns-auth-token-value";
const CREDENTIAL_ID = "cred_configured_123";
const WALLET_ID = "wa_created_1";

let privateKeyPem: string;

beforeAll(() => {
  privateKeyPem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
});

describe("dfns client redirects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows a same-origin redirect and returns the redirected resource", async () => {
    const fetchMock = mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets` && init?.method === "POST") {
        return redirectResponse(302, "/wallets/wa_created_1");
      }

      if (url === `${API_BASE_URL}/wallets/wa_created_1` && init?.method === "GET") {
        return jsonResponse({ id: WALLET_ID, network: "SolanaDevnet" }, 200);
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());
    const wallet = await client.wallets.createWallet({ body: { network: "SolanaDevnet" } });

    expect(wallet.id).toBe(WALLET_ID);

    const followCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        toUrlString(input) === `${API_BASE_URL}/wallets/wa_created_1` && init?.method === "GET"
    );
    expect(new Headers(followCall?.[1]?.headers).get("authorization")).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it("refuses a cross-origin redirect instead of forwarding the bearer token", async () => {
    const fetchMock = mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets` && init?.method === "POST") {
        return redirectResponse(302, `${ATTACKER_ORIGIN}/steal`);
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());

    await expect(
      client.wallets.createWallet({ body: { network: "SolanaDevnet" } })
    ).rejects.toThrow(/cross-origin redirect/);

    const attackerCalls = fetchMock.mock.calls.filter(([input]) =>
      hasOrigin(input, ATTACKER_ORIGIN)
    );
    expect(attackerCalls).toHaveLength(0);
  });

  it("refuses a protocol-relative redirect that swaps the host", async () => {
    mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets` && init?.method === "POST") {
        return redirectResponse(307, "//attacker.example.test/steal");
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());

    await expect(
      client.wallets.createWallet({ body: { network: "SolanaDevnet" } })
    ).rejects.toThrow(/cross-origin redirect/);
  });

  it("refuses an unparsable redirect target", async () => {
    mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets` && init?.method === "POST") {
        return redirectResponse(302, "http://[");
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());

    await expect(
      client.wallets.createWallet({ body: { network: "SolanaDevnet" } })
    ).rejects.toThrow(/redirectOrigin=invalid/);
  });

  it("applies the same-origin rule to the IBM Haven white-label client", async () => {
    const fetchMock = mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets` && init?.method === "POST") {
        return redirectResponse(302, `${ATTACKER_ORIGIN}/steal`);
      }

      return null;
    });

    const client = await createIbmHavenApiClient({
      IBM_HAVEN_AUTH_TOKEN: AUTH_TOKEN,
      IBM_HAVEN_CREDENTIAL_ID: CREDENTIAL_ID,
      IBM_HAVEN_PRIVATE_KEY: privateKeyPem,
      IBM_HAVEN_API_BASE_URL: API_BASE_URL,
    });

    await expect(
      client.wallets.createWallet({ body: { network: "SolanaDevnet" } })
    ).rejects.toThrow(/IBM Digital Asset Haven API returned a cross-origin redirect/);

    const attackerCalls = fetchMock.mock.calls.filter(([input]) =>
      hasOrigin(input, ATTACKER_ORIGIN)
    );
    expect(attackerCalls).toHaveLength(0);
  });

  it("does not follow redirects for read requests", async () => {
    mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets/wa_1` && init?.method === "GET") {
        return redirectResponse(302, "/wallets/wa_2");
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());

    await expect(client.wallets.getWallet({ walletId: "wa_1" })).rejects.toThrow(
      /unsupported redirect/
    );
  });
});

describe("dfns client error redaction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports only the upstream error code for failed requests", async () => {
    mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets/wa_1` && init?.method === "GET") {
        return jsonResponse(
          {
            error: {
              code: "InvalidCredential",
              message: `credential ${CREDENTIAL_ID} rejected for Bearer ${AUTH_TOKEN}`,
            },
          },
          403
        );
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());
    const error = await captureError(() => client.wallets.getWallet({ walletId: "wa_1" }));

    expect(error.message).toContain("status=403");
    expect(error.message).toContain("code=InvalidCredential");
    expect(error.message).not.toContain(AUTH_TOKEN);
    expect(error.message).not.toContain(CREDENTIAL_ID);
    expect(error.message).not.toContain("rejected for");
  });

  it("falls back to an unavailable code when the error body has no known code field", async () => {
    mockDfnsFetch((url, init) => {
      if (url === `${API_BASE_URL}/wallets/wa_1` && init?.method === "GET") {
        return jsonResponse({ message: `leaked ${AUTH_TOKEN}` }, 500);
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());
    const error = await captureError(() => client.wallets.getWallet({ walletId: "wa_1" }));

    expect(error.message).toContain("code=unavailable");
    expect(error.message).not.toContain(AUTH_TOKEN);
  });

  it("never echoes non-JSON upstream bodies", async () => {
    mockDfnsFetch((url, init) => {
      if (url.startsWith(`${API_BASE_URL}/wallets`) && init?.method === "GET") {
        return new Response(`<html>authorization: Bearer ${AUTH_TOKEN}</html>`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      return null;
    });

    const client = await createDfnsApiClient(createDfnsEnv());
    const error = await captureError(() => client.wallets.listWallets());

    expect(error.message).toContain("non-JSON response");
    expect(error.message).toContain("contentType=text/html");
    expect(error.message).not.toContain(AUTH_TOKEN);
    expect(error.message).not.toContain("<html>");
  });

  it("does not disclose credential ids when user action signing is rejected", async () => {
    const otherCredentialId = "cred_allowed_other_456";

    mockDfnsFetch(
      (url, init) => {
        if (url === `${API_BASE_URL}/wallets` && init?.method === "POST") {
          return jsonResponse({ id: WALLET_ID }, 200);
        }

        return null;
      },
      { allowedCredentialIds: [otherCredentialId] }
    );

    const client = await createDfnsApiClient(createDfnsEnv());
    const error = await captureError(() =>
      client.wallets.createWallet({ body: { network: "SolanaDevnet" } })
    );

    expect(error.message).toContain("1 credential(s) allowed");
    expect(error.message).not.toContain(CREDENTIAL_ID);
    expect(error.message).not.toContain(otherCredentialId);
  });
});

function createDfnsEnv(overrides: Partial<DfnsEnv> = {}): DfnsEnv {
  return {
    DFNS_AUTH_TOKEN: AUTH_TOKEN,
    DFNS_CREDENTIAL_ID: CREDENTIAL_ID,
    DFNS_PRIVATE_KEY: privateKeyPem,
    DFNS_API_BASE_URL: API_BASE_URL,
    ...overrides,
  };
}

/**
 * Serves the user-action challenge handshake so tests only describe the call
 * under test; unhandled requests fail loudly.
 */
function mockDfnsFetch(
  handler: (url: string, init?: RequestInit) => Response | null,
  options: { allowedCredentialIds?: string[] } = {}
) {
  const allowedCredentialIds = options.allowedCredentialIds ?? [CREDENTIAL_ID];

  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = toUrlString(input);

      if (url === `${API_BASE_URL}/auth/action/init`) {
        return jsonResponse(
          {
            challenge: "challenge-value",
            challengeIdentifier: "challenge-id",
            allowCredentials: { key: allowedCredentialIds.map((id) => ({ id })) },
          },
          200
        );
      }

      if (url === `${API_BASE_URL}/auth/action`) {
        return jsonResponse({ userAction: "user-action-token" }, 200);
      }

      const response = handler(url, init);
      if (response) {
        return response;
      }

      throw new Error(`Unexpected fetch call: ${init?.method ?? "GET"} ${url}`);
    });
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

/**
 * Exact origin match. A `startsWith` prefix test would also accept
 * `attacker.example.test.somewhere-else`, so it cannot prove a request never
 * reached the attacker — and it is the comparison the client itself makes.
 */
function hasOrigin(input: string | URL | Request, origin: string): boolean {
  return new URL(toUrlString(input)).origin === origin;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redirectResponse(status: number, location: string): Response {
  return new Response("", { status, headers: { location } });
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }

  throw new Error("Expected the call to reject");
}
