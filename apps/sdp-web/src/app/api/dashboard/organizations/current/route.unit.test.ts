import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { expectDashboardNoStore } from "@/test/dashboard-response";
import { SANDBOX_PROJECT } from "@/test/projects";
import { setApiRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("next/headers", () => import("@/test/next-headers"));

import { GET } from "./route";

const ONBOARDING_PATH = "/v1/onboarding/status";
const ORGANIZATION_PATH = "/v1/organizations/org_test%2F1";
const ORGANIZATION = { id: "org_test/1", name: "Acme", settings: { alertEmails: false } };
const LINKED = { linked: true, organization: { id: "org_test/1" } };
const UPSTREAM_FAILURE = {
  error: { code: "SERVICE_UNAVAILABLE", message: "upstream unavailable" },
};

function pathOf(input: Parameters<typeof fetch>[0]): string {
  return new URL(input instanceof Request ? input.url : String(input)).pathname;
}

function stubSdpApi(answer: (path: string) => Response): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => answer(pathOf(input)));
}

function upstreamPaths(fetchMock: MockInstance<typeof fetch>): string[] {
  return fetchMock.mock.calls.map(([input]) => pathOf(input));
}

function readCurrentOrganization(): Promise<Response> {
  return GET(new Request("https://dashboard.example.com/api/dashboard/organizations/current"));
}

beforeEach(() => {
  vi.stubEnv("SDP_API_BASE_URL", "https://api.sdp.test");
  setApiRequest(SANDBOX_PROJECT.id);
  mocks.auth.mockResolvedValue({ userId: "user_test", orgId: "org_test" });
  vi.spyOn(sdpApi, "createOrgSdpApiClient").mockImplementation(async () =>
    sdpApi.createTokenSdpApiClient("test-session-token")
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/dashboard/organizations/current", () => {
  it("reads the onboarding status, then the organization it names, and answers with it", async () => {
    const fetchMock = stubSdpApi((path) =>
      Response.json({ data: path === ONBOARDING_PATH ? LINKED : ORGANIZATION })
    );

    const response = await readCurrentOrganization();

    expect(response.status).toBe(200);
    expectDashboardNoStore(response);
    expect(await response.json()).toEqual({ data: ORGANIZATION });
    expect(upstreamPaths(fetchMock)).toEqual([ONBOARDING_PATH, ORGANIZATION_PATH]);
  });

  it.each([[{ linked: false, organization: null }], [{ linked: true, organization: null }]])(
    "answers 404 without reading an organization while onboarding says %j",
    async (status) => {
      const fetchMock = stubSdpApi(() => Response.json({ data: status }));

      const response = await readCurrentOrganization();

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { message: "Organization is not linked yet" },
      });
      expect(upstreamPaths(fetchMock)).toEqual([ONBOARDING_PATH]);
    }
  );

  it.each([ONBOARDING_PATH, ORGANIZATION_PATH])(
    "passes sdp-api's refusal of %s through as it came",
    async (failingPath) => {
      stubSdpApi((path) =>
        path === failingPath
          ? Response.json(UPSTREAM_FAILURE, { status: 503 })
          : Response.json({ data: path === ONBOARDING_PATH ? LINKED : ORGANIZATION })
      );

      const response = await readCurrentOrganization();

      expect(response.status).toBe(503);
      expectDashboardNoStore(response);
      expect(await response.json()).toEqual(UPSTREAM_FAILURE);
    }
  );

  it.each([
    [{ userId: null, orgId: null }, 401, "Authentication required"],
    [{ userId: "user_test", orgId: null }, 403, "Active organization required"],
  ])("refuses a session %j with %i before calling sdp-api", async (session, status, message) => {
    mocks.auth.mockResolvedValue(session);
    const fetchMock = stubSdpApi(() => Response.json({ data: LINKED }));

    const response = await readCurrentOrganization();

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { message } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
