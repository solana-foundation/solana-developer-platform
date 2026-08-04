import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TokenApiResponse } from "../helpers/api-types";
import {
  cleanupIntegrationSuite,
  initIntegrationSuite,
  RUN_INTEGRATION_TESTS,
  requestWithApiKey,
  resetIntegrationState,
  SOLANA_CONFIGURED,
} from "../helpers/integration";
import { createStablecoin, TEST_WALLETS } from "../helpers/issuance";

describe.skipIf(!SOLANA_CONFIGURED || !RUN_INTEGRATION_TESTS)("Issuance CRUD Endpoints", () => {
  let apiKeyHash: string;
  const request = requestWithApiKey();

  beforeAll(async () => {
    const init = await initIntegrationSuite();
    apiKeyHash = init.apiKeyHash;
  });

  afterAll(async () => {
    await cleanupIntegrationSuite();
  });

  beforeEach(async () => {
    await resetIntegrationState(apiKeyHash);
  });

  it("lists templates and gets a template", async () => {
    const templatesRes = await request("/v1/issuance/templates");
    expect(templatesRes.status).toBe(200);
    const templatesBody = (await templatesRes.json()) as {
      data: { templates: Array<{ id: string }> };
    };
    expect(templatesBody.data.templates.length).toBeGreaterThan(0);
    expect(templatesBody.data.templates.some((template) => template.id === "stablecoin")).toBe(
      true
    );

    const templateRes = await request("/v1/issuance/templates/stablecoin");
    expect(templateRes.status).toBe(200);
    const templateBody = (await templateRes.json()) as {
      data: { template: { id: string } };
    };
    expect(templateBody.data.template.id).toBe("stablecoin");
  });

  it("creates, lists, gets, and updates a token", async () => {
    const tokenId = await createStablecoin(request, "Issuance CRUD Coverage", "ISCRUD");

    const listTokensRes = await request("/v1/issuance/tokens?page=1&pageSize=20");
    expect(listTokensRes.status).toBe(200);
    const listTokensBody = (await listTokensRes.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(listTokensBody.meta.total).toBeGreaterThanOrEqual(1);
    expect(listTokensBody.data.some((token) => token.id === tokenId)).toBe(true);

    const getTokenRes = await request(`/v1/issuance/tokens/${tokenId}`);
    expect(getTokenRes.status).toBe(200);
    const getTokenBody = (await getTokenRes.json()) as TokenApiResponse;
    expect(getTokenBody.data.token.id).toBe(tokenId);

    const patchTokenRes = await request(`/v1/issuance/tokens/${tokenId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "Updated by integration test",
      }),
    });
    expect(patchTokenRes.status).toBe(200);
    const patchedTokenBody = (await patchTokenRes.json()) as TokenApiResponse;
    expect(patchedTokenBody.data.token.description).toBe("Updated by integration test");
  });

  it("adds, lists, and removes an allowlist entry", async () => {
    const tokenId = await createStablecoin(request, "Issuance Allowlist Coverage", "ISALLOW");

    const emptyAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=10`
    );
    expect(emptyAllowlistRes.status).toBe(200);
    const emptyAllowlistBody = (await emptyAllowlistRes.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(emptyAllowlistBody.meta.total).toBe(0);

    const addAllowlistRes = await request(`/v1/issuance/tokens/${tokenId}/allowlist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        address: TEST_WALLETS.wallet1,
        label: "Integration Wallet",
      }),
    });
    expect(addAllowlistRes.status).toBe(201);
    const addAllowlistBody = (await addAllowlistRes.json()) as {
      data: { entry: { id: string; address: string } };
    };
    expect(addAllowlistBody.data.entry.address).toBe(TEST_WALLETS.wallet1);

    const listAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=10`
    );
    expect(listAllowlistRes.status).toBe(200);
    const listAllowlistBody = (await listAllowlistRes.json()) as {
      data: Array<{ id: string; address: string }>;
      meta: { total: number };
    };
    expect(listAllowlistBody.meta.total).toBe(1);
    expect(listAllowlistBody.data[0]?.address).toBe(TEST_WALLETS.wallet1);

    const removeAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist/${addAllowlistBody.data.entry.id}`,
      {
        method: "DELETE",
      }
    );
    expect(removeAllowlistRes.status).toBe(204);

    const afterDeleteAllowlistRes = await request(
      `/v1/issuance/tokens/${tokenId}/allowlist?page=1&pageSize=10`
    );
    expect(afterDeleteAllowlistRes.status).toBe(200);
    const afterDeleteAllowlistBody = (await afterDeleteAllowlistRes.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number };
    };
    expect(afterDeleteAllowlistBody.meta.total).toBe(0);
  });
});
