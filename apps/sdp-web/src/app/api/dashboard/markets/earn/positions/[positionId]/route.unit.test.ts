import { beforeEach, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sdp-api", () => ({ proxyToSdpApi: upstream }));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  upstream.mockResolvedValue(Response.json({ data: { id: "position" } }));
});

it("forwards the exact position selector and movement floor through the shared auth boundary", async () => {
  const request = new Request(
    "https://dashboard.test/api/dashboard/markets/earn/positions/selector?afterMovementIds=movement-a%2Cmovement-b",
    { headers: { "x-sdp-project-id": "project" } }
  );
  expect(
    (await GET(request, { params: Promise.resolve({ positionId: "owner/position" }) })).status
  ).toBe(200);
  expect(upstream).toHaveBeenCalledExactlyOnceWith({
    request,
    path: "/v1/earn/positions/owner%2Fposition?afterMovementIds=movement-a%2Cmovement-b",
    traceSource: "route.dashboard.earn.core",
  });
});

it.each(["ownerAddress=other", "afterMovementIds=a&afterMovementIds=b"])(
  "rejects unsupported or repeated filters: %s",
  async (query) => {
    const response = await GET(
      new Request(`https://dashboard.test/api/dashboard/markets/earn/positions/position?${query}`),
      { params: Promise.resolve({ positionId: "position" }) }
    );
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  }
);
