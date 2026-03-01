import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ORG = {
  id: "org_compliance_test",
  name: "Compliance Test Org",
  slug: "compliance-test-org",
};
const TEST_USER = {
  id: "usr_compliance_test",
  email: "compliance-test@example.com",
};
const TEST_API_KEY = {
  id: "key_compliance_test",
  // biome-ignore lint/nursery/noSecrets: Test fixture, not a real secret.
  raw: "sk_test_compliance12345678901234567890",
  prefix: "sk_test_com",
};
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: null,
  role: "api_developer",
  permissions: ["payments:read"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let originalRangeApiKey: string | undefined;
let originalRangeBaseUrl: string | undefined;
let originalEllipticApiKey: string | undefined;
let originalEllipticApiSecret: string | undefined;
let originalEllipticBaseUrl: string | undefined;
let originalEllipticApiToken: string | undefined;
let originalTrmApiKey: string | undefined;
let originalTrmBaseUrl: string | undefined;
let originalChainalysisApiKey: string | undefined;
let originalChainalysisBaseUrl: string | undefined;

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
    ).bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "free", "active"),
    env.DB.prepare(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)"
    ).bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    env.DB.prepare(
      `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      TEST_API_KEY.id,
      TEST_ORG.id,
      null,
      TEST_USER.id,
      "Compliance Test Key",
      TEST_API_KEY.prefix,
      keyHash,
      "api_developer",
      JSON.stringify(["payments:read"]),
      "sandbox",
      "active"
    ),
  ]);
}

describe("Compliance routes", () => {
  beforeEach(async () => {
    originalRangeApiKey = env.RANGE_API_KEY;
    originalRangeBaseUrl = env.RANGE_API_BASE_URL;
    originalEllipticApiKey = env.ELLIPTIC_API_KEY;
    originalEllipticApiSecret = env.ELLIPTIC_API_SECRET;
    originalEllipticBaseUrl = env.ELLIPTIC_API_BASE_URL;
    originalEllipticApiToken = env.ELLIPTIC_API_TOKEN;
    originalTrmApiKey = env.TRM_API_KEY;
    originalTrmBaseUrl = env.TRM_API_BASE_URL;
    originalChainalysisApiKey = env.CHAINALYSIS_API_KEY;
    originalChainalysisBaseUrl = env.CHAINALYSIS_API_BASE_URL;

    env.RANGE_API_KEY = undefined;
    env.RANGE_API_BASE_URL = undefined;
    env.ELLIPTIC_API_KEY = undefined;
    env.ELLIPTIC_API_SECRET = undefined;
    env.ELLIPTIC_API_BASE_URL = undefined;
    env.ELLIPTIC_API_TOKEN = undefined;
    env.TRM_API_KEY = undefined;
    env.TRM_API_BASE_URL = undefined;
    env.CHAINALYSIS_API_KEY = undefined;
    env.CHAINALYSIS_API_BASE_URL = undefined;

    await seedTestDatabase(env);
    await seedAuth();
  });

  afterEach(async () => {
    env.RANGE_API_KEY = originalRangeApiKey;
    env.RANGE_API_BASE_URL = originalRangeBaseUrl;
    env.ELLIPTIC_API_KEY = originalEllipticApiKey;
    env.ELLIPTIC_API_SECRET = originalEllipticApiSecret;
    env.ELLIPTIC_API_BASE_URL = originalEllipticBaseUrl;
    env.ELLIPTIC_API_TOKEN = originalEllipticApiToken;
    env.TRM_API_KEY = originalTrmApiKey;
    env.TRM_API_BASE_URL = originalTrmBaseUrl;
    env.CHAINALYSIS_API_KEY = originalChainalysisApiKey;
    env.CHAINALYSIS_API_BASE_URL = originalChainalysisBaseUrl;

    vi.restoreAllMocks();
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("returns all provider results with unavailable defaults", async () => {
    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet1,
          network: "solana",
          intent: "transfer_destination",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        screening: {
          providers: Array<{
            provider: string;
            status: string;
            riskScore: number | null;
          }>;
        };
      };
    };

    expect(body.data.screening.providers).toHaveLength(4);

    const range = body.data.screening.providers.find((entry) => entry.provider === "range");
    const elliptic = body.data.screening.providers.find((entry) => entry.provider === "elliptic");
    const trm = body.data.screening.providers.find((entry) => entry.provider === "trm");
    const chainalysis = body.data.screening.providers.find(
      (entry) => entry.provider === "chainalysis"
    );

    expect(range?.status).toBe("unavailable");
    expect(range?.riskScore).toBeNull();
    expect(elliptic?.status).toBe("unavailable");
    expect(elliptic?.riskScore).toBeNull();
    expect(trm?.status).toBe("unavailable");
    expect(trm?.riskScore).toBeNull();
    expect(chainalysis?.status).toBe("unavailable");
    expect(chainalysis?.riskScore).toBeNull();
  });

  it("returns a Range risk score when Range API is configured", async () => {
    env.RANGE_API_KEY = "range_test_api_key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          riskScore: 7,
          riskLevel: "High risk",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    );

    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet2,
          network: "solana",
          intent: "wallet_address_addition",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        screening: {
          providers: Array<{
            provider: string;
            status: string;
            riskScore: number | null;
            riskLevel?: string;
          }>;
        };
      };
    };

    const range = body.data.screening.providers.find((entry) => entry.provider === "range");
    expect(range?.status).toBe("ok");
    expect(range?.riskScore).toBe(7);
    expect(range?.riskLevel).toBe("High risk");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.range.org/v1/risk/address");
    expect(String(url)).toContain("network=solana");
    expect(String(url)).toContain(`address=${TEST_SOLANA_ADDRESSES.wallet2}`);
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer range_test_api_key",
    });
  });

  it("returns an Elliptic risk score when Elliptic API is configured", async () => {
    env.ELLIPTIC_API_KEY = "elliptic_test_api_key";
    // biome-ignore lint/nursery/noSecrets: Test fixture, not a real secret.
    env.ELLIPTIC_API_SECRET = "Ynl0ZXNlY3JldA==";
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          analysis: {
            risk_score: 42,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    );

    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet2,
          network: "solana",
          intent: "wallet_address_addition",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        screening: {
          providers: Array<{
            provider: string;
            status: string;
            riskScore: number | null;
          }>;
        };
      };
    };

    const elliptic = body.data.screening.providers.find((entry) => entry.provider === "elliptic");
    expect(elliptic?.status).toBe("ok");
    expect(elliptic?.riskScore).toBe(42);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://aml-api.elliptic.co/v2/wallet/synchronous");
    expect((init as RequestInit | undefined)?.method).toBe("POST");

    const headers = (init as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers).toMatchObject({
      "Content-Type": "application/json",
      "x-access-key": "elliptic_test_api_key",
      "x-access-timestamp": "1700000000000",
    });
    expect(typeof headers?.["x-access-sign"]).toBe("string");
    expect(headers?.["x-access-sign"].length).toBeGreaterThan(0);

    nowSpy.mockRestore();
  });

  it("returns an Elliptic risk score when Elliptic bearer token is configured", async () => {
    env.ELLIPTIC_API_TOKEN = "elliptic_access_token";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          risk_score: 9,
          risk_level: "High",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    );

    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet1,
          network: "solana",
          intent: "transfer_destination",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        screening: {
          providers: Array<{
            provider: string;
            status: string;
            riskScore: number | null;
            riskLevel?: string;
          }>;
        };
      };
    };

    const elliptic = body.data.screening.providers.find((entry) => entry.provider === "elliptic");
    expect(elliptic?.status).toBe("ok");
    expect(elliptic?.riskScore).toBe(9);
    expect(elliptic?.riskLevel).toBe("High");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://aml-api.elliptic.co/v2/wallet/synchronous");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer elliptic_access_token",
      "Content-Type": "application/json",
    });
  });

  it("returns a TRM risk score when TRM API is configured", async () => {
    env.TRM_API_KEY = "trm_test_api_key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            addressHighestRiskScoreLevel: 10,
            addressHighestRiskScoreLevelLabel: "High",
          },
        ]),
        {
          status: 201,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    );

    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet2,
          network: "solana",
          intent: "transfer_destination",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        screening: {
          providers: Array<{
            provider: string;
            status: string;
            riskScore: number | null;
            riskLevel?: string;
          }>;
        };
      };
    };

    const trm = body.data.screening.providers.find((entry) => entry.provider === "trm");
    expect(trm?.status).toBe("ok");
    expect(trm?.riskScore).toBe(10);
    expect(trm?.riskLevel).toBe("High");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.trmlabs.com/public/v2/screening/addresses");
    expect((init as RequestInit | undefined)?.method).toBe("POST");
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa("trm_test_api_key:trm_test_api_key")}`,
    });
    expect((init as RequestInit | undefined)?.body).toBe(
      JSON.stringify([
        {
          address: TEST_SOLANA_ADDRESSES.wallet2,
          chain: "solana",
        },
      ])
    );
  });

  it("returns a Chainalysis risk assessment when Chainalysis API is configured", async () => {
    env.CHAINALYSIS_API_KEY = "chainalysis_test_api_key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet1,
          risk: "Medium",
          status: "COMPLETE",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        }
      )
    );

    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: TEST_SOLANA_ADDRESSES.wallet1,
          network: "solana",
          intent: "transfer_destination",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        screening: {
          providers: Array<{
            provider: string;
            status: string;
            riskScore: number | null;
            riskLevel?: string;
          }>;
        };
      };
    };

    const chainalysis = body.data.screening.providers.find(
      (entry) => entry.provider === "chainalysis"
    );
    expect(chainalysis?.status).toBe("ok");
    expect(chainalysis?.riskScore).toBeNull();
    expect(chainalysis?.riskLevel).toBe("Medium");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      `https://api.chainalysis.com/api/risk/v2/entities/${TEST_SOLANA_ADDRESSES.wallet1}`
    );
    expect((init as RequestInit | undefined)?.method).toBe("GET");
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Token: "chainalysis_test_api_key",
    });
  });

  it("returns 400 for invalid Solana address", async () => {
    const res = await app.request(
      "/v1/compliance/address-screenings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          address: "invalid-address",
          network: "solana",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toBe("Invalid Solana address");
  });
});
