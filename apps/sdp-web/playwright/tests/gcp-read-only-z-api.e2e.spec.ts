import { expect, test } from "@playwright/test";
import { getE2EEnv } from "../env";
import { createLocalApiClient, type LocalApiClient } from "../support/local-api-client";
import { provisionWithAdminSession } from "../support/local-dashboard-bootstrap";

interface GoldenEndpoint {
  domain: string;
  path: string;
  scope: "org" | "project";
  query?: Record<string, string>;
}

const FIRST_PAGE = { page: "1", pageSize: "20" };

const GOLDEN_ENDPOINTS: GoldenEndpoint[] = [
  { domain: "projects", path: "/v1/projects", scope: "org" },
  { domain: "members", path: "/v1/members", scope: "project" },
  { domain: "notifications", path: "/v1/notifications/unread-count", scope: "org" },
  { domain: "api-keys", path: "/v1/api-keys", scope: "project" },
  { domain: "onboarding", path: "/v1/onboarding/status", scope: "org" },
  { domain: "counterparties", path: "/v1/counterparties", scope: "project", query: FIRST_PAGE },
  { domain: "issuance-tokens", path: "/v1/issuance/tokens", scope: "project", query: FIRST_PAGE },
  { domain: "issuance-templates", path: "/v1/issuance/templates", scope: "project" },
  { domain: "wallets", path: "/v1/wallets", scope: "project", query: { view: "summary" } },
  {
    domain: "payments-transfers",
    path: "/v1/payments/transfers",
    scope: "project",
    query: FIRST_PAGE,
  },
  { domain: "payments-recurring", path: "/v1/payments/recurring-payments", scope: "project" },
  { domain: "policies", path: "/v1/policies", scope: "project" },
  { domain: "earn-strategies", path: "/v1/earn/strategies", scope: "project" },
];

test.describe("GCP dev API golden endpoints", () => {
  let orgApi: LocalApiClient;
  let projectApi: LocalApiClient;

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
    });
  });

  test.afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  });

  for (const endpoint of GOLDEN_ENDPOINTS) {
    test(`${endpoint.domain} responds to an authed read`, async () => {
      const api = endpoint.scope === "project" ? projectApi : orgApi;
      const path = endpoint.query
        ? `${endpoint.path}?${new URLSearchParams(endpoint.query)}`
        : endpoint.path;
      await expect(api.get(path)).resolves.toBeDefined();
    });
  }
});
