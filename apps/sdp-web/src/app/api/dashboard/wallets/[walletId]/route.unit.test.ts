import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { projectProviderAvailability } from "@/test/provider-availability";
import { resetRequestProject, setApiRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  proxyToSdpApi: vi.fn(),
  apiRequest: vi.fn(),
  requestMemberRole: vi.fn(),
  fetchProjectProviderAvailability: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/lib/provider-availability.server", () => ({
  fetchProjectProviderAvailability: mocks.fetchProjectProviderAvailability,
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  proxyToSdpApi: mocks.proxyToSdpApi,
  createSdpApiClient: vi.fn(async () => ({ request: mocks.apiRequest })),
  requestMemberRole: mocks.requestMemberRole,
}));

import { GET } from "./route";

const WALLET_FIELDS = {
  id: "cwlt_test_1",
  provider: "privy",
  isRuntimeExecutionAllowed: true,
  walletId: "wal_test_1",
  publicKey: "11111111111111111111111111111111",
  label: "Treasury",
  purpose: "transfer",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const MANAGED_WALLET = { ...WALLET_FIELDS, custodyConfigId: "cfg_test_1" };
const CONNECTION_WALLET = { ...WALLET_FIELDS, custodyConnectionId: "connection_one" };
const CONNECTION_PATH = "/internal/dashboard/custody/connections/connection_one";

function readWallet() {
  return GET(new Request("https://dashboard.test/api/dashboard/wallets/wal_test_1"), {
    params: Promise.resolve({ walletId: "wal_test_1" }),
  });
}

function connectionAnswer(status: number): Response {
  if (status !== 200) return new Response(null, { status });
  return Response.json({
    data: {
      connection: {
        id: "connection_one",
        provider: "privy",
        label: "Treasury connection",
        status: "active",
        completion: null,
        isDefault: true,
        canComplete: false,
        canReplaceCredentials: false,
        canCancel: false,
      },
    },
  });
}

function privyByokAvailability(offered: boolean) {
  return projectProviderAvailability({
    project: PRODUCTION_PROJECT,
    custody: offered ? [{ provider: "privy", modes: ["byok"] }] : [],
    compliance: [],
    ramps: [],
    earn: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRequestProject();
  setApiRequest(PRODUCTION_PROJECT.id);
  mocks.requestMemberRole.mockResolvedValue("admin");
});

describe("GET /api/dashboard/wallets/:walletId", () => {
  it("passes a refused wallet read through as sdp-api answered it", async () => {
    const refused = Response.json({ error: { message: "Wallet not found" } }, { status: 404 });
    mocks.proxyToSdpApi.mockResolvedValue(refused);

    expect(await readWallet()).toBe(refused);
    expect(mocks.requestMemberRole).not.toHaveBeenCalled();
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it("answers a Managed wallet's record with no connection", async () => {
    mocks.proxyToSdpApi.mockResolvedValue(Response.json({ data: { wallet: MANAGED_WALLET } }));

    const response = await readWallet();

    expect(mocks.proxyToSdpApi).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/v1/wallets/wal_test_1?includeBalance=false" })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { wallet: MANAGED_WALLET, connection: null } });
  });

  it("names a member's connection by its id without looking the connection up", async () => {
    mocks.requestMemberRole.mockResolvedValue("member");
    mocks.proxyToSdpApi.mockResolvedValue(Response.json({ data: { wallet: CONNECTION_WALLET } }));

    const response = await readWallet();

    expect(await response.json()).toEqual({
      data: { wallet: CONNECTION_WALLET, connection: { label: "connec..._one", href: null } },
    });
    expect(mocks.apiRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "links the connection where the Project offers its provider",
      200,
      true,
      {
        label: "Treasury connection",
        href: `/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy/connections/connection_one`,
      },
    ],
    [
      "leaves the connection unlinked where the Project does not offer its provider",
      200,
      false,
      { label: "Treasury connection", href: null },
    ],
    ["names a refused connection by its id", 403, true, { label: "connec..._one", href: null }],
    ["names a missing connection by its id", 404, true, { label: "connec..._one", href: null }],
  ])("for an admin, %s", async (_case, lookupStatus, offered, connection) => {
    mocks.proxyToSdpApi.mockResolvedValue(Response.json({ data: { wallet: CONNECTION_WALLET } }));
    mocks.apiRequest.mockImplementation(async (path: string) =>
      path === CONNECTION_PATH
        ? connectionAnswer(lookupStatus)
        : new Response(null, { status: 500 })
    );
    mocks.fetchProjectProviderAvailability.mockResolvedValue(privyByokAvailability(offered));

    const response = await readWallet();

    expect(await response.json()).toEqual({ data: { wallet: CONNECTION_WALLET, connection } });
  });

  it("answers a generic failure when the connection lookup fails", async () => {
    mocks.proxyToSdpApi.mockResolvedValue(Response.json({ data: { wallet: CONNECTION_WALLET } }));
    mocks.apiRequest.mockResolvedValue(connectionAnswer(503));

    const response = await readWallet();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: "Wallet request failed" } });
  });

  it("refuses a record that names both custody owners", async () => {
    mocks.proxyToSdpApi.mockResolvedValue(
      Response.json({
        data: { wallet: { ...MANAGED_WALLET, custodyConnectionId: "connection_one" } },
      })
    );

    const response = await readWallet();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: "Invalid wallet response" } });
    expect(mocks.requestMemberRole).not.toHaveBeenCalled();
  });
});
