import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../env";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import { provisionWithAdminSession } from "../support/local-dashboard-bootstrap";

interface GoldenEndpoint {
  domain: string;
  path: string;
  scope: "org" | "project";
}

const GOLDEN_ENDPOINTS: GoldenEndpoint[] = [
  { domain: "projects", path: "/v1/projects", scope: "org" },
  { domain: "members", path: "/v1/members", scope: "org" },
  { domain: "notifications", path: "/v1/notifications/unread-count", scope: "org" },
  { domain: "api-keys", path: "/v1/api-keys", scope: "org" },
  { domain: "onboarding", path: "/v1/onboarding/status", scope: "org" },
  { domain: "counterparties", path: "/v1/counterparties?page=1&pageSize=1", scope: "project" },
  { domain: "issuance-tokens", path: "/v1/issuance/tokens?page=1&pageSize=20", scope: "project" },
  { domain: "issuance-templates", path: "/v1/issuance/templates", scope: "project" },
  { domain: "wallets", path: "/v1/wallets?view=summary", scope: "project" },
  {
    domain: "payments-transfers",
    path: "/v1/payments/transfers?page=1&pageSize=1",
    scope: "project",
  },
  { domain: "payments-recurring", path: "/v1/payments/recurring-payments", scope: "project" },
  { domain: "policies", path: "/v1/policies", scope: "project" },
  { domain: "earn-strategies", path: "/v1/earn/strategies", scope: "project" },
];

test.describe("GCP dev API golden endpoints", () => {
  let orgApi: LocalApiClient;
  let projectApi: LocalApiClient;
  let organizationPath: string;

  test.beforeAll(async ({ browser }) => {
    const env = getE2EEnv();
    if (!env.useExternalApi) {
      throw new Error("GCP smoke must run in explicit external mode");
    }

    await provisionWithAdminSession(browser, async (session) => {
      expect(session.identity.organizationId).toBe(env.clerkOrgId);
      const bearerToken = await session.getBearerToken();
      orgApi = createLocalApiClient(env.sdpApiBaseUrl, bearerToken);
      projectApi = createLocalApiClient(env.sdpApiBaseUrl, bearerToken, env.expectedProjectId);
      organizationPath = `/v1/organizations/${session.identity.organizationId}`;
    });
  });

  for (const endpoint of GOLDEN_ENDPOINTS) {
    test(`${endpoint.domain} responds to an authed read`, async () => {
      const api = endpoint.scope === "project" ? projectApi : orgApi;
      await expect(api.get(endpoint.path)).resolves.toBeDefined();
    });
  }

  test("organizations responds to an authed read", async () => {
    await expect(orgApi.get(organizationPath)).resolves.toBeDefined();
  });
});
